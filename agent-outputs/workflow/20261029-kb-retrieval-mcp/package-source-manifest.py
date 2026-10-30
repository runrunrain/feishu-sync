#!/usr/bin/env python3
"""Record production source/build inputs incl. untracked source and ignored build assets.
Run from repository root: python3 package-source-manifest.py OUTPUT.json
"""
import hashlib, json, os, subprocess, sys
roots=['src','electron','server/src','server/scripts','scripts','build','index.html','vite.config.ts','tsconfig.json','tsconfig.node.json','server/tsconfig.json','postcss.config.js','tailwind.config.js','package.json','package-lock.json','server/package.json','server/package-lock.json','electron-builder.config.cjs']
raw=subprocess.check_output(['git','ls-files','-co','--exclude-standard','-z','--',*roots]); paths={os.fsdecode(p) for p in raw.split(b'\0') if p}
# Build assets are deliberately ignored by Git but consumed directly by builder.
for base, dirs, files in os.walk('build'):
    for name in files: paths.add(os.path.join(base,name))
rows={}
for p in sorted(paths):
    if os.path.isfile(p):
        h=hashlib.sha256()
        with open(p,'rb') as f:
            for b in iter(lambda:f.read(1024*1024),b''): h.update(b)
        rows[p]=h.hexdigest()
text=json.dumps(rows,ensure_ascii=False,sort_keys=True,indent=2)+'\n'
with open(sys.argv[1],'w',encoding='utf8') as f:f.write(text)
print('paths',len(rows),'manifest_sha256',hashlib.sha256(text.encode()).hexdigest(),'output',sys.argv[1])
