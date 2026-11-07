import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { guardTaskSubmit, resetDispatchGuardAdmissionState } from './src/agent/build-runtime/dispatch-guard.ts';
import { AgentToolService, normalizeToolArguments } from './src/agent/agent-tool-service.ts';
import { RAW_SEARCH_SPEC, DRAFT_SEARCH_SPEC, DRAFT_READ_SPEC, KB_TOOL_SCHEMA_SPEC } from './src/agent/tool-specs.ts';
import { BuildActorStore } from './src/kb/build-actors.ts';
import { collectAuthorityValidatedReports, scopedKnowledgeDeclarationHash } from './src/kb/review-authority.ts';
import { contentResourceHash } from './src/kb/evidence-locator.ts';
import { RawSourceSnapshot, computeSourceHash } from './src/kb/raw-source-snapshot.ts';
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'kb-review-probe-'));
const root=path.join(temp,'staging');
fs.mkdirSync(path.join(root,'docs'),{recursive:true}); fs.mkdirSync(path.join(root,'reviews'));
const body='unchanged body'; fs.writeFileSync(path.join(root,'docs/a.md'),body);
const draft={schemaVersion:1,buildId:'b_probe',docs:{'a.md':{title:'old'}},clientKeys:{},evidenceKeys:{},objects:[],presentations:[],relations:[],evidence:[],coverage:[],calls:{}};
const oldHash=scopedKnowledgeDeclarationHash(draft,['a.md'],['src']);
draft.docs['a.md'].title='new'; fs.writeFileSync(path.join(root,'knowledge-draft.json'),JSON.stringify(draft));
const newHash=scopedKnowledgeDeclarationHash(draft,['a.md'],['src']);
function review(id,verdict,decl,uncheckedScope=[]) {
 const issues=verdict==='pass'?[]:[{issueId:'i1',draftLocation:'a.md 证据',sourceLocation:'src line 1',description:'证据列位错误',severity:'blocking'}];
 const report={reportId:id,buildId:'b_probe',draftHash:'candidate',coverage:{draftHashes:['candidate'],sourceRefs:['src']},checkedDimensions:['排版'],issues,uncheckedScope,conclusion:verdict,serverVersionTag:'fixture'};
 fs.writeFileSync(path.join(root,'reviews',id+'.json'),JSON.stringify(report));
 return {reviewId:id,buildId:'b_probe',generation:1,reviewerTaskId:'independent-'+id,scopePaths:['a.md'],draftHash:'candidate',dependencyHashes:{'doc:a.md':contentResourceHash(body),'subject:a.md':'subject','knowledge-declaration':decl,'declaration-scope':'document-v2','source-snapshot':'snapshot','workflow-rules':'rules'},verdict,issues,status:'valid',reportId:id,reportUnitId:id,createdAt:'2026-11-01T00:00:00Z'};
}
const old=review('old','needs_revision',oldHash);
const pass=review('pass','pass',newHash,['a.md 的证据列位未检查']);
console.log('R1 partial pass closure:',JSON.stringify(collectAuthorityValidatedReports({stagingRoot:root,store:{listReviews:()=>[old,pass]},documentHashes:new Map([['a.md',contentResourceHash(body)]]),subjectOf:()=> 'subject',current:{declarationHash:newHash,sourceSnapshotHash:'snapshot',workflowRulesHash:'rules'}})));
const completePass=review('complete-pass','pass',newHash,[]);
const store=new BuildActorStore({buildId:'b_probe',stagingRoot:root,generation:1});
store.recordReview({...completePass,issues:[]});
store.recordIssueList({authorTaskId:'leader',issues:[{issueKey:'new-problem',severity:'blocking',targetPath:'a.md',description:'pass 后新发现的问题',draftLocation:'a.md',sourceLocation:'src',fromReviewId:null}]});
console.log('R2 same-candidate new blocking count:',store.openBlockingIssues());
resetDispatchGuardAdmissionState();
const config={buildId:'b_probe',generation:1,workDir:'/tmp/kb-work',reportRoot:'agent-outputs',forbiddenZones:[],roles:{luban:{key:'writer',models:['valid'],mcpTools:[]}},dispatch:{rolePoolKeys:{writer:'pool'},poolCapacities:{pool:1},inflightStatePath:'/tmp/not-used'}};
const now='2026-11-01T00:00:00Z';
const snapshot={schemaVersion:1,buildId:'b_probe',generation:1,seq:1,updatedAt:now,inflight:[],pendingReview:0,pendingRevision:0};
const opts={now:()=>now,inflight:snapshot};
console.log('R3 rejected then corrected:',guardTaskSubmit(config,{agent:'luban',task:'one doc',model:'invalid'},opts).code,guardTaskSubmit(config,{agent:'luban',task:'one doc',model:'valid'},opts).code);
for(const [name,spec,args] of [['raw_search',RAW_SEARCH_SPEC,{queries:['test']}],['draft_search',DRAFT_SEARCH_SPEC,{queries:['test']}],['draft_read',DRAFT_READ_SPEC,{docPath:'a.md'}],['kb_tool_schema',KB_TOOL_SCHEMA_SPEC,{tool:'draft_read'}]]) console.log('R4 schema required missing:',name,(spec.parameters.required??[]).filter(k=>!(k in args)),'handler accepts:',normalizeToolArguments(name,args).args);
const kb=path.join(temp,'kb'); fs.mkdirSync(kb);
const raw=Array.from({length:90},()=>String.fromCharCode(92).repeat(120)).join('\n'); fs.writeFileSync(path.join(kb,'raw.md'),raw);
const entry={objToken:'src',objType:'docx',title:'source',relPath:'raw.md',contentHash:computeSourceHash(path.join(kb,'raw.md'),[],kb),objEditTime:null};
const snapshotRaw=RawSourceSnapshot.fromEntries([entry],{knowledgeBaseRoot:kb,sheetCsvPaths:()=>[]});
const state={knowledgeBaseRoot:kb,snapshot:snapshotRaw,mode:'full',workset:new Map([['src','added']]),stagingRoot:root,finishInfo:null};
const svc=new AgentToolService({dataRoot:temp,documentsProvider:()=>[]});
const ctx=svc.createRunContext({runKind:'build',buildId:'b_probe',outputRoot:path.join(temp,'output'),knowledgeBaseRoot:kb,buildState:state,allowedToolsOverride:['kb_read_batch']});
const result=await svc.executeTool(ctx.token,'kb_read_batch',{requests:[{kind:'raw',objToken:'src'}]});
const payload=JSON.parse(result.content[0].text);
console.log('R5 batch:',JSON.stringify({sourceBytes:Buffer.byteLength(raw),responseBytes:Buffer.byteLength(result.content[0].text),returned:payload.results[0].returnedLines,truncated:payload.results[0].truncated,nextCursor:payload.nextCursor,receipts:result.details.receipts}));

import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { passReviewClosureForIssues } from './src/kb/review-authority.ts';
assert.deepEqual(collectAuthorityValidatedReports({stagingRoot:root,store:{listReviews:()=>[old,pass]},documentHashes:new Map([['a.md',contentResourceHash(body)]]),subjectOf:()=> 'subject',current:{declarationHash:newHash,sourceSnapshotHash:'snapshot',workflowRulesHash:'rules'}}).validReportIds,['old','pass']);
assert.equal(store.openBlockingIssues(),1);
resetDispatchGuardAdmissionState();
assert.equal(guardTaskSubmit(config,{agent:'luban',task:'one doc',model:'invalid'},opts).code,'dispatch_model_not_frozen');
assert.equal(guardTaskSubmit(config,{agent:'luban',task:'one doc',model:'valid'},opts).decision,'allow');
// R1-A: bind two paths, then inspect the actual closure decision, not a mock normalizer.
fs.writeFileSync(path.join(root,'docs/b.md'),'b');draft.docs['b.md']={};fs.writeFileSync(path.join(root,'knowledge-draft.json'),JSON.stringify(draft));
const bothHash=scopedKnowledgeDeclarationHash(draft,['a.md','b.md'],['src']);
function closure(entry){
 const r=review('mixed','pass',bothHash,[entry]);r.scopePaths=['a.md','b.md'];r.dependencyHashes['doc:b.md']=contentResourceHash('b');
 return passReviewClosureForIssues({stagingRoot:root,receipts:[r],issues:[{targetPath:'a.md',draftLocation:'a.md 证据'}]})[0];
}
assert.equal(closure('除 b.md 外，全部文档的证据列位均未检查'),false);
for(const entry of ['all documents except b.md were not checked','a.\u200bmd 未检查','\u200b','   ','Nothing but b.md was checked','Everything besides b.md was not checked'])console.log('NEW_SCOPE',JSON.stringify(entry), 'closed=',closure(entry));
// R2-A strict + fromReviewId referencing a real old report; ensure new pass matches current candidate.
const strictStore=new BuildActorStore({buildId:'b_probe',stagingRoot:root,generation:1});
strictStore.recordReview(old);
const strictPass=review('strict-pass','pass',bothHash,[]);strictPass.scopePaths=['a.md','b.md'];strictPass.dependencyHashes['doc:b.md']=contentResourceHash('b');strictStore.recordReview(strictPass);
strictStore.recordIssueList({authorTaskId:'leader',gatePolicy:'strict',issues:[{issueKey:'old-problem',severity:'blocking',targetPath:'a.md',description:'blocked',draftLocation:'a.md',sourceLocation:'src',fromReviewId:'old'}]});
assert.equal(strictStore.openBlockingIssues(),1);console.log('R2-A strict fromReviewId count=1');
// Validate schema actually issued to this token (same schema consumed by the bridge).
const schCtx=svc.createRunContext({runKind:'build',buildId:'b_schema',outputRoot:path.join(temp,'out-schema'),knowledgeBaseRoot:kb,buildState:state,allowedToolsOverride:['raw_search','draft_search','draft_read','kb_tool_schema']});
const schemas=svc.getToolSpecsForToken(schCtx.token);const ajv=new Ajv({strict:false});
for(const [name,args] of [['raw_search',{queries:['test']}],['draft_search',{queries:['test']}],['draft_read',{docPath:'a.md'}],['draft_read',{paths:['a.md']}],['kb_tool_schema',{tool:'draft_read'}]]){
 const spec=schemas.find(x=>x.name===name);assert.ok(spec,name);const validate=ajv.compile(spec.parameters);assert.ok(validate(args),JSON.stringify(validate.errors));console.log('SCHEMA_ALIAS',name,JSON.stringify(args),'accepted');
}
let caseNo=0;
function reader(rawText,docs={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'r3-page-'));const kb2=path.join(dir,'kb');const st=path.join(dir,'staging');fs.mkdirSync(kb2);fs.mkdirSync(path.join(st,'docs'),{recursive:true});
 fs.writeFileSync(path.join(kb2,'raw.md'),rawText);for(const [p,t]of Object.entries(docs))fs.writeFileSync(path.join(st,'docs',p),'# Title\n'+t);
 const e={objToken:'src',objType:'docx',title:'source',relPath:'raw.md',contentHash:computeSourceHash(path.join(kb2,'raw.md'),[],kb2),objEditTime:null};
 const sn=RawSourceSnapshot.fromEntries([e],{knowledgeBaseRoot:kb2,sheetCsvPaths:()=>[]});
 const bs={knowledgeBaseRoot:kb2,snapshot:sn,mode:'full',workset:new Map([['src','added']]),stagingRoot:st,finishInfo:null};
 const service=new AgentToolService({dataRoot:dir,documentsProvider:()=>[]});const c=service.createRunContext({runKind:'build',buildId:'b_page'+ ++caseNo,outputRoot:path.join(dir,'out'),knowledgeBaseRoot:kb2,buildState:bs,allowedToolsOverride:['kb_read_batch','raw_read']});
 return {dir,st,service,c};
}
async function batchChain(label,rawText,docs,requests){
 const f=reader(rawText,docs);let args={requests},last=null,maxBytes=0,pages=0;const byKey=new Map(),covered=[];let receiptCount=0;
 do{
  const r=await f.service.executeTool(f.c.token,'kb_read_batch',args);const text=r.content[0].text;const p=JSON.parse(text);pages++;assert.ok(pages<50,'cursor stuck');assert.ok(Buffer.byteLength(text)<=19500);maxBytes=Math.max(maxBytes,Buffer.byteLength(text));assert.equal(r.details.contentBytes,Buffer.byteLength(text));assert.ok(p.results.length>0,'empty nonprogress');
  const allReceipts=fs.existsSync(path.join(f.st,'read-receipts.jsonl'))?fs.readFileSync(path.join(f.st,'read-receipts.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  assert.equal(allReceipts.length-receiptCount,r.details.receipts);receiptCount=allReceipts.length;
  for(const item of p.results){const key=item.kind==='raw'?'raw':item.path;const s=byKey.get(key)||{chunks:'',lines:[],nextChar:0};
   if(item.lineChunk){assert.equal(item.lineChunk.charStart,s.nextChar);assert.ok(item.lineChunk.charEnd>item.lineChunk.charStart);assert.equal([...item.text].length,item.lineChunk.charEnd-item.lineChunk.charStart);assert.ok(!item.text.includes('\ufffd'));s.nextChar=item.lineChunk.charEnd;s.chunks+=item.text;assert.ok(!item.segmentMap);}
   else{const t=item.kind==='raw'?item.text.slice(item.text.indexOf('>')+2,-'\n</untrusted_source>'.length):item.text;assert.equal(item.offset,s.lines.length);s.lines.push(...(item.returnedLines?t.split('\n'):[]));if(item.kind==='raw')for(const seg of item.segmentMap??[]){if(!seg.resourceId)continue;const rr=allReceipts.find(x=>x.readReceiptId===seg.readReceiptId);assert.ok(rr);assert.equal(rr.selector.lineStart,seg.resStart);assert.equal(rr.selector.lineEnd,seg.resEnd);const expected=rawText.split('\n').slice(seg.resStart-1,seg.resEnd).join('\n');assert.equal(rr.returnedHash,contentResourceHash(expected));covered.push([seg.resStart,seg.resEnd]);}}
   byKey.set(key,s);
  }
  if(p.nextCursor)assert.notEqual(p.nextCursor,last,'cursor must advance');last=p.nextCursor;args={cursor:p.nextCursor};
 }while(last);
 if(requests.some(x=>x.kind==='raw')){const got=byKey.get('raw');assert.equal(got.chunks||got.lines.join('\n'),rawText);}
 for(const [p,t]of Object.entries(docs)){const got=byKey.get(p);if(got)assert.equal(got.chunks||got.lines.join('\n'),t);}
 console.log('CHAIN_PASS',label,JSON.stringify({pages,maxBytes,receipts:receiptCount,covered,fixture:f.dir}));return f;
}
await batchChain('R5-original-backslashes',raw,{},[{kind:'raw',objToken:'src'}]);
await batchChain('R5-A-two-requests','r'.repeat(5000),{'large.md':'d'.repeat(14000)},[{kind:'draft',path:'large.md'},{kind:'raw',objToken:'src'}]);
await batchChain('R5-B-draft-25000','unused',{'long.md':'d'.repeat(25000)},[{kind:'draft',path:'long.md'}]);
await batchChain('NEW-CJK-draft','unused',{'long.md':'中汉字'.repeat(5000)},[{kind:'draft',path:'long.md'}]);
await batchChain('NEW-4byte-raw','😀𠮷'.repeat(5000),{},[{kind:'raw',objToken:'src'}]);
async function rawChain(label,rawText){const f=reader(rawText);let offset=0,seen=[],pages=0,covered=[];do{const r=await f.service.executeTool(f.c.token,'raw_read',{objToken:'src',offset,limit:800});const t=r.content[0].text;const d=r.details;pages++;assert.ok(pages<50);assert.ok(Buffer.byteLength(t)<=19500);assert.equal(d.offset,offset);assert.ok(d.returnedLines>0);assert.ok(d.nextOffset===null||d.nextOffset>offset);for(const rr of d.readReceipts??[]){const {lineStart,lineEnd}=rr;covered.push([lineStart,lineEnd]);const stored=fs.readFileSync(path.join(f.st,'read-receipts.jsonl'),'utf8').trim().split('\n').map(JSON.parse).find(x=>x.readReceiptId===rr.readReceiptId);assert.equal(stored.returnedHash,contentResourceHash(rawText.split('\n').slice(lineStart-1,lineEnd).join('\n')));}assert.equal(d.nextOffset,offset+d.returnedLines<d.totalLines?offset+d.returnedLines:null);seen.push([offset,d.returnedLines]);offset=d.nextOffset;}while(offset!==null);assert.equal(seen.reduce((n,x)=>n+x[1],0),rawText.split('\n').length);console.log('RAW_CHAIN_PASS',label,JSON.stringify({pages,seen,covered,fixture:f.dir}));}
await rawChain('NEW-budget-nextOffset',Array.from({length:150},(_,i)=>String(i)+':'+ '中😀\\"'.repeat(100)).join('\n'));
console.log('ALL_ASSERTIONS_PASS',temp);
// Reproduce new English bypass through the actual standard authority selector.
for(const entry of ['Nothing but b.md was checked','Everything besides b.md was not checked']){
 const r=review('english-pass','pass',bothHash,[entry]);r.scopePaths=['a.md','b.md'];r.dependencyHashes['doc:b.md']=contentResourceHash('b');r.dependencyHashes['subject:b.md']='subject';
 const selected=collectAuthorityValidatedReports({stagingRoot:root,store:{listReviews:()=>[old,r]},documentHashes:new Map([['a.md',contentResourceHash(body)],['b.md',contentResourceHash('b')]]),subjectOf:()=> 'subject',current:{declarationHash:bothHash,sourceSnapshotHash:'snapshot',workflowRulesHash:'rules'}});
 assert.deepEqual(selected.validReportIds,['english-pass']);assert.equal(selected.skipped[0].reason,'blocking_issues_closed_by_current_pass');console.log('REPRO_FALSE_CLOSURE',JSON.stringify({entry,selected}));
}
// raw_read deliberately cannot split an atomic line; its skip must be explicit,
// receipt-free and point to the exact next output offset, with batch as lossless fallback.
const skip=reader('x'.repeat(25000)+'\nNEXT');const skipped=await skip.service.executeTool(skip.c.token,'raw_read',{objToken:'src',offset:0,limit:800});assert.ok(skipped.content[0].text.includes('<oversized_line'));assert.equal(skipped.details.returnedLines,0);assert.equal(skipped.details.nextOffset,1);assert.equal(skipped.details.readReceipts.length,0);assert.ok(Buffer.byteLength(skipped.content[0].text)<=19500);
const after=await skip.service.executeTool(skip.c.token,'raw_read',{objToken:'src',offset:1,limit:800});assert.equal(after.details.nextOffset,null);assert.equal(after.details.returnedLines,1);assert.ok(after.content[0].text.includes('NEXT'));console.log('RAW_OVERSIZE_EXPLICIT_SKIP_PASS',skip.dir);
