"""An append-only fragment model with typed associative recall."""
from __future__ import annotations

from dataclasses import dataclass, asdict
import hashlib
import json
import math
import os
from pathlib import Path
import re
import tempfile
import unicodedata

Scalar = str | int | bool
Facts = tuple[tuple[str, Scalar], ...]
TYPE = {"str": str, "int": int, "bool": bool}
ZERO = "0" * 64
INDEX_BITS = 2048
MIN_SIMILARITY = 0.18


def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def digest(value):
    return hashlib.sha256(encode(value)).hexdigest()


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def read_json(path):
    def unique_keys(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError(f"Duplicate field {key}")
            result[key] = value
        return result

    def reject_constant(value):
        raise ValueError(f"Invalid JSON number {value}")

    return json.loads(Path(path).read_bytes(), object_pairs_hook=unique_keys,
                      parse_constant=reject_constant)


def write_new(path, value):
    """Publish complete bytes exclusively; a stale writer cannot replace a record."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".pending-")
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(encode(value) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == "nt":
            os.rename(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def sparse_address(text):
    tokens = re.findall(r"[^\W_]+", unicodedata.normalize("NFKC", text).casefold())
    features = {f"word:{word}" for word in tokens}
    for word in tokens:
        padded = f"^{word}$"
        for width in (2, 3):
            features.update(f"{width}:{padded[i:i + width]}"
                            for i in range(len(padded) - width + 1))
    address = 0
    for feature in features:
        bits = hashlib.blake2b(feature.encode("utf-8"), digest_size=4).digest()
        for i in (0, 2):
            address |= 1 << (int.from_bytes(bits[i:i+2], "big") % INDEX_BITS)
    return address


def similarity(left, right):
    size = left.bit_count() * right.bit_count()
    return (left & right).bit_count() / math.sqrt(size) if size else 0.0


def includes(context, conditions):
    return all(key in context and type(context[key]) is type(value) and context[key] == value
               for key, value in conditions)


@dataclass(frozen=True)
class Fragment:
    id: str
    conditions: Facts
    action: str
    result: Facts
    cue: str
    source: str


@dataclass(frozen=True)
class Association:
    fragment_id: str
    action: str
    score: float
    conditions: Facts
    result: Facts
    linked_from: str | None = None
    shared_facts: Facts = ()

    def to_dict(self):
        return asdict(self)


class FragmentModel:
    """Learn facts as records and associate them with cues in a typed context."""

    def __init__(self, journal, fields, *, capacity=512, create=False):
        if (type(fields) is not dict or not fields or
                any(type(key) is not str or not key or type(kind) is not str or kind not in TYPE
                    for key, kind in fields.items())):
            raise ValueError("Expected a schema of named str, int or bool fields")
        if type(capacity) is not int or capacity < 1:
            raise ValueError("Capacity must be a positive integer")
        self.path = None if journal is None else Path(journal)
        self._fields = dict(fields)
        self.capacity = capacity
        self._fragments: dict[str, Fragment] = {}
        self._addresses: dict[str, int] = {}
        self._requires: dict[tuple, set[str]] = {}
        self._head = ZERO
        self._count = 0
        metadata = {"schema": "fragment-model-v1", "fields": self._fields, "capacity": capacity}
        self._binding = digest(metadata)
        if self.path is None:
            return
        config = self.path / "schema.json"
        if create and not config.exists():
            try:
                write_new(config, metadata)
            except FileExistsError:
                pass
        if read_json(config) != metadata:
            raise ValueError("Journal schema or capacity differs")
        self._replay()

    @property
    def head(self):
        return self._head

    @property
    def count(self):
        return self._count

    def _facts(self, values, *, allow_empty=False) -> Facts:
        if type(values) is not dict or (not allow_empty and not values):
            raise ValueError("Expected named typed facts")
        for key, value in values.items():
            if key not in self._fields or type(value) is not TYPE[self._fields[key]]:
                raise ValueError(f"Unknown field or wrong type: {key}")
            if type(value) is str and (not value or len(value) > 256):
                raise ValueError(f"Unsupported text fact: {key}")
        return tuple(sorted(values.items()))

    def _decode(self, evidence):
        if type(evidence) is not dict or set(evidence) != {
                "conditions", "action", "result", "cue", "source"}:
            raise ValueError("A fragment needs conditions, action, result, cue and source")
        for key, limit in (("action", 128), ("cue", 512), ("source", 256)):
            value = evidence[key]
            if type(value) is not str or not value.strip() or len(value) > limit:
                raise ValueError(f"Invalid {key}")
        conditions = self._facts(evidence["conditions"])
        result = self._facts(evidence["result"])
        return Fragment(digest(evidence), conditions, evidence["action"], result,
                        evidence["cue"], evidence["source"])

    def _publish(self, fragment, head):
        self._fragments[fragment.id] = fragment
        self._addresses[fragment.id] = sparse_address(fragment.cue)
        for field, value in fragment.conditions:
            self._requires.setdefault((field, type(value), value), set()).add(fragment.id)
        self._head = head
        self._count += 1

    def _replay(self):
        for path in sorted(self.path.glob("*.fragment.json")):
            index = self._count + 1
            record = read_json(path)
            if (set(record) != {"index", "schema", "previous", "fragment", "sha256"} or
                    path.name != f"{index:08d}.fragment.json" or record["index"] != index or
                    record["schema"] != self._binding or record["previous"] != self._head):
                raise ValueError("Broken fragment journal sequence")
            head = record.pop("sha256")
            fragment = self._decode(record["fragment"])
            if (digest(record) != head or fragment.id in self._fragments or index > self.capacity):
                raise ValueError("Invalid fragment journal record")
            self._publish(fragment, head)

    def learn(self, *, conditions, action, result, cue, source):
        evidence = dict(conditions=conditions, action=action, result=result, cue=cue, source=source)
        fragment = self._decode(evidence)
        if fragment.id in self._fragments:
            return fragment.id
        if self.count == self.capacity:
            raise ValueError("Fragment capacity reached")
        index = self._count + 1
        body = dict(index=index, schema=self._binding, previous=self._head, fragment=evidence)
        head = digest(body)
        if self.path is not None:
            write_new(self.path / f"{index:08d}.fragment.json", dict(**body, sha256=head))
        self._publish(fragment, head)
        return fragment.id

    def _rank(self, cue):
        if type(cue) is not str or len(cue) > 512:
            raise ValueError("Cue must be a short string")
        address = sparse_address(cue)
        return sorted(((key, similarity(address, code)) for key, code in self._addresses.items()),
                      key=lambda item: (-item[1], item[0]))

    def _applicable(self, context):
        by_action = {}
        for fragment in self._fragments.values():
            if includes(context, fragment.conditions):
                by_action.setdefault(fragment.action, []).append(fragment)
        allowed = {}
        for group in by_action.values():
            if len({fragment.result for fragment in group}) == 1:
                allowed.update((fragment.id, fragment) for fragment in group)
        return allowed

    def associate(self, context, cue="", *, toward=None, after=None, limit=6):
        """Recall usable fragments, optionally by exact result or typed continuation."""
        if type(limit) is not int or not 1 <= limit <= 64:
            raise ValueError("Expected association limit between 1 and 64")
        context = dict(self._facts(context, allow_empty=True))
        goal = self._facts(toward) if toward is not None else ()
        ranking = self._rank(cue)
        applicable = self._applicable(context)
        related_ids = None
        established = {}
        if after is not None:
            source = applicable.get(after)
            if source is None:
                return []
            established = {key: value for key, value in source.result
                           if not includes(context, ((key, value),))}
            context.update(source.result)
            applicable = self._applicable(context)
            related_ids = set()
            for key, value in established.items():
                related_ids.update(self._requires.get((key, type(value), value), ()))
            related_ids.discard(after)

        results = []
        for key, score in ranking:
            fragment = applicable.get(key)
            if fragment is None or (related_ids is not None and key not in related_ids):
                continue
            if cue.strip() and score < MIN_SIMILARITY:
                break
            if not includes(dict(fragment.result), goal):
                continue
            shared = tuple((field, value) for field, value in fragment.conditions
                           if includes(established, ((field, value),)))
            results.append(Association(key, fragment.action, score, fragment.conditions,
                                       fragment.result, after, shared))
            if len(results) == limit:
                break
        return results


def main():
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("learn", "associate"))
    parser.add_argument("journal", type=Path)
    parser.add_argument("schema", type=Path, help="JSON object mapping fields to str, int or bool")
    parser.add_argument("request", type=Path, help="JSON arguments to the model operation")
    parser.add_argument("--capacity", type=int, default=512)
    args = parser.parse_args()
    model = FragmentModel(args.journal, read_json(args.schema), capacity=args.capacity,
                          create=args.operation == "learn")
    request = read_json(args.request)
    if args.operation == "learn":
        result = {"fragment_id": model.learn(**request), "count": model.count, "head": model.head}
    else:
        result = [row.to_dict() for row in model.associate(**request)]
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
