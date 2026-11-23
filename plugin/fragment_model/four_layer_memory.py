"""Learn append-only fragments and ask the trained four-layer model for one result."""
from argparse import ArgumentParser
import json
from pathlib import Path

import numpy as np
import torch

from four_layer import CHUNK, FourLayerWithActions, load_model
from four_layer_features import FragmentCueEncoder
from model import encode, includes, read_json, similarity, sparse_address
from semantic_model import AssociationPolicy, SemanticFragmentModel


ROOT = Path(__file__).resolve().parent
DEFAULT_CHECKPOINT = ROOT / "weights/four_layer/four_layer_20261118.pt"


class FourLayerMemory(SemanticFragmentModel):
    def __init__(self, journal, fields, *, network, policy, encoder, scope_fields=(), capacity=512,
                 create=False):
        super().__init__(journal, fields, encoder=encoder, scope_fields=scope_fields, capacity=capacity,
                         create=create, policy=AssociationPolicy(1.0, 0.0, 0.0))
        self.network = network
        self.selection_policy = policy
        self.device = next(network.parameters()).device

    @torch.inference_mode()
    def _scores(self, cue, keys, cosine_only):
        query = self.encoder.features(cue)
        address = sparse_address(cue)
        ranked = []
        for start in range(0, len(keys), 32):
            batch = keys[start:start + 32]
            cues = np.stack([self.encoder.features(self._fragments[key].cue) for key in batch])
            if cosine_only:
                scores = cues[:, 0] @ query[0]
            else:
                q = torch.tensor(query, device=self.device).expand(len(batch), -1, -1)
                c = torch.as_tensor(cues, device=self.device)
                lexical = torch.tensor([similarity(address, self._addresses[key]) for key in batch],
                                       dtype=torch.float32, device=self.device)
                if isinstance(self.network, FourLayerWithActions):
                    matches = [self.network.action_features.pair(cue, self._fragments[key].cue) for key in batch]
                    actions = torch.tensor(matches, device=self.device, dtype=torch.float32)
                    logits = self.network.scored_pairs(q, c, lexical, actions)
                else:
                    logits = self.network.match_logits(q, c, lexical)
                scores = logits.cpu().tolist()
            ranked.extend(zip(batch, map(float, scores)))
        return sorted(ranked, key=lambda item: (-item[1], item[0]))

    def select(self, context, cue="", *, toward=None, after=None, cosine_only=False):
        return self._select_with(context, cue, toward, after, cosine_only, self._scores, self.selection_policy)

    def _select_with(self, context, cue, toward, after, cosine_only, scores, policy):
        if type(cue) is not str or len(cue) > 512 or (not cue.strip() and after is None and toward is None):
            raise ValueError("Supply a cue, a target, or a previous fragment")
        view, relevant, established = self._association_view(context, toward, after)
        if not relevant:
            return None, {}
        allowed = self._applicable(view)
        if cue.strip():
            ranking = scores(cue, sorted(relevant), cosine_only)
            first, score = ranking[0]
            action = self._fragments[first].action
            threshold, margin = policy["cosine" if cosine_only else "learned"]
            rival = next((s for k, s in ranking if self._fragments[k].action != action), -float("inf"))
            if score < threshold or score - rival <= margin:
                return None, {}
            key = next((k for k, _ in ranking if k in allowed and allowed[k].action == action), None)
        else:
            applicable = sorted(relevant.intersection(allowed))
            if len({allowed[k].action for k in applicable}) != 1:
                return None, {}
            key = applicable[0]
        if key is None:
            return None, {}
        shared = {k: v for k, v in allowed[key].conditions if includes(established, ((k, v),))}
        return allowed[key], shared

    @torch.inference_mode()
    def read_result(self, fragment):
        raw = encode(dict(fragment.result))
        padded = raw + bytes((-len(raw)) % CHUNK)
        chunks = torch.tensor(list(padded), dtype=torch.long, device=self.device).reshape(-1, CHUNK)
        decoded = []
        for batch in chunks.split(16):
            admitted = torch.ones(batch.size(0), dtype=torch.bool, device=self.device)
            decoded.extend(self.network.read_logits(batch, admitted).argmax(-1).flatten().tolist())
        decoded = decoded[:len(raw)]
        if any(value > 255 for value in decoded) or bytes(decoded) != raw:
            return None
        return json.loads(bytes(decoded))

    def answer(self, context, cue="", *, toward=None, after=None):
        fragment, shared = self.select(context, cue, toward=toward, after=after)
        if fragment is None:
            return {"status": "no_match"}
        result = self.read_result(fragment)
        if result is None:
            return {"status": "unverified"}
        return {"status": "grounded", "fragment_id": fragment.id, "action": fragment.action,
                "source": fragment.source, "answer": result, "linked_from": after, "shared_facts": shared}


def main():
    parser = ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("learn", "ask"))
    parser.add_argument("journal", type=Path)
    parser.add_argument("schema", type=Path)
    parser.add_argument("request", type=Path)
    parser.add_argument("--checkpoint", type=Path, default=DEFAULT_CHECKPOINT)
    parser.add_argument("--scope-field", action="append", default=[])
    parser.add_argument("--capacity", type=int, default=512)
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument("--check-cues", action="store_true",
                        help="Require agreement between the written request, its polarity and an explicit goal when asking")
    parser.add_argument("--ranker", type=Path, help="Supplement checked recall when both rankers agree on the winning fragment")
    review_modes = parser.add_mutually_exclusive_group()
    review_modes.add_argument("--reviewer", type=Path, help="Review the two best distinct cues with a matched local checkpoint")
    review_modes.add_argument("--veto-disagreement", action="store_true", help="Reject a selected cue when the action/object ranking disagrees")
    review_modes.add_argument("--compressed", type=Path, help="Recover complete observations from compressed units and clarify ambiguous objects")
    args = parser.parse_args()
    if args.compressed and (args.operation!="ask" or args.ranker or args.check_cues):
        parser.error("--compressed selects a complete ask mode and takes its own support checkpoint")
    if (args.reviewer or args.veto_disagreement) and args.ranker is None:
        parser.error("Review modes require --ranker")
    if (args.check_cues or args.ranker is not None) and args.operation != "ask":
        parser.error("--check-cues and --ranker apply to ask")
    torch.set_num_threads(2)
    fields, data = read_json(args.schema), read_json(args.request)
    options = {"scope_fields": args.scope_field, "capacity": args.capacity, "encoder": FragmentCueEncoder()}
    if args.operation == "learn":
        db = SemanticFragmentModel(args.journal, fields, create=True, policy=AssociationPolicy(1, 0, 0), **options)
        invoke = lambda item: {"fragment_id": db.learn(**item)}
    else:
        network, policy = load_model(args.checkpoint, args.device)
        memory_class = FourLayerMemory
        if args.compressed:
            from compressed_memory import CompressedMemory,compress_options
            memory_class=CompressedMemory
            options.update(compress_options(args.compressed,args.checkpoint,args.device))
        elif args.ranker is not None:
            from four_layer_role_memory import ConsensusMemory, ranking_options
            memory_class = ConsensusMemory
            options.update(ranking_options(args.ranker,args.checkpoint,args.device))
            if args.reviewer:
                from four_layer_pair_memory import ReviewedMemory, reviewer_options
                memory_class = ReviewedMemory
                options.update(reviewer_options(args.reviewer,args.checkpoint,args.ranker,args.device))
            elif args.veto_disagreement:
                from four_layer_pair_memory import VetoMemory
                memory_class = VetoMemory
        elif args.check_cues:
            from four_layer_joint_cues import JointCueMemory
            memory_class = JointCueMemory
        db = memory_class(args.journal, fields, network=network, policy=policy, **options)
        invoke = lambda item: db.answer(**item)
    reply = [invoke(row) for row in data] if type(data) is list else invoke(data)
    print(json.dumps(reply, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
