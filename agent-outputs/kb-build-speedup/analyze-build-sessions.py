import json,glob,sys,re,collections,datetime,os
def P(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
def analyze(b):
    root=os.path.expanduser('~/.feishu-sync/agent/builds/%s/epochs'%b)
    lead=[f for f in glob.glob(root+'/e*/home/sessions/2026*.jsonl')]
    work=glob.glob(root+'/e*/home/sessions/--*/*.jsonl')
    print('==',b,'leader sessions',len(lead),'worker sessions',len(work))
    sub=collections.Counter(); first=None;last=None
    for f in lead:
        for l in open(f):
            d=json.loads(l)
            if d.get('type')=='message' and d['message']['role']=='assistant':
                for c in d['message']['content']:
                    if c.get('type')=='toolCall' and c['name'] in('task_submit','task_resume'):
                        a=c['arguments']; sub[(c['name'],a.get('agent') or 'resume')]+=1
    print(' dispatch',dict(sub))
    errs=collections.Counter(); ex={}
    outtok=0
    for f in work+lead:
        L=[json.loads(l) for l in open(f)]
        idmap={}
        for d in L:
            if d.get('type')!='message':continue
            m=d['message']
            if m['role']=='assistant':
                outtok+=m.get('usage',{}).get('output',0)
                for c in m['content']:
                    if c.get('type')=='toolCall': idmap[c['id']]=c['arguments'].get('tool') or c['name']
            elif m['role']=='toolResult':
                txt=''.join(x.get('text','') for x in m['content'] if x.get('type')=='text')
                if m.get('isError') or re.match(r'\s*(invalid_request|kb_[a-z_]+|not_found|Validation failed|\[amagi-mcp\]|child-policy)',txt):
                    k=(idmap.get(m.get('toolCallId'),m.get('toolName')),re.sub(r'\d+','N',txt[:70]))
                    errs[k]+=1; ex.setdefault(k,txt[:240].replace('\n',' '))
    print(' total output tokens',outtok)
    for k,v in errs.most_common(14): print('  ',v,k[0],'|',ex[k][:200])
for b in sys.argv[1:]: analyze(b)
