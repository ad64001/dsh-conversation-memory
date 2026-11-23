"""Run the frozen guided reader on the active, source-cited SQLite snapshot."""
import json
import sys
from pathlib import Path

import torch
from guided_recall import open_memory

WEIGHTS = Path(__file__).resolve().parent / "weights"
TYPES = {bool: "bool", int: "int", str: "str"}


def encode_facts(values, fields):
    encoded = {}
    for key, value in values.items():
        kind = TYPES[type(value)]
        name = kind + ":" + key
        fields[name] = kind
        encoded[name] = value
    return encoded


def decode_facts(values):
    return {key.split(":", 1)[1]: value for key, value in values.items() if ":" in key}


def answer(payload):
    query = payload["query"]
    fields = {"session": "str", "scope": "str"}
    scope = {"session": payload["session"], "scope": query["scope"]}
    observations = []
    for row in payload["rows"]:
        observations.append(dict(conditions={**scope, **encode_facts(row["conditions"], fields)},
                                 action=row["action"], result=encode_facts(row["result"], fields),
                                 cue=row["cue"], source=str(row["ref"])))
    context = {**scope, **encode_facts(query.get("context", {}), fields)}
    toward = encode_facts(query["toward"], fields) if "toward" in query else None
    args = dict(context=context, cue=query.get("cue", ""), toward=toward, after=query.get("after"))
    memory = open_memory(None, fields, scope_fields=tuple(scope), capacity=max(1, len(observations)),
                         checkpoint=WEIGHTS / "four_layer.pt", support=WEIGHTS / "support.pt",
                         ranker=WEIGHTS / "ranker.pt", reviewer=WEIGHTS / "reviewer.pt",
                         confirm_unseen=False, create=True)
    memory.confirm_unseen = True
    for observation in observations:
        memory.learn(**observation)
    if args["after"]:
        anchor = memory._applicable(context).get(args["after"])
        if anchor:
            established = decode_facts(dict(anchor.result))
            for key, value in query.get("context", {}).items():
                if key in established and (type(value) is not type(established[key]) or value != established[key]):
                    if query.get("browse"):
                        return {"status": "inventory", "options": [], "total": 0, "nextOffset": None}
                    return {"status": "no_match", "reason": "invalid_choice" if query.get("confirm") else "blocked"}
    reply = memory.answer(**args, browse=query.get("browse", False), confirm=query.get("confirm"))
    if reply["status"] == "no_match" and args["cue"] and not query.get("confirm") and reply.get("can_browse") and len(observations) > 1:
        # ReviewedMemory normally replays the disk journal. Here both readers
        # receive the same immutable SQLite snapshot, including source refs.
        checked = memory.checked
        for observation in observations:
            checked.learn(**observation)
        selected, _ = checked.select(**args)
        if selected:
            available, _ = memory._inventory(context, args["cue"], toward, args["after"])
            for token, unit in available.items():
                if any(link[0] == selected.id for link in unit.links):
                    options = reply.setdefault("suggestions", [])
                    if all(item["token"] != token for item in options):
                        options.append(memory._option(token, unit))
                    break
    for field in ("answer", "conditions", "shared_facts"):
        if field in reply:
            reply[field] = decode_facts(reply[field])
    # Page both inventories and provenance. Full text is available by stable ref.
    start = query.get("offset", 0)
    for name in ("options", "suggestions", "observations"):
        if name in reply:
            rows = reply[name]
            reply["total"] = len(rows)
            reply[name] = rows[start:start + 12]
            reply["nextOffset"] = start + 12 if len(rows) > start + 12 else None
            for item in reply[name]:
                if "conditions" in item:
                    item["conditions"] = decode_facts(item["conditions"])
                    item["cueCount"] = len(item["cues"])
                    item["cues"] = item["cues"][:3]
    return reply


if __name__ == "__main__":
    torch.set_num_threads(2)
    print(json.dumps(answer(json.load(sys.stdin)), ensure_ascii=True, allow_nan=False))
