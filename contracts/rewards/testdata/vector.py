import hashlib, json
def H(b): return hashlib.sha256(b).digest()
def leaf(stage, addr, amount):
    a = addr.encode()
    return H(b"qwakk-rewards-v1" + stage.to_bytes(8,"big") + bytes([len(a)]) + a + amount.to_bytes(16,"big"))
def node(x,y): return H(min(x,y)+max(x,y))
def build(leaves):
    levels=[sorted(leaves)]
    while len(levels[-1])>1:
        cur=levels[-1]; nxt=[]
        for i in range(0,len(cur),2):
            nxt.append(node(cur[i],cur[i+1]) if i+1<len(cur) else cur[i])
        levels.append(nxt)
    return levels
def proof(levels, l):
    p=[]; idx=levels[0].index(l)
    for lvl in levels[:-1]:
        sib = idx^1
        if sib < len(lvl): p.append(lvl[sib].hex())
        idx//=2
    return p
stage=1
entries=[("qor1wl5jxt3n5fxez4csxe7t67xcfyvxr69y3mn4dq",1000000),("qor1lndgla7rrh8cjq8enly3cldkaze3z2jupzakmp",2500000),("qor1x6jdvvyf3c3dahvw7ktcljx9ylgknpzkpsaxw2",7)]
ls={a:leaf(stage,a,m) for a,m in entries}
lv=build(list(ls.values()))
out={"stage":stage,"root":lv[-1][0].hex(),"claims":[{"address":a,"amount":str(m),"leaf":ls[a].hex(),"proof":proof(lv,ls[a])} for a,m in entries]}
# verify
for c in out["claims"]:
    h=bytes.fromhex(c["leaf"])
    for p in c["proof"]: h=node(h,bytes.fromhex(p))
    assert h.hex()==out["root"]
print(json.dumps(out,indent=1))
