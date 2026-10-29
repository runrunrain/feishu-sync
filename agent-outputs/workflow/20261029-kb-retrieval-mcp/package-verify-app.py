#!/usr/bin/env python3
"""Compare app bundle to a saved path/type/mode/content manifest."""
import hashlib, json, os, stat, sys
root=sys.argv[1]
expected=json.load(open(sys.argv[2],encoding='utf8'))
rows=[]; total=0
for base, dirs, files in os.walk(root, followlinks=False):
    for name in sorted(dirs+files):
        p=os.path.join(base,name); rel=os.path.relpath(p,root); st=os.lstat(p)
        if stat.S_ISLNK(st.st_mode): rows.append(['link',rel,os.readlink(p)])
        elif stat.S_ISDIR(st.st_mode): rows.append(['dir',rel,oct(st.st_mode&0o7777)])
        elif stat.S_ISREG(st.st_mode):
            h=hashlib.sha256()
            with open(p,'rb') as f:
                for b in iter(lambda:f.read(1048576),b''): h.update(b)
            total+=st.st_size; rows.append(['file',rel,oct(st.st_mode&0o7777),st.st_size,h.hexdigest()])
rows.sort(key=lambda x:x[1]); digest=hashlib.sha256((json.dumps(rows,ensure_ascii=False,separators=(',',':'))+'\n').encode()).hexdigest()
a={x[1]:x for x in expected}; b={x[1]:x for x in rows}; changes=[p for p in sorted(a.keys()|b.keys()) if a.get(p)!=b.get(p)]
print('app',root,'entries',len(rows),'regular_bytes',total,'manifest_sha256',digest,'differences',len(changes))
for p in changes[:20]: print('DIFF',p,'expected',a.get(p),'actual',b.get(p))
if changes: sys.exit(1)
