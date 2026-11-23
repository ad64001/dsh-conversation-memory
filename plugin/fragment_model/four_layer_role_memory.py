"""Use supervised action/object ranking before reading a single stored result."""
from functools import lru_cache

import numpy as np
import torch

from four_layer_joint_cues import JointCueMemory
from model import file_hash
from role_evidence import RoleEvidence
from role_ranker import load_ranker


def ranking_options(ranker_path, checkpoint_path, device):
    ranker,gate = load_ranker(ranker_path,file_hash(checkpoint_path),device)
    saved = torch.load(checkpoint_path,map_location="cpu",weights_only=True)
    return {"ranker":ranker,"gate":gate,"aliases":saved["aliases"]}


class RankedMemory(JointCueMemory):
    def __init__(self,journal,fields,*,ranker,gate,aliases,policy,**options):
        super().__init__(journal,fields,policy={**policy,"learned":[0.,gate["margin"]]},**options)
        self.ranker = ranker
        self.gate = gate
        self.parent_policy = policy
        self.evidence = RoleEvidence(self.encoder,aliases)
        self.ranking = lru_cache(maxsize=512)(self._ranking)
        self._parent_order = lru_cache(maxsize=512)(super()._scores)

    def parent_scores(self,cue,keys,cosine_only):
        return self._parent_order(cue,tuple(keys),cosine_only)

    @torch.inference_mode()
    def _ranking(self,cue,keys,use_parent=True):
        parent = dict(self.parent_scores(cue,keys,False)) if use_parent else {}
        texts = [self._fragments[k].cue for k in keys]
        values = self.evidence.group(cue,texts)
        base = np.asarray([parent.get(k,0.) for k in keys],dtype=np.float32)
        inputs = np.column_stack((values,np.clip(base/4,-6.,6.)))
        score,_ = self.ranker(torch.from_numpy(inputs).to(self.device))
        floor = self.gate["multi_floor" if len(keys)>1 else "single_floor"]
        return tuple(sorted(zip(keys,(score-float(floor)).cpu().tolist()),key=lambda item:(-item[1],item[0])))

    def _scores(self,cue,keys,cosine_only):
        if cosine_only:
            return super()._scores(cue,keys,True)
        return self.ranking(cue,tuple(keys))


class ConsensusMemory(RankedMemory):
    """Add a result only on a checked, unique first-place agreement."""
    def select(self, context, cue="", *, toward=None, after=None, cosine_only=False):
        previous = self._select_with(context,cue,toward,after,cosine_only,self.parent_scores,self.parent_policy)
        if previous[0] is not None or cosine_only or not cue.strip():
            return previous
        _,scope,_ = self._association_view(context,None,after)
        if len(scope)<2:
            return None, {}
        chosen,shared = super().select(context,cue,toward=toward,after=after)
        if chosen is None:
            return None, {}
        keys=tuple(sorted(scope))
        for ranked in (self.parent_scores(cue,keys,False),self.ranking(cue,keys)):
            first,second=ranked[:2]
            if first[0]!=chosen.id or first[1]-second[1]<=1e-6:
                return None, {}
        return chosen,shared
