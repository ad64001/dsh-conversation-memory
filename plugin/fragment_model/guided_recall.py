"""Associative recall with reversible memory and explicit confirmation of new suggestions."""
from argparse import ArgumentParser
import json
from pathlib import Path

import torch
from compressed_memory import CompressedMemory,MESSAGES,compress_options
from four_layer import load_model
from four_layer_features import FragmentCueEncoder
from four_layer_joint_cues import request_polarity
from four_layer_memory import DEFAULT_CHECKPOINT
from four_layer_pair_memory import ReviewedMemory,reviewer_options
from four_layer_role_memory import ranking_options
from model import digest,includes,read_json

ROOT=Path(__file__).resolve().parent
OLD=ROOT/"validation/four_layer_pair_review_20261118/run"
SUPPORT=ROOT/"validation/compressed_recall_20261118/run/support.pt"


class GuidedRecall(CompressedMemory):
    def __init__(self,journal,fields,*,checked_options,confirm_unseen=False,**options):
        super().__init__(journal,fields,**options)
        self.confirm_unseen=confirm_unseen
        self._checked_config=(journal,fields,checked_options)
        self._checked_head=self._checked=None

    @property
    def checked(self):
        if self._checked is None or self._checked_head!=self.head:
            journal,fields,options=self._checked_config
            self._checked=ReviewedMemory(journal,fields,**options)
            self._checked_head=self.head
        return self._checked

    def _inventory(self,context,cue,toward,after):
        if type(cue) is not str or len(cue)>512:
            raise ValueError("Invalid recall cue")
        view,relevant,established=self._association_view(context,toward,after)
        eligible=relevant.intersection(self._applicable(view))
        if not eligible:
            return {},established
        index=self.index
        scoped=self._association_view(context,None,after)[1] if toward is not None else relevant
        exact={k for k in scoped if self._fragments[k].cue==cue.strip()}
        if exact and not exact.intersection(eligible):
            return {},established
        sign=request_polarity(cue) if cue.strip() else None
        binding=[self._binding,self.head,self.scope_fields,context,cue,toward,after]
        entries={}
        for n in sorted({index.by_id[k][0] for k in eligible},key=lambda j:index.units[j].forms):
            unit=index.units[n]
            if sign is not None and not any(request_polarity(t) in (None,sign) for t in unit.forms):
                continue
            token=digest([binding,[k for k,_,_ in unit.links]])
            entries[token]=unit
        return entries,established

    @staticmethod
    def _option(token,unit):
        return {"token":token,"cues":list(unit.forms),"action":unit.action,"conditions":dict(unit.conditions)}

    def _first(self,context,cue,toward,after,entries):
        if not cue.strip() and toward is None and after is None:
            raise ValueError("Supply a cue, target, previous fragment, or request the inventory")
        if not entries:
            return None,{},"blocked",[]
        if not cue.strip() or any(cue.strip() in u.forms for u in entries.values()):
            f,shared,reason,_=self._resolve(context,cue,toward,after,None)
            return f,shared,("observed" if f else reason),[]
        if not self.confirm_unseen:
            old,shared=self.checked.select(context,cue,toward=toward,after=after)
            if old and any(old.id==k for u in entries.values() for k,_,_ in u.links):
                return old,shared,"checked",[]
        suggested,_,reason,options=self._resolve(context,cue,toward,after,None)
        if suggested:
            options=(suggested.cue,)
            reason="confirm_match"
        shortlist=[self._option(token,u) for token,u in entries.items() if set(u.forms).intersection(options)]
        return None,{},reason,shortlist

    def _recover(self,fragment,shared,after,how):
        index=self.index
        unit=index.units[index.by_id[fragment.id][0]]
        original=index.restore(fragment.id)
        result=self.read_result(original)
        if result is None:
            return {"status":"unverified"}
        links=[{"fragment_id":r.id,"cue":r.cue,"source":r.source} for r in map(unit.restore,unit.links)]
        return {"status":"grounded","resolution":how,"fragment_id":original.id,"conditions":dict(original.conditions),
                "action":original.action,"answer":result,"cue":original.cue,"source":original.source,"linked_from":after,
                "shared_facts":shared,"observations":links}

    def select(self,context,cue="",*,toward=None,after=None,cosine_only=False):
        if cosine_only:
            return super().select(context,cue,toward=toward,after=after,cosine_only=True)
        entries,_=self._inventory(context,cue,toward,after)
        f,shared,_,_=self._first(context,cue,toward,after,entries)
        return f,shared

    def answer(self,context,cue="",*,toward=None,after=None,browse=False,confirm=None):
        if type(browse) is not bool or (confirm is not None and (type(confirm) is not str or browse)):
            raise ValueError("Choose either inventory browsing or one confirmation token")
        entries,established=self._inventory(context,cue,toward,after)
        if browse:
            return {"status":"inventory","options":[self._option(t,u) for t,u in entries.items()]}
        if confirm is not None:
            if confirm not in entries:
                return {"status":"no_match","reason":"invalid_choice","message":"这个选项在当前查询和碎片库版本中无效。"}
            u=entries[confirm]
            link=next((l for l in u.links if l[1]==cue.strip()),u.links[0])
            fragment=u.restore(link)
            shared={k:v for k,v in fragment.conditions if includes(established,((k,v),))}
            return self._recover(fragment,shared,after,"confirmed")
        f,shared,reason,suggestions=self._first(context,cue,toward,after,entries)
        if f is not None:
            return self._recover(f,shared,after,reason)
        msg="有一条相近记忆，请核对完整说法。" if reason=="confirm_match" else MESSAGES[reason]
        return {"status":"no_match","reason":reason,"message":msg,"can_browse":bool(entries),
                **({"suggestions":suggestions} if suggestions else {})}


def open_memory(journal,fields,*,scope_fields,capacity=512,device="cpu",checkpoint=DEFAULT_CHECKPOINT,
                support=SUPPORT,ranker=OLD/"ranker.pt",reviewer=OLD/"reviewer.pt",create=False,confirm_unseen=False):
    net,policy=load_model(checkpoint,device)
    base=dict(network=net,policy=policy,encoder=FragmentCueEncoder(),scope_fields=scope_fields,capacity=capacity)
    checked={} if confirm_unseen else {**base,**ranking_options(ranker,checkpoint,device),
                                       **reviewer_options(reviewer,checkpoint,ranker,device)}
    return GuidedRecall(journal,fields,checked_options=checked,confirm_unseen=confirm_unseen,create=create,
                        **base,**compress_options(support,checkpoint,device))


if __name__=="__main__":
    ap=ArgumentParser(description=__doc__)
    ap.add_argument("journal",type=Path)
    ap.add_argument("schema",type=Path)
    ap.add_argument("requests",type=Path)
    ap.add_argument("--scope-field",action="append",default=[])
    ap.add_argument("--capacity",type=int,default=512)
    ap.add_argument("--device",default="cpu")
    ap.add_argument("--checkpoint",type=Path,default=DEFAULT_CHECKPOINT)
    ap.add_argument("--support",type=Path,default=SUPPORT)
    ap.add_argument("--ranker",type=Path,default=OLD/"ranker.pt")
    ap.add_argument("--reviewer",type=Path,default=OLD/"reviewer.pt")
    ap.add_argument("--confirm-unseen",action="store_true",help="Require an explicit choice for any unrecorded free-text cue")
    a=ap.parse_args()
    torch.set_num_threads(2)
    memory=open_memory(a.journal,read_json(a.schema),scope_fields=a.scope_field,capacity=a.capacity,device=a.device,
                       checkpoint=a.checkpoint,support=a.support,ranker=a.ranker,reviewer=a.reviewer,confirm_unseen=a.confirm_unseen)
    qs=read_json(a.requests)
    print(json.dumps([memory.answer(**q) for q in qs] if isinstance(qs,list) else memory.answer(**qs),ensure_ascii=False,indent=2))
