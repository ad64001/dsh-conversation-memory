"""Query a four-layer journal with agreement between the requested action and goal."""
from argparse import ArgumentParser
import json
import math
from pathlib import Path
import re

import torch

from four_layer import load_model
from four_layer_features import FragmentCueEncoder
from four_layer_memory import DEFAULT_CHECKPOINT, FourLayerMemory
from model import read_json


NEGATIVE_REQUEST = re.compile(
    r"^(?:(?:麻烦你?|请你?|暂时|暂且|现在|务必|千万|先)\s*)*?"
    r"(?:不要|先别|请勿|千万别|不必再|无需再|禁止(?:把|将|继续))"
)


def request_polarity(cue):
    clauses = [part.strip() for part in re.split(r"[，,。；;！？!?]",cue) if part.strip()]
    if len(clauses) != 1:
        return None
    if re.search("改为|而是|只需|改用|然后|接着",clauses[0]):
        return None
    return bool(NEGATIVE_REQUEST.match(clauses[0]))


class JointCueMemory(FourLayerMemory):
    def _select_with(self, context, cue, toward, after, cosine_only, scores, policy):
        chosen, shared = super()._select_with(context,cue,toward,after,cosine_only,scores,policy)
        if chosen is None or not cue.strip():
            return chosen, shared
        query_sign, record_sign = request_polarity(cue), request_polarity(chosen.cue)
        if query_sign is not None and record_sign is not None and query_sign != record_sign:
            return None, {}
        if toward is None:
            return chosen, shared
        # A supplied result can resolve a tie. Filtering on the result must never
        # manufacture a winning meaning by hiding a higher-scoring competing action.
        _, candidates, _ = self._association_view(context,None,after)
        if len(candidates) <= 1:
            return chosen,shared
        ranking = scores(cue,sorted(candidates),cosine_only)
        best = ranking[0][1]
        for key, score in ranking:
            if not math.isclose(score,best,rel_tol=1e-6,abs_tol=1e-6):
                break
            candidate = self._fragments[key]
            if candidate.action == chosen.action and candidate.result == chosen.result:
                return chosen, shared
        return None, {}


def main():
    parser=ArgumentParser(description=__doc__)
    parser.add_argument("journal",type=Path)
    parser.add_argument("schema",type=Path)
    parser.add_argument("request",type=Path)
    parser.add_argument("--checkpoint",type=Path,default=DEFAULT_CHECKPOINT)
    parser.add_argument("--scope-field",action="append",default=[])
    parser.add_argument("--capacity",type=int,default=512)
    parser.add_argument("--device",default="cuda" if torch.cuda.is_available() else "cpu")
    args=parser.parse_args()
    torch.set_num_threads(2)
    network,policy=load_model(args.checkpoint,args.device)
    engine=JointCueMemory(args.journal,read_json(args.schema),network=network,policy=policy,
                          encoder=FragmentCueEncoder(),scope_fields=args.scope_field,capacity=args.capacity)
    req=read_json(args.request)
    reply=[engine.answer(**q) for q in req] if isinstance(req,list) else engine.answer(**req)
    print(json.dumps(reply,ensure_ascii=False,indent=2))


if __name__=="__main__":
    main()
