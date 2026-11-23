"""Review the two strongest distinct cues in a scope before releasing a stored result."""
from functools import lru_cache

import numpy as np
import torch

from four_layer_joint_cues import request_polarity
from four_layer_role_memory import ConsensusMemory
from model import file_hash, includes
from pair_review_features import ContrastEvidence, top_two
from pair_reviewer import load_reviewer


def reviewer_options(path,checkpoint,ranker,device):
    reviewer,gates = load_reviewer(path,file_hash(checkpoint),file_hash(ranker),device)
    return {"reviewer":reviewer,"review_gates":gates}


class VetoMemory(ConsensusMemory):
    """Return an existing answer only if the action/object scorer also ranks its cue first."""
    def select(self,context,cue="",*,toward=None,after=None,cosine_only=False):
        chosen,shared = super().select(context,cue,toward=toward,after=after,cosine_only=cosine_only)
        if chosen is None or cosine_only or not cue.strip():
            return chosen,shared
        scope = tuple(sorted(self._association_view(context,None,after)[1]))
        ranked = self.ranking(cue,scope)
        first = ranked[0][1]
        leading = {self._fragments[k].cue for k,score in ranked if first-score<=1e-6}
        return (chosen,shared) if leading=={chosen.cue} else (None,{})


class ReviewedMemory(ConsensusMemory):
    def __init__(self,*args,reviewer,review_gates,**kwargs):
        super().__init__(*args,**kwargs)
        self.reviewer = reviewer
        self.review_gates = review_gates
        self.contrast = ContrastEvidence(self.evidence)
        self.review_pair = lru_cache(maxsize=512)(self._review_pair)

    @torch.inference_mode()
    def _review_pair(self,cue,keys):
        texts = tuple(self._fragments[k].cue for k in keys)
        parent = dict(self.parent_scores(cue,keys,False))
        scores = np.asarray([parent[k] for k in keys],dtype=np.float32)
        static = np.column_stack((self.evidence.group(cue,texts),np.clip(scores/4,-6,6)))
        raw,parts = self.ranker(torch.from_numpy(static).to(self.device))
        role = raw.cpu().numpy()
        pair = top_two(role,texts)
        upstream = np.column_stack((static,np.clip(role/4,-6,6),np.clip(parts.cpu().numpy()/4,-6,6)))
        values = self.contrast.group(cue,texts,pair,upstream)
        valid = torch.tensor([[True,len(pair)==2]],device=self.device)
        relative = self.reviewer(torch.from_numpy(values)[None].to(self.device),valid)[0].cpu().tolist()
        return tuple(texts[i] for i in pair),tuple(relative[:len(pair)])

    def review_decision(self,context,cue,after,previous):
        keys = tuple(sorted(self._association_view(context,None,after)[1]))
        if not keys:
            return (),None,"no_scope"
        texts,scores = self.review_pair(cue,keys)
        winner = max(range(len(scores)),key=scores.__getitem__)
        shared_first = previous is not None and previous.cue==texts[winner]
        kind = "single" if len(texts)==1 else ("reaffirm" if shared_first else "changed")
        gate = self.review_gates[kind]
        lead = abs(scores[0]-scores[1]) if len(texts)>1 else float("inf")
        if scores[winner]<gate["floor"]:
            return texts,winner,"floor"
        if lead<=gate["margin"]:
            return texts,winner,"lead"
        return texts,winner,"accepted"

    def select(self,context,cue="",*,toward=None,after=None,cosine_only=False):
        previous = super().select(context,cue,toward=toward,after=after,cosine_only=cosine_only)
        if cosine_only or not cue.strip():
            return previous
        view,relevant,established = self._association_view(context,toward,after)
        if not relevant:
            return None,{}
        texts,winner,reason = self.review_decision(context,cue,after,previous[0])
        if reason!="accepted":
            return None,{}
        text = texts[winner]
        sign,stored = request_polarity(cue),request_polarity(text)
        if sign is not None and stored is not None and sign!=stored:
            return None,{}
        applicable = self._applicable(view)
        candidates = [applicable[k] for k in sorted(relevant.intersection(applicable)) if applicable[k].cue==text]
        if len({(r.action,r.result) for r in candidates})!=1:
            return None,{}
        chosen = candidates[0]
        shared = {k:v for k,v in chosen.conditions if includes(established,((k,v),))}
        return chosen,shared
