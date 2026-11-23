"""Evidence from all distinct alternatives in a fragment scope, including their shared wording."""
from difflib import SequenceMatcher
from functools import lru_cache
import math

import numpy as np
from pair_review_features import ContrastEvidence,compact
from role_evidence import ACTION_DIM,OBJECT_DIM,WHOLE_DIM


BASE=ACTION_DIM+OBJECT_DIM+WHOLE_DIM-1
BGE=BASE
WIDTH=BASE+16+12


def logodds(value):
    p=max(1e-6,min(1-1e-6,value))
    return math.log(p/(1-p))/5


@lru_cache(maxsize=8192)
def common(a,b):
    seq=SequenceMatcher(None,a,b,autojunk=False)
    return "".join(a[i:i+n] for i,_,n in seq.get_matching_blocks())


def cover(a,b):
    return len(set(a)&set(b))/max(1,len(set(a)))


class OpenSetFeatures:
    def __init__(self,evidence,reranker):
        self.evidence=evidence
        self.reranker=reranker
        self.contrast=ContrastEvidence(evidence)
        self.patterns=lru_cache(maxsize=512)(self._patterns)
        self.group=lru_cache(maxsize=512)(self._group)

    def _patterns(self,texts):
        result=[]
        views=[self.evidence.describe(t) for t in texts]
        for i,cue in enumerate(texts):
            left=views[i]
            obj_score=act_score=-float("inf")
            equivalent_action=equivalent_object=""
            obj_rival=""
            for j,other in enumerate(texts):
                if j==i or other==cue:
                    continue
                right=views[j]
                norm=float(np.linalg.norm(left.signature)*np.linalg.norm(right.signature))
                verb=float(left.signature@right.signature)/norm if norm else 0.
                noun=float(left.obj_vector@right.obj_vector)
                lexical=cover(left.obj,right.obj)*cover(right.obj,left.obj)
                shared=common(compact(cue),compact(other))
                alignment=len(shared)/max(len(compact(cue)),len(compact(other)),1)
                diff_object=2.7*verb+1.4*alignment-.6*lexical
                diff_action=2.*lexical+1.2*noun-1.2*verb+.25*alignment
                if diff_object>obj_score:
                    obj_score,equivalent_action,obj_rival=diff_object,shared,right.obj
                if diff_action>act_score:
                    act_score,equivalent_object=diff_action,shared
            result.append((equivalent_action,equivalent_object,obj_rival))
        return tuple(result)

    def _group(self,query,forms):
        # Each unit has a canonical cue and all the explicitly observed alternative phrasings.
        canonical=tuple(v[0] for v in forms)
        variants=[]
        best=[]
        for cues in forms:
            values=[logodds(self.reranker.score(query,c)) for c in cues]
            index=max(range(len(cues)),key=values.__getitem__)
            variants.append(cues[index])
            best.append(values[index])
        static=self.evidence.group(query,variants)
        patterns=self.patterns(canonical)
        scope_chars=set("".join(compact(t) for unit in forms for t in unit))
        short=compact(query)
        obj=self.evidence.describe(query).obj
        rows=[]
        for i,cue in enumerate(canonical):
            generic,noun,other_obj=patterns[i]
            own=self.evidence.describe(cue).obj
            generic_score=logodds(self.reranker.score(query,generic)) if generic else 0.
            noun_score=logodds(self.reranker.score(query,noun)) if noun else 0.
            novel=[c not in scope_chars for c in short]
            longest=run=0
            for unseen in novel:
                run=run+1 if unseen else 0
                longest=max(longest,run)
            competitor=max((v for j,v in enumerate(best) if j!=i),default=best[i])
            cues=forms[i]
            side=[best[i],generic_score,noun_score,best[i]-generic_score,best[i]-noun_score,best[i]-competitor,
                  cover(short,scope_chars),cover(obj,scope_chars),min(longest,6)/6.,cover(short,generic),
                  cover(short,noun),cover(generic,short),cover(noun,short),float(short==generic and bool(short)),
                  float(any(query.strip()==v.strip() for v in cues)),min(len(obj),20)/20.]
            spans=self.contrast.span_features(obj,own,other_obj)
            rows.append([*static[i],*side,*spans])
        data=np.asarray(rows,np.float32)
        if data.shape!=(len(forms),WIDTH) or not np.isfinite(data).all():
            raise ValueError("Invalid associative features")
        return data
