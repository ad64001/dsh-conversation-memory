"""Pack typed fragment observations losslessly and rebuild their original journal in order."""
from argparse import ArgumentParser
from dataclasses import dataclass,field
from pathlib import Path
import os
from tempfile import TemporaryDirectory

from model import Fragment,FragmentModel,digest,encode,read_json,write_new


@dataclass
class Unit:
    conditions: tuple
    action: str
    result: tuple
    links: list=field(default_factory=list)

    @property
    def forms(self):
        return tuple(dict.fromkeys(cue for _,cue,_ in self.links))

    def restore(self,link):
        key,cue,source=link
        original=dict(conditions=dict(self.conditions),action=self.action,result=dict(self.result),cue=cue,source=source)
        if digest(original)!=key:
            raise ValueError("Compressed observation failed its original fragment digest")
        return Fragment(key,self.conditions,self.action,self.result,cue,source)


class CompressedIndex:
    def __init__(self,fragments):
        self.units=[]
        self.by_id={}
        semantics={}
        for record in fragments:
            key=(record.conditions,record.action,record.result)
            if key not in semantics:
                semantics[key]=len(self.units)
                self.units.append(Unit(*key))
            number=semantics[key]
            unit=self.units[number]
            self.by_id[record.id]=(number,len(unit.links))
            unit.links.append((record.id,record.cue,record.source))

    def restore(self,key):
        number,entry=self.by_id[key]
        unit=self.units[number]
        return unit.restore(unit.links[entry])

    def pack(self,schema,head):
        conditions=list(dict.fromkeys(u.conditions for u in self.units))
        results=list(dict.fromkeys(u.result for u in self.units))
        cond_id={v:n for n,v in enumerate(conditions)}
        res_id={v:n for n,v in enumerate(results)}
        entries=[]
        for number,slot in self.by_id.values():
            _,cue,source=self.units[number].links[slot]
            entries.append([number,cue,source])
        body={"format":"fragment-semantic-pack-v1","schema":schema,"head":head,"conditions":[dict(c) for c in conditions],
              "results":[dict(r) for r in results],"units":[[cond_id[u.conditions],u.action,res_id[u.result]] for u in self.units],
              "observations":entries}
        return {**body,"checksum":digest(body)}


def pack_journal(journal,target):
    schema=read_json(journal/"schema.json")
    db=FragmentModel(journal,schema["fields"],capacity=schema["capacity"])
    idx=CompressedIndex(db._fragments.values())
    package=idx.pack(schema,db.head)
    write_new(target,package)
    return {"observations":db.count,"units":len(idx.units),"head":db.head,"package_bytes":target.stat().st_size}


def restore_journal(package,target):
    doc=read_json(package)
    if not isinstance(doc,dict) or doc.pop("checksum",None)!=digest(doc) or doc.get("format")!="fragment-semantic-pack-v1":
        raise ValueError("Invalid fragment package or checksum")
    if target.exists():
        raise FileExistsError(target)
    target.parent.mkdir(parents=True,exist_ok=True)
    def entry(table,n):
        if type(n) is not int or not 0<=n<len(table):
            raise ValueError("Invalid reference in fragment package")
        return table[n]
    schema=doc["schema"]
    with TemporaryDirectory(prefix=".fragment-restore-",dir=target.parent) as tmp:
        staged=Path(tmp)/"journal"
        db=FragmentModel(staged,schema["fields"],capacity=schema["capacity"],create=True)
        if schema!=read_json(staged/"schema.json"):
            raise ValueError("Unsupported schema in fragment package")
        for unit,cue,source in doc["observations"]:
            cond,action,result=entry(doc["units"],unit)
            db.learn(conditions=entry(doc["conditions"],cond),action=action,result=entry(doc["results"],result),
                     cue=cue,source=source)
        if db.count!=len(doc["observations"]) or db.head!=doc["head"]:
            raise ValueError("Restored sequence does not match its original journal head")
        if target.exists():
            raise FileExistsError(target)
        os.rename(staged,target)
    return {"observations":db.count,"head":db.head}


if __name__=="__main__":
    ap=ArgumentParser(description=__doc__)
    ap.add_argument("operation",choices=("pack","unpack"))
    ap.add_argument("source",type=Path)
    ap.add_argument("target",type=Path)
    a=ap.parse_args()
    print(encode((pack_journal if a.operation=="pack" else restore_journal)(a.source,a.target)).decode("utf8"))
