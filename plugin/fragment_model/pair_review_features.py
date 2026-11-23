"""Evidence about the parts of two stored cues that actually distinguish them."""
from difflib import SequenceMatcher
from functools import lru_cache
import re
import unicodedata

import numpy as np

from role_evidence import ACTION_DIM, OBJECT_DIM, WHOLE_DIM


STOP = frozenset("把将给让请的得地了着那这它个用和与于而")
SPAN_DIM = 12
UPSTREAM_DIM = ACTION_DIM + OBJECT_DIM + WHOLE_DIM + 3
SIDE_DIM = UPSTREAM_DIM + 3 * SPAN_DIM + 3


@lru_cache(maxsize=8192)
def compact(text):
    return "".join(c for c in unicodedata.normalize("NFKC",text).casefold() if c.isalnum() and c not in STOP)


@lru_cache(maxsize=16384)
def distinguishing_spans(text, rival):
    """Keep both the edited spans and their near context for one side of an alignment."""
    if not text or not rival or text == rival:
        return (), ""
    spans, windows = [], []
    for tag, left, right, _, _ in SequenceMatcher(None,text,rival,autojunk=False).get_opcodes():
        if tag!="equal" and left<right:
            spans.append(text[left:right])
            windows.append(text[max(0,left-1):min(len(text),right+1)])
    return tuple(spans), " ".join(windows)


class ContrastEvidence:
    def __init__(self, evidence):
        self.evidence = evidence
        self.span_features = lru_cache(maxsize=32768)(self._span_features)
        self.foils = lru_cache(maxsize=4096)(self._foils)

    def _span_features(self, query, text, rival):
        spans,window = distinguishing_spans(text,rival)
        if not spans or not query.strip():
            return (0.,)*SPAN_DIM
        delta = "".join(spans)
        hits = sum(len(piece) for piece in spans if piece in query)
        letters = set(delta)
        shingles = {delta[k:k+2] for k in range(len(delta)-1)}
        exact_letters = len(letters & set(query)) / len(letters)
        longest = SequenceMatcher(None,delta,query,autojunk=False).find_longest_match().size
        pooled,qtokens = self.evidence.object_embedding(query)
        delta_vector,dtokens = self.evidence.object_embedding(" ".join(spans))
        window_vector,_ = self.evidence.object_embedding(window)
        token_max = (dtokens @ qtokens.T).max(axis=1)
        return (1., min(len(delta),12)/12, hits/len(delta), exact_letters,
                sum(g in query for g in shingles)/max(1,len(shingles)),
                longest/len(delta), float(any(query.startswith(s) or query.endswith(s) for s in spans)),
                (float(delta_vector@pooled)-.80)*5, (float(window_vector@pooled)-.80)*5,
                (float(token_max.mean())-.62)*4, (float(token_max.min())-.62)*4,
                float(any(len(s)>1 and s in query for s in spans)))

    def _foils(self, cue, scope):
        """Find another object with a similar action and another action on a similar object."""
        own = self.evidence.describe(cue)
        object_foil, action_foil = "", ""
        best_obj, best_act = -float("inf"), -float("inf")
        for other in sorted(set(scope)):
            if other==cue:
                continue
            alt = self.evidence.describe(other)
            norm = float(np.linalg.norm(own.signature)*np.linalg.norm(alt.signature))
            action_shared = float(own.signature@alt.signature)/norm if norm else 0.
            object_shared = float(own.obj_vector@alt.obj_vector)
            noun_overlap = len(own.chars & alt.chars)/max(1,len(own.chars|alt.chars))
            if alt.obj and own.obj and own.obj!=alt.obj:
                value = 2*action_shared+object_shared+.3*noun_overlap
                if value>best_obj:
                    object_foil,best_obj = alt.obj,value
            if compact(other)!=compact(cue):
                value = 2*object_shared+noun_overlap-.5*action_shared
                if value>best_act:
                    action_foil,best_act = compact(other),value
        return object_foil,action_foil

    def group(self, query, scope, two_indices, upstream):
        q = self.evidence.describe(query)
        scope = tuple(scope)
        pair = np.zeros((2,SIDE_DIM),dtype=np.float32)
        for slot,index in enumerate(two_indices):
            cue = scope[index]
            rival = scope[two_indices[1-slot]] if len(two_indices)==2 else ""
            other_object,other_action = self.foils(cue,scope)
            own = self.evidence.describe(cue)
            delta = self.span_features(compact(query),compact(cue),compact(rival))
            obj = self.span_features(q.obj,own.obj,other_object)
            action = self.span_features(compact(query),compact(cue),other_action)
            pair[slot] = [*upstream[index],*delta,*obj,*action,
                          float(bool(rival)), np.log2(min(512,len(scope)))/5, float(compact(query)==compact(cue))]
        if not np.isfinite(pair).all():
            raise ValueError("Nonfinite review evidence")
        return pair


def top_two(scores, names):
    """Stable by text; identical cue text is reviewed once, irrespective of record order."""
    selected, seen = [],set()
    for index in sorted(range(len(scores)),key=lambda i:(-float(scores[i]),names[i])):
        if names[index] not in seen:
            selected.append(index)
            seen.add(names[index])
        if len(selected)==2:
            break
    return selected
