"""Text-only action and object evidence for ranking fragments inside a scope."""
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
import math
import re
import unicodedata

import numpy as np

from model import similarity, sparse_address


# General Chinese event expressions supplement the existing action glosses.
# Each entry supplies linguistic evidence, not an action ID or a journal result.
ADDITIONS = {
    0:"张开 打开来", 1:"合起来 收合 关起来", 2:"开机 通电 开动 开灯 点着 着亮 开始播放 播放 发亮 送电",
    3:"停机 断电 灭掉 关机 停掉 中止 停止播放", 4:"加快 调快 加速 快一些 快一点 加大 调强 调响 往上调",
    5:"放慢 调慢 减速 慢一些 慢一点 调弱 调轻 放缓 往下调",
    6:"平展 展开来 张开 撑开 伸展 张平", 7:"收拢 合起来 折起来 叠起来 合起来收好",
    8:"旋牢 拧牢 拧上 扭牢", 9:"松一松 扭松 旋下来", 10:"系牢 绑紧 扎好 系好 打结 夹牢 固定好 拉紧",
    11:"解结 解掉 松动 放开绑带 解开来 松下来", 14:"收入 放进去 收进去 入盒 填进",
    15:"拿出来 取出来 抽出来 拿下来", 16:"搁回 送回 归还 放回原处", 17:"挂起来 吊起 悬到 吊起来 系上",
    18:"提升 上升 向上移 往上升 往上移动 抬起来 升起来 举起", 19:"下降 向下移 往下降 往下移动 降下来 放下来",
    20:"贴好 贴牢 粘好 粘牢 贴在 贴到", 21:"撕下来 撕掉 剥下 揭下来",
    22:"罩起来 盖起来 加盖 合上盖", 23:"摘下来 拿下 卸掉",
    28:"洗掉 洗净 洗清 冲干净", 29:"干燥 抹净 拭净 拭干", 30:"收成一卷 绕成卷 盘成圈",
    34:"登记下来 填写 抄下", 35:"全倒出来 排干 全倒掉 清空", 40:"数一数 数一下 点清",
    43:"称量 称重 过秤 过一下秤 称出 秤一下", 46:"朝上 向上放 朝天 正面向上 正面朝上 翻到正面",
    47:"朝下 向下放 贴着桌面 正面向下 正面朝下 翻到背面", 48:"顺时针 顺着时针 沿钟表指针",
    49:"逆时针 逆着时针 反时针 指针相反 指针的反方向 指针反方向",
    50:"装满 填满 添满 补满 注满 灌满 补到满", 51:"显示 可见 出现在 显露",
    52:"隐藏 不可见 隐去 隐藏起来 不再显示 消失",
}
RELATED = ((0,2),(1,3,22),(4,18),(5,19),(8,10),(9,11),(14,24),(15,23,25),(16,17),(6,0))
OPPOSED = ((0,1),(2,3),(4,5),(18,19),(4,19),(5,18),(6,7),(6,30),(8,9),(8,11),(10,9),(10,11),
           (12,13),(14,15),(16,15),(17,23),(20,21),(22,23),(24,25),(31,32),(35,50),(46,47),(48,49),(51,52))
ATTRIBUTES = (
    ("左","右"),("前","后"),("上层","下层","中层"),("内侧","外侧"),("东","西","南","北"),
    ("红","绿","蓝","黄","黑","白","紫","棕","灰","橙"),("圆","方","三角"),
    ("木","铁","铜","铝","竹","塑料","玻璃"),("一号","二号","三号","四号"),
)
NORMAL = (("左手边|左边|左侧","左"),("右手边|右边|右侧","右"),("前置|前排|前方","前"),
          ("后置|后排|后方","后"),("第([一二三四])(?:组|个|号)","\\1号"),
          ("上面那层|上面一层","上层"),("下面那层|下面一层","下层"),("圆形","圆"),("方形","方"))
FILLER = re.compile("麻烦|能不能|帮忙|正在|已经|一下子|一下|一点|一些|起来|下来|出来|进去|做成|制成|用来|用的|得很|现在|请|将|把|给|让|的|着|了|吧|从|往|向|被|用|里|那|这|它|使|制|色|质")
NEGATION = re.compile("不要|请勿|先别|禁止|不必再")


def ratio(a,b):
    return a/b if b else 0.


def overlap(a,b):
    shared = len(a & b)
    return ratio(shared,len(a|b)),ratio(shared,len(a)),ratio(shared,len(b))


@dataclass
class View:
    signature: np.ndarray
    terms: frozenset
    obj: str
    chars: frozenset
    grams: frozenset
    attributes: tuple
    obj_vector: np.ndarray
    tokens: np.ndarray
    verb_vector: object


class RoleEvidence:
    def __init__(self, encoder, aliases):
        self.encoder = encoder
        self.matchers = []
        for i in range(max(max(ADDITIONS)+1,len(aliases))):
            terms = set(aliases[i] if i < len(aliases) else ()) | set(ADDITIONS.get(i,"").split())
            for text in sorted(terms):
                bits = text.split("~")
                self.matchers.append((i, re.compile(".{0,10}?".join(re.escape(bit) for bit in bits)), bits))
        self.object_embedding = lru_cache(maxsize=4096)(self._object_embedding)
        self.describe = lru_cache(maxsize=4096)(self._describe)
        self.pair = lru_cache(maxsize=32768)(self._pair)

    def _object_embedding(self, text):
        from semantic_encoder import MAX_TOKENS, input_arrays
        prefix = "query: "
        encoding = self.encoder.tokenizer.encode(prefix+text)
        inputs = {k:v[:,:MAX_TOKENS] for k,v in input_arrays(encoding,self.encoder.inputs).items()}
        hidden = self.encoder.session.run(["last_hidden_state"],inputs)[0][0]
        content = [i for i,(_,end) in enumerate(encoding.offsets[:len(hidden)]) if end>len(prefix)]
        words = hidden[content] if content else hidden[:1]
        pooled = hidden.mean(0)
        pooled = pooled / max(float(np.linalg.norm(pooled)),1e-8)
        norms = np.linalg.norm(words,axis=1,keepdims=True).clip(min=1e-8)
        return pooled, words/norms

    def _describe(self, text):
        text = unicodedata.normalize("NFKC",text).casefold()
        clauses = [p.strip() for p in re.split("[，,；;。]",text) if p.strip()]
        clause = clauses[-1] if len(clauses)==2 and re.search("已经|刚刚|早已|不用|无需",clauses[0]) else text
        mask = [False]*len(clause)
        signature = np.zeros(max(ADDITIONS)+1,dtype=np.float32)
        verbs = set()
        for idx,pattern,bits in self.matchers:
            for match in pattern.finditer(clause):
                start,end = match.span()
                strength = 1. + .18*min(sum(map(len,bits)),4)
                # Attribute clauses like “折好的纸” can mention an earlier action.
                if re.match("的",clause[end:]) and end+1<len(clause):
                    strength *= .48
                signature[idx] = max(signature[idx],strength)
                verbs.add("".join(bits))
                spans = [(start,start+len(bits[0]))]
                if len(bits)>1:
                    spans.append((end-len(bits[-1]),end))
                for left,right in spans:
                    mask[left:right] = [True]*(right-left)
        if re.search("逆时针|逆着时针|反方向|相反的方向",clause):
            signature[48] = 0
        if re.search("不再显示|不可见",clause):
            signature[51] = 0
        if re.search("背面|反面",clause) and re.search("朝上|向上|朝下|向下",clause):
            down = bool(re.search("朝上|向上",clause))
            signature[46],signature[47] = (0.,2.) if down else (2.,0.)
        obj = FILLER.sub("","".join(ch for k,ch in enumerate(clause) if not mask[k]))
        for pattern,replacement in NORMAL:
            obj = re.sub(pattern,replacement,obj)
        obj = "".join(ch for ch in obj if ch.isalnum())
        chars = frozenset(obj)
        grams = frozenset(obj[k:k+2] for k in range(len(obj)-1))
        attributes = tuple(frozenset(t for t in group if t in obj) for group in ATTRIBUTES)
        vector,tokens = self.object_embedding(obj or clause)
        verb = self.encoder.encode(" ".join(sorted(verbs)[:12])) if verbs else None
        return View(signature,frozenset(verbs),obj,chars,grams,attributes,vector,tokens,verb)

    def _pair(self, query, cue):
        q,c = self.describe(query),self.describe(cue)
        qsig,csig = q.signature,c.signature
        qn,cn = np.linalg.norm(qsig),np.linalg.norm(csig)
        product = float(qn*cn)
        fine = ratio(float(qsig@csig),product)
        scale = float(max(qsig.max()*csig.max(),1e-7))
        same = float(np.max(np.minimum(qsig,csig)))/2
        related = max(float(qsig[list(g)].max()*csig[list(g)].max()) for g in RELATED)/scale
        opposed = max(max(float(qsig[a]*csig[b]),float(qsig[b]*csig[a])) for a,b in OPPOSED)/scale
        verb_cos = float(q.verb_vector @ c.verb_vector) if q.verb_vector is not None and c.verb_vector is not None else .82
        action = [fine,same,related,opposed,float(qn>0),float(cn>0),(verb_cos-.82)*6,
                  *overlap(q.terms,c.terms),float(bool(NEGATION.search(query))!=bool(NEGATION.search(cue)))]
        token_sim = q.tokens @ c.tokens.T
        qmax,cmax = token_sim.max(1),token_sim.max(0)
        attrs = [(left,right) for left,right in zip(q.attributes,c.attributes) if left and right]
        att_agree = sum(bool(left&right) for left,right in attrs)
        att_conflict = sum(not (left&right) and len(left)==len(right)==1 for left,right in attrs)
        object_values = [(float(q.obj_vector@c.obj_vector)-.82)*6,
                         *[(float(v)-.65)*4 for v in (qmax.mean(),cmax.mean(),qmax.min(),cmax.min())],
                         *overlap(q.chars,c.chars),*overlap(q.grams,c.grams),float(bool(q.obj) and q.obj==c.obj),
                         min(att_agree,2),min(att_conflict,2)]
        full_cos = float(self.encoder.encode(query)@self.encoder.encode(cue))
        full = [(full_cos-.82)*6,similarity(sparse_address(query),sparse_address(cue)),float(query==cue)]
        return action,object_values,full

    def group(self, query, cues):
        q = self.describe(query)
        descriptions = [self.describe(c) for c in cues]
        count = len(cues)
        frequencies = [Counter(t for v in descriptions for t in getattr(v,key)) for key in ("chars","grams")]
        def coverage(terms,common,df):
            def weight(t): return .08+math.log((count+1)/(df[t]+.7))
            return ratio(sum(weight(t) for t in sorted(common)),sum(weight(t) for t in sorted(terms)))
        data = []
        for text,view in zip(cues,descriptions):
            action,obj,full = self.pair(query,text)
            contextual = []
            for key,df in zip(("chars","grams"),frequencies):
                left,right = getattr(q,key),getattr(view,key)
                common = left&right
                contextual.extend((coverage(left,common,df),coverage(right,common,df)))
            data.append([*action,*obj,*contextual,*full])
        return np.asarray(data,dtype=np.float32)


ACTION_DIM = 11
OBJECT_DIM = 18
WHOLE_DIM = 4  # Includes the parent logit, attached after feature extraction.
