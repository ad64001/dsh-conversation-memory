"""Append-only fragments with semantic cue association and exact readback."""
from dataclasses import dataclass
from pathlib import Path
import math

import numpy as np

from model import Association, FragmentModel, includes, read_json, similarity, sparse_address
from semantic_encoder import E5Encoder, PairReranker


POLICY_PATH = Path(__file__).resolve().parent / "semantic_policy.json"
MAX_RERANK_ACTIONS = 12


@dataclass(frozen=True)
class AssociationPolicy:
    semantic_weight: float
    min_score: float
    min_margin: float
    pair_weight: float = 0.0

    def __post_init__(self):
        for value in (self.semantic_weight, self.min_score, self.min_margin, self.pair_weight):
            if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value <= 1:
                raise ValueError("Association policy values must be finite scores in [0, 1]")

    @classmethod
    def load(cls, path=POLICY_PATH):
        return cls(**read_json(path)["policy"])


@dataclass(frozen=True)
class CueDecision:
    """An evidence summary. Outcome data is available only through associate()."""

    action: str | None
    score: float | None
    margin: float | None


class SemanticFragmentModel(FragmentModel):
    """Uses a local encoder to rank meanings, then applies the original memory gate."""

    def __init__(self, journal, fields, *, capacity=512, create=False,
                 scope_fields=(), encoder=None, reranker=None, policy=None):
        if len(set(scope_fields)) != len(scope_fields) or any(key not in fields for key in scope_fields):
            raise ValueError("Scope field names must be unique and declared in the schema")
        self.scope_fields = tuple(scope_fields)
        self.encoder = encoder if encoder is not None else E5Encoder()
        self.policy = policy if policy is not None else AssociationPolicy.load()
        self.reranker = reranker
        if self.policy.pair_weight and self.reranker is None:
            self.reranker = PairReranker()
        super().__init__(journal, fields, capacity=capacity, create=create)
        if any(not self._valid_scope(fragment.conditions, fragment.result)
               for fragment in self._fragments.values()):
            raise ValueError("Journal fragment lacks its declared scope or changes scope in its result")

    def _valid_scope(self, conditions, result):
        return (all(key in dict(conditions) for key in self.scope_fields) and
                not any(key in dict(result) for key in self.scope_fields))

    def learn(self, *, conditions, action, result, cue, source):
        if not self._valid_scope(self._facts(conditions), self._facts(result)):
            raise ValueError("Scoped fragments must declare their scope and preserve it")
        self.encoder.encode(cue)
        return super().learn(conditions=conditions, action=action, result=result, cue=cue, source=source)

    def _cue_components(self, cue, keys=None):
        if keys is not None and not keys:
            return
        query = self.encoder.encode(cue)
        lexical = sparse_address(cue)
        for fragment_id, fragment in self._fragments.items():
            if keys is not None and fragment_id not in keys:
                continue
            score = float(np.dot(query, self.encoder.encode(fragment.cue)))
            yield fragment_id, max(0.0, min(1.0, score)), similarity(lexical, self._addresses[fragment_id])

    def _rank_components(self, cue, keys):
        weight = self.policy.semantic_weight
        return sorted(
            ((key, round(weight * semantic + (1 - weight) * lexical, 6))
             for key, semantic, lexical in self._cue_components(cue, keys)),
            key=lambda pair: (-pair[1], pair[0]),
        )

    def _association_view(self, context, toward, after):
        view = dict(self._facts(context, allow_empty=True))
        context = view.copy()
        scope = tuple((key, context[key]) for key in self.scope_fields if key in context)
        target = self._facts(toward) if toward is not None else ()
        established = {}
        if len(scope) != len(self.scope_fields):
            return view, set(), established
        linked = None
        if after is not None:
            anchor = self._applicable(context).get(after)
            if anchor is None:
                return view, set(), established
            linked = set()
            for key, value in anchor.result:
                if not includes(context, ((key, value),)):
                    established[key] = value
                    linked.update(self._requires.get((key, type(value), value), ()))
            linked.discard(after)
            view.update(anchor.result)
        candidates = {
            fragment.id for fragment in self._fragments.values()
            if includes(dict(fragment.conditions), scope)
            and includes(dict(fragment.result), target)
            and (linked is None or fragment.id in linked)
        }
        return view, candidates, established

    def _competing_ids(self, context, toward, after):
        return self._association_view(context, toward, after)[1]

    def _decision_from_ranking(self, cue, ranking):
        best_by_action = {}
        for key, score in ranking:
            best_by_action.setdefault(self._fragments[key].action, (key, score))
            if len(best_by_action) == MAX_RERANK_ACTIONS:
                break
        pair_weight = self.policy.pair_weight
        ordered = []
        for action, (key, score) in best_by_action.items():
            if pair_weight:
                pair = self.reranker.score(cue, self._fragments[key].cue)
                score = round(pair_weight * pair + (1.0 - pair_weight) * score, 6)
            ordered.append((action, score))
        ordered.sort(key=lambda pair: (-pair[1], pair[0]))
        if not ordered:
            return CueDecision(None, None, None)
        action, score = ordered[0]
        margin = round(score - ordered[1][1], 6) if len(ordered) > 1 else 1.0
        return CueDecision(action, score, margin)

    def cue_decision(self, context, cue, *, toward=None, after=None):
        relevant = self._competing_ids(context, toward, after)
        return self._decision_from_ranking(cue, self._rank_components(cue, relevant))

    def associate(self, context, cue="", *, toward=None, after=None, limit=6):
        if type(cue) is not str or len(cue) > 512:
            raise ValueError("Cue must be a short string")
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError("Expected association limit between 1 and 64")
        if not cue.strip():
            return super().associate(context, "", toward=toward, after=after, limit=limit)
        view, relevant, established = self._association_view(context, toward, after)
        ranking = self._rank_components(cue, relevant)
        decision = self._decision_from_ranking(cue, ranking)
        if (decision.action is None or decision.score < self.policy.min_score
                or decision.margin <= self.policy.min_margin):
            return []
        # The winning meaning is selected within the declared scope. If its
        # facts are inapplicable, an unrelated eligible action must not replace it.
        eligible = self._applicable(view)
        rows = []
        for key, _ in ranking:
            fragment = eligible.get(key)
            if fragment is not None and fragment.action == decision.action:
                shared = tuple((key, value) for key, value in fragment.conditions
                               if includes(established, ((key, value),)))
                rows.append(Association(fragment.id, fragment.action, decision.score,
                                        fragment.conditions, fragment.result, after, shared))
                if len(rows) == limit:
                    break
        return rows


def main():
    import argparse
    import json
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("learn", "associate"))
    parser.add_argument("journal", type=Path)
    parser.add_argument("schema", type=Path)
    parser.add_argument("request", type=Path)
    parser.add_argument("--capacity", type=int, default=512)
    parser.add_argument("--scope-field", action="append", default=[])
    args = parser.parse_args()
    model = SemanticFragmentModel(
        args.journal, read_json(args.schema), capacity=args.capacity, scope_fields=args.scope_field,
        create=args.operation == "learn",
    )
    request = read_json(args.request)
    if args.operation == "learn":
        result = {"fragment_id": model.learn(**request), "count": model.count, "head": model.head}
    else:
        result = [row.to_dict() for row in model.associate(**request)]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
