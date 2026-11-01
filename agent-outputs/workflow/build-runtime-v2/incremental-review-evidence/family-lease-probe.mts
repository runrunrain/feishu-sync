import fs from 'node:fs';import path from 'node:path';
import {AgentToolService} from '/tmp/feishu-build-v2-feature-tree/server/src/agent/agent-tool-service.ts';
import {BuildActorStore,V2_CHILD_ALL_TOOLS} from '/tmp/feishu-build-v2-feature-tree/server/src/kb/build-actors.ts';
import {RawSourceSnapshot,computeSourceHash} from '/tmp/feishu-build-v2-feature-tree/server/src/kb/raw-source-snapshot.ts';
const root=fs.mkdtempSync('/tmp/feishu-build-v2-incremental-review/family-'),kb=path.join(root,'kb'),stage=path.join(root,'stage');fs.mkdirSync(kb);fs.mkdirSync(path.join(stage,'docs'),{recursive:true});fs.writeFileSync(path.join(kb,'s.md'),'source');
const store=new BuildActorStore({buildId:'b_family',stagingRoot:stage,generation:1});store.registerTaskCreation({nativeTaskId:'a',requestedRole:'luban'});store.registerTaskCreation({nativeTaskId:'b',requestedRole:'luban'});store.assignOutputs({targets:['a.md'],ownerTaskId:'a'});store.assignOutputs({targets:['b.md'],ownerTaskId:'b'});
const state:any={knowledgeBaseRoot:kb,snapshot:RawSourceSnapshot.fromEntries([{objToken:'tok',objType:'docx',title:'S',relPath:'s.md',contentHash:computeSourceHash(path.join(kb,'s.md'),[],kb),objEditTime:null}],{knowledgeBaseRoot:kb,sheetCsvPaths:()=>[]}),mode:'full',workset:new Map([['tok','added']]),stagingRoot:stage,finishInfo:null,docMeta:new Map(),v2:{actorStore:store,generation:1}};
const svc:any=new AgentToolService({dataRoot:root,documentsProvider:()=>[]});const {token}=svc.createRunContext({runKind:'build',buildId:'b_family',outputRoot:path.join(root,'out'),knowledgeBaseRoot:kb,buildState:state,allowedToolsOverride:V2_CHILD_ALL_TOOLS,orchestration:{mode:'pi-amagi',buildId:'b_family',generation:1,credential:'child',actorStore:store}});
// Pause only at existing asynchronous declaration preparation boundary; no authority forged.
const original=svc.buildKnowledgeDeclaration.bind(svc);let ready!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>ready=r),gate=new Promise<void>(r=>release=r);
svc.buildKnowledgeDeclaration=async(...args:any[])=>{const result=await original(...args);ready();await gate;return result;};
const write=svc.executeTool(token,'kb_write_doc',{path:'a.md',title:'A',markdown:'A definition',sources:['tok'],summary:'s',operationId:'op1',objects:[{clientKey:'obj',type:'rule',title:'Rule',familyKey:'shared-family',variantKey:'v',scopeKey:'s',scopeText:'scope'}]},{amagiTaskId:'a',amagiAgent:'luban'});
await reached;store.assignOutputs({targets:['shared-family'],targetKind:'family',ownerTaskId:'b'});release();
try{const result=await write;console.log('WRITE_RESULT',JSON.stringify(result));}catch(e){console.log('WRITE_ERROR',String(e));}
console.log('FINAL',JSON.stringify({familyOwner:store.activeFamilyAssignmentFor('shared-family')?.ownerTaskId,fileWritten:fs.existsSync(path.join(stage,'docs/a.md')),receiptCount:store.listReceipts().length}));
