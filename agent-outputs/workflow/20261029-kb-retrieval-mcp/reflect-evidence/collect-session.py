#!/usr/bin/env python3
"""Read-only historical JSONL projection. Never exports raw stdout, headers or thinking.
Run from the repo root; output is scoped to this approved reflect directory.
"""
import argparse, collections, datetime, hashlib, json, os, pathlib, re
p=argparse.ArgumentParser();p.add_argument('--session',default=os.environ.get('PI_SESSION_FILE'));p.add_argument('--out',default='agent-outputs/workflow/20261029-kb-retrieval-mcp/reflect-evidence');a=p.parse_args()
rows=[json.loads(line) for line in open(a.session,encoding='utf8')]
def txt(x):
 c=x.get('content',[])
 return c if isinstance(c,str) else '\n'.join(v.get('text','') for v in c if isinstance(v,dict) and v.get('type')=='text')
def clean(s):
 s=re.sub(r'fskb_[A-Za-z0-9_-]+','[REDACTED_KB_TOKEN]',str(s))
 s=re.sub(r'(?i)(Bearer\s+)[^\s\"\x27]+',r'\1[REDACTED]',s)
 s=re.sub(r'(?i)((?:desktopToken|apiKey|app_secret|authorization)[\"\x27]?\s*[:=]\s*)[\"\x27][^\"\x27\n]*[\"\x27]',r'\1"[REDACTED]"',s)
 return s
cut=next(i for i,r in enumerate(rows,1) if r.get('message',{}).get('role')=='user' and txt(r['message']).startswith('# 会话插件反思沉淀'))
scope=list(enumerate(rows[:cut-1],1)); calls={}; counts=collections.Counter(); errors=[]; nested=collections.Counter(); nested_status=collections.Counter(); nested_n=0; results=[]; notice=[]; pushes=[]; api_errors=[]; operations=[]; structured_tasks={}
for line,r in scope:
 m=r.get('message',{});role=m.get('role');t=txt(m)
 if role=='assistant':
  for c in m.get('content',[]) if isinstance(m.get('content'),list) else []:
   if c.get('type')=='toolCall':calls[c['id']]={'line':line,'timestamp':r.get('timestamp'),'name':c['name'],'args':c.get('arguments',{})}
  if m.get('stopReason')=='error':api_errors.append({'line':line,'timestamp':r.get('timestamp'),'error':clean(m.get('errorMessage',''))[:200]})
 if role=='toolResult':
  name=m.get('toolName');counts[name]+=1;call=calls.get(m.get('toolCallId'),{});args=call.get('args',{});d=m.get('details') or {}
  result={'line':line,'callLine':call.get('line'),'timestamp':r.get('timestamp'),'name':name,'isError':bool(m.get('isError')),'durationMs':m.get('durationMs'),'code':d.get('code')}
  if m.get('isError'):
   # Error fragments only; never copy a whole failed command's output.
   chosen=next((v for v in t.splitlines() if any(z in v for z in ['[ContractError','[amagi edit','Command exited with','Offset ','Could not locate','Cannot find','Error:'])),t.splitlines()[0] if t else '')
   result['errorSummary']=clean(chosen)[:400]
   if name=='bash':result['commandSummary']=clean(args.get('command','').splitlines()[0])[:180]
   errors.append(result.copy())
  nc=(m.get('nestedCalls') or {}).get('calls',[])
  for x in nc:
   nested[x['name']]+=1;nested_status[x.get('status')]+=1;nested_n+=1
  if name in ['task_submit','task_resume','task_control','run_bg']:
   op={'line':line,'callLine':call.get('line'),'timestamp':r.get('timestamp'),'tool':name,'action':args.get('action'),'error':bool(m.get('isError')),'code':d.get('code'),'taskId':d.get('taskId'),'execution':d.get('execution'),'agent':args.get('agent'),'handle':args.get('handle'),'handlesCount':len(args.get('handles') or []),'durationMs':m.get('durationMs')}
   if name=='task_submit':op.update(contextMode=args.get('contextMode'),workspaceMode=(args.get('workspace') or {}).get('mode'),hasModelOverride='model' in args,hasProfileOverride=bool(args.get('profile')))
   if name=='run_bg' and args.get('action')=='start':op['label']=args.get('label')
   operations.append(op)
  if name=='bash' and re.search(r'git push origin main',args.get('command','')):pushes.append(result.copy())
  results.append(result)
 if r.get('type')=='custom_message':
  ct=r.get('customType');body=str(r.get('content',''))
  if ct in ['amagi:guard-note','amagi:compact-continuation','amagi:run-bg','amagi:recovery']:
   notice.append({'line':line,'timestamp':r.get('timestamp'),'type':ct,'summary':clean(body[:380]),'failedBackground':bool(ct=='amagi:run-bg' and '→ failed' in body)})
 if role=='user' and t.strip()=='合并到main后推送':notice.append({'line':line,'timestamp':r.get('timestamp'),'type':'push-user-prompt'})
# Completion notifications are a separate observed channel, not task-query snapshots.
notifications=[]
for line,r in scope:
 m=r.get('message',{});t=txt(m)
 if m.get('role')=='user' and (t.startswith('[task_submit 完成') or t.startswith('[task_resume 完成')):
  notifications.append({'line':line,'timestamp':r.get('timestamp'),'header':clean(t.splitlines()[0]),'missingMarker':'[完成契约缺失]' in t,'autoUnavailableIds':sorted(set(re.findall(r'chk-auto-baseline-test-[0-9a-f]+',t))),'execution':re.search(r'execution=(\w+)',t).group(1) if re.search(r'execution=(\w+)',t) else None,'taskId':re.search(r'taskId=([0-9a-f-]{36})',t).group(1) if re.search(r'taskId=([0-9a-f-]{36})',t) else None})
# Notifications use short handles. Resolve them against actual successful dispatch IDs.
known_ids={o['taskId'] for o in operations if o.get('taskId') and o['tool'] in ['task_submit','task_resume'] and not o['error']}
for n in notifications:
 match=re.search(r'完成 \w+/([0-9a-f]{8})',n['header'])
 if match and not n['taskId']:
  found=[v for v in known_ids if v.startswith(match.group(1))]
  n['taskId']=found[0] if len(found)==1 else None
# Nested result outputs can include additional checks/decisions. Store only IDs, never body.
auto_checks=set();accepts=0;waiver_mentions=0
for _,r in scope:
 m=r.get('message',{});t=txt(m)
 auto_checks.update(re.findall(r'chk-auto-baseline-test-[0-9a-f]+',t))
 if m.get('role')=='toolResult':
  accepts+=len(re.findall(r'\[task_control accept [^\]]+\] acceptance=accepted',t))
  if 'waivedCheckIds' in t:waiver_mentions+=1
stats={'scope':{'session':a.session,'cutoffExclusiveLine':cut,'lastIncludedLine':cut-1,'firstTimestamp':rows[0].get('timestamp'),'lastHistoricalTimestamp':rows[cut-2].get('timestamp'),'rawEntryCount':cut-1,'excludesReflect':True,'scopePrefixSha256':hashlib.sha256(b''.join(pathlib.Path(a.session).read_bytes().splitlines(keepends=True)[:cut-1])).hexdigest(),'lastHistoricalMessageTimestamp':next(r.get('timestamp') for _,r in reversed(scope) if r.get('type')=='message')},'topLevelToolResults':dict(sorted(counts.items())),'topLevelTotal':sum(counts.values()),'topLevelErrors':len(errors),'nestedCalls':dict(sorted(nested.items())),'nestedStatus':dict(nested_status),'nestedTotal':nested_n,'failureByTool':dict(collections.Counter(e['name'] for e in errors)),'providerErrors':api_errors,'completionNotifications':len(notifications),'missingMarkerNotifications':sum(x['missingMarker'] for x in notifications),'uniqueAutoCheckIdsObserved':len(auto_checks),'observedAcceptedResponseOccurrences':accepts,'pushCommandResults':pushes,'sourceVersionNote':'Session header version=3 is Pi format, not amagi version. Collection-time package version must not be called historical runtime version.'}
out=pathlib.Path(a.out);out.mkdir(parents=True,exist_ok=True)
for name,data in [('session-metrics.json',stats),('friction-events.json',{'errors':errors,'operations':operations,'notices':notice,'completionNotifications':notifications})]:
 payload=json.dumps(data,ensure_ascii=False,indent=2 if name=='session-metrics.json' else None)+'\n';(out/name).write_text(payload,encoding='utf8');print(name,len(payload.encode()))
print(json.dumps(stats,ensure_ascii=False,indent=2))
print('failures',json.dumps(errors,ensure_ascii=False,indent=2))

# Focused reproduction data: allowlisted historical error/control text only.
def entry(line):return rows[line-1]
cases={}
for label,lines in [('model-registry',[31,140,257,379]),('selected-context',[494]),('terminal-control-misuse',[792])]:
 cases[label]=[{'line':i,'timestamp':entry(i).get('timestamp'),'text':clean(txt(entry(i).get('message',{})))[:2400]} for i in lines]
raw=txt(entry(381)['message']);before_hint=raw.split('[AMAGI Bash')[0]
cases['bash-diagnostic']={'line':381,'rawBeforeHint':clean(before_hint),'hasNamesSeenInRaw':'Names seen' in before_hint,'hintClaimsNamesSeen':'Names seen 已列出' in raw,'hint':clean(raw[len(before_hint):])}
continuation=entry(794)
prior=[]
for line,r in scope:
 if line>=794:break
 t=txt(r.get('message',{}))
 if r.get('message',{}).get('role')=='toolResult' and 'b7a9eab9' in t and 'acceptance=accepted' in t:
  pos=t.find('b7a9eab9');prior.append({'line':line,'timestamp':r.get('timestamp'),'projection':clean(t[max(0,pos-50):pos+500])})
cases['stale-continuation']={'line':794,'timestamp':continuation.get('timestamp'),'text':clean(str(continuation.get('content','')))[:650],'priorTerminalEvidence':prior,'extraFinalLine':{'line':795,'timestamp':entry(795).get('timestamp'),'text':clean(txt(entry(795).get('message',{})))}}
cases['provider-transport']={'errors':api_errors,'pushUserPrompts':[n for n in notice if n['type']=='push-user-prompt'],'successfulPushToolResults':pushes,'successfulPushFinalTimestamp':entry(840).get('timestamp'),'note':'Transport/provider/SDK cause not proven by generic error strings; not called an amagi transport bug.'}
metas=[];missing_versions=0
for tid in sorted(known_ids):
 f=pathlib.Path('/Users/run.mao/.pi/agent/amagi/artifacts')/tid/'metadata.json'
 if not f.exists():continue
 d=json.loads(f.read_text());missing_versions+=not any(k in d for k in ['pluginVersion','amagiVersion','harnessVersion'])
 metas.append({k:d.get(k) for k in ['taskId','agent','status','blocked','startedAt','endedAt','outputBytes']})
package=pathlib.Path('/Users/run.mao/workpace/amagi-pi/package.json')
cases['version-observability']={'sessionHeaderFields':list(rows[0]),'sessionFormatVersion':rows[0].get('version'),'artifactMetadataInspected':len(metas),'artifactMetadataWithoutPluginVersion':missing_versions,'collectionRepositoryPackageVersion':json.loads(package.read_text()).get('version'),'repositoryPackagePath':str(package),'notRuntimeAttestation':True}
cases['auto-verification']={'uniqueAutoCheckIds':sorted(auto_checks),'taskSnapshotFile':'task-snapshot.json','missingMarkerNotifications':[n for n in notifications if n['missingMarker']],'note':'incomplete/unavailable is honest missing evidence, not a failing product test or fake done.'}
cases['dependency-reuse']={'source':'stage-d-fixes.md and immutable task metadata','blockedTask':'d16d475b-64c6-4154-ba28-0cd6b2c66bd7','resumedTask':'f60c2dd2-db77-46f3-845c-7d76a7b5a666','missingPackages':['@anthropic-ai/sdk','@modelcontextprotocol/sdk','csv-parser','exceljs','jszip','ssf'],'recovery':'Authorized worktree-only symlinks; preserved .vite and shared native ABI; original entry 19 tests/build passed. See retained ev-20261029-3128e2 evidence.'}
(out/'focused-cases.json').write_text(json.dumps(cases,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
(out/'task-timing.json').write_text(json.dumps({'source':'per-task artifact metadata, not inferred goal completion','tasks':metas},ensure_ascii=False,indent=2)+'\n',encoding='utf8')
