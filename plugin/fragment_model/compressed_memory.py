"""Lossless semantic units with associative access to every original observation."""
from functools import lru_cache

import numpy as np
import torch

from four_layer_joint_cues import JointCueMemory,request_polarity
from fragment_pack import CompressedIndex
from model import file_hash,includes
from open_set_features import BGE,OpenSetFeatures
from open_set_head import REASONS,load_head
from role_evidence import RoleEvidence
from semantic_encoder import PairReranker


def compress_options(path,checkpoint,device):
    head,gate=load_head(path,file_hash(checkpoint),device)
    aliases=torch.load(checkpoint,map_location="cpu",weights_only=True)["aliases"]
    return dict(support=head,gate=gate,aliases=aliases)


MESSAGES={
    "unknown_object":"在这个范围的碎片里，找不到能对上你所指物品的记录。",
    "unsupported_action":"在这个范围的碎片里，找不到这个物品执行该动作的记录。",
    "ambiguous_object":"你指的是哪一个物品？可以补充名称，或选一条完整说法。",
    "insufficient_evidence":"目前的线索不足以确定一条完整记录，请补充物品或动作。",
    "blocked":"当前条件和查询没有共同指向一条可用记录。",
    "invalid_choice":"这个选项不在本次澄清的可用说法中。"}


class CompressedMemory(JointCueMemory):
    def __init__(self,*args,support,gate,aliases,**kwargs):
        super().__init__(*args,**kwargs)
        self.support=support
        self.gate=gate
        self.features=OpenSetFeatures(RoleEvidence(self.encoder,aliases),PairReranker())
        self._index_head=self._index=None
        self.classify=lru_cache(maxsize=512)(self._classify)

    @property
    def index(self):
        if self._index is None or self._index_head!=self.head:
            self._index=CompressedIndex(self._fragments.values())
            self._index_head=self.head
        return self._index

    @torch.inference_mode()
    def _classify(self,cue,forms):
        x=self.features.group(cue,forms)
        tensor=torch.from_numpy(x).unsqueeze(0).to(self.device)
        mask=torch.ones(tensor.shape[:2],dtype=torch.bool,device=self.device)
        raw,parts=self.support(tensor,mask)
        z=raw[0].cpu().numpy()
        actions=parts[0,:,0].cpu().numpy()
        scores=x[:,BGE]
        order=np.argsort(-scores,kind="stable")
        first=int(order[0])
        lead=float(scores[first]-scores[order[1]]) if len(order)>1 else float("inf")
        confidence=float(z[0]-np.logaddexp.reduce(z[1:]))
        reason=REASONS[int(np.argmax(z))]
        if reason=="supported" and (confidence<self.gate["floor"] or lead<=self.gate["bge_margin"]):
            reason="insufficient_evidence"
        plausible=(actions>=self.gate["option_floor"])&(actions>=actions.max()-self.gate["option_span"])
        return reason,first,tuple(int(k) for k in order if plausible[k])

    def _resolve(self,context,cue,toward,after,choice):
        if type(cue) is not str or len(cue)>512 or (not cue.strip() and toward is None and after is None):
            raise ValueError("Supply a cue, a target, or a previous fragment")
        if choice is not None and (type(choice) is not str or not choice.strip() or len(choice)>512):
            raise ValueError("Choice must be one offered full cue")
        if not cue.strip():
            fragment,shared=super().select(context,cue,toward=toward,after=after)
            return (fragment,shared,"supported" if fragment else "blocked",()) if choice is None else (None,{},"invalid_choice",())
        view,relevant,established=self._association_view(context,toward,after)
        if not relevant:
            return None,{},"blocked",()
        scope=self._association_view(context,None,after)[1] if toward is not None else relevant
        index=self.index
        numbers=sorted({index.by_id[k][0] for k in scope},key=lambda n:index.units[n].forms)
        units=[index.units[i] for i in numbers]
        forms=tuple(u.forms for u in units)
        allowed=self._applicable(view)
        usable=relevant.intersection(allowed)
        if not usable:
            return None,{},"blocked",()
        query_sign=request_polarity(cue)
        def signed(unit):
            return query_sign is None or any(request_polarity(v) in (None,query_sign) for v in unit.forms)
        if not any(signed(u) for u in units):
            return None,{},"blocked",()
        exact=[i for i,unit in enumerate(units) if cue.strip() in unit.forms]
        if len(exact)>1:
            return None,{},"blocked",()
        if exact:
            reason,first,options="supported",exact[0],()
        else:
            reason,first,options=self.classify(cue,forms)
        if reason=="ambiguous_object":
            choices={}
            for i in options:
                unit=units[i]
                if signed(unit) and any(key in usable for key,_,_ in unit.links):
                    choices.setdefault(unit.forms[0],[]).append(i)
            choices={v:ids[0] for v,ids in choices.items() if len(ids)==1}
            if len(choices)<2:
                choices={}
            if choice is None:
                return None,{},reason,tuple(choices)
            if choice not in choices:
                return None,{},"invalid_choice",()
            first=choices[choice]
        elif choice is not None:
            return None,{},"invalid_choice",()
        elif reason!="supported":
            return None,{},reason,()
        unit=units[first]
        links=[link for link in unit.links if link[0] in usable]
        if not links or not signed(unit):
            return None,{},"blocked",()
        target=choice or cue.strip()
        link=next((item for item in links if item[1]==target),links[0])
        fragment=unit.restore(link)
        shared={k:v for k,v in fragment.conditions if includes(established,((k,v),))}
        return fragment,shared,"supported",()

    def select(self,context,cue="",*,toward=None,after=None,cosine_only=False):
        if cosine_only:
            return super().select(context,cue,toward=toward,after=after,cosine_only=True)
        fragment,shared,_,_=self._resolve(context,cue,toward,after,None)
        return fragment,shared

    def answer(self,context,cue="",*,toward=None,after=None,choice=None):
        fragment,shared,reason,choices=self._resolve(context,cue,toward,after,choice)
        if fragment is None:
            return {"status":"no_match","reason":reason,"message":MESSAGES[reason],**({"choices":list(choices)} if choices else {})}
        index=self.index
        unit=index.units[index.by_id[fragment.id][0]]
        fragment=index.restore(fragment.id)
        result=self.read_result(fragment)
        if result is None:
            return {"status":"unverified"}
        observations=[{"fragment_id":r.id,"cue":r.cue,"source":r.source} for r in map(unit.restore,unit.links)]
        return {"status":"grounded","fragment_id":fragment.id,"conditions":dict(fragment.conditions),"action":fragment.action,
                "answer":result,"cue":fragment.cue,"source":fragment.source,"linked_from":after,"shared_facts":shared,
                "observations":observations}
