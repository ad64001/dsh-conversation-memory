"""Action/argument separation features from the explicit training glosses."""
from functools import lru_cache
import math
import re


class ActionFeatures:
    def __init__(self, groups):
        self.groups = [[(re.compile(".{0,10}?".join(map(re.escape, term.split("~")))),
                         min(3, len(term.replace("~", "")))) for term in group] for group in groups]
        self.describe = lru_cache(maxsize=2048)(self._describe)

    def _describe(self, text):
        # Completed preambles are common in spoken commands.
        clauses = re.split("[，,；;。]", text)
        if len(clauses) == 2 and re.search("已经|早已|刚刚|不用|无需", clauses[0]) and clauses[1].strip():
            text = clauses[1]
        modes = [max((weight for pattern, weight in group if pattern.search(text)), default=0)
                 for group in self.groups]
        negative = bool(re.search("先别|不要|不用|不必|别再|暂缓|禁止", text))
        return tuple(modes), negative

    def pair(self, query, cue):
        a, neg_a = self.describe(query)
        b, neg_b = self.describe(cue)
        left, right = sum(x*x for x in a), sum(x*x for x in b)
        both = bool(left and right)
        shared = sum(x*y for x, y in zip(a, b)) / math.sqrt(left*right) if both else 0.
        return [shared, float(both) - shared, float(bool(left) and not right),
                float(bool(right) and not left), float(neg_a != neg_b)]
