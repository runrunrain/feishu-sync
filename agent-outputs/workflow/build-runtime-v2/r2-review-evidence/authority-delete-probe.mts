import fs from 'node:fs'; import path from 'node:path';
import {AgentToolService} from '/tmp/feishu-build-v2-r2/feature-final/server/src/agent/agent-tool-service.ts';
import {BuildActorStore,V2_CHILD_ALL_TOOLS} from '/tmp/feishu-build-v2-r2/feature-final/server/src/kb/build-actors.ts';
import {RawSourceSnapshot,computeSourceHash} from '/tmp/feishu-build-v2-r2/feature-final/server/src/kb/raw-source-snapshot.ts';
const root=fs.mkdtempSync('/tmp/feishu-build-v2-r2/review/auth-'),kb=path.join(root,'kb'),stage=path.join(root,'stage');fs.mkdirSync(kb);fs.mkdirSync(path.join(stage,'docs'),{recursive:true});fs.writeFileSync(path.join(kb,'s.md'),'source');
const store=new BuildActorStore({buildId:'b_family',stagingRoot:stage,generation:1});for(const nativeTaskId of ['a','b'])store.registerTaskCreation({nativeTaskId,requestedRole:'luban'});store.assignOutputs({targets:['a.md'],ownerTaskId:'a'});store.assignOutputs({targets:['b.md'],ownerTaskId:'b'});
const state:any={knowledgeBaseRoot:kb,snapshot:RawSourceSnapshot.fromEntries([{objToken:'tok',objType:'docx',title:'S',relPath:'s.md',contentHash:computeSourceHash(path.join(kb,'s.md'),[],kb),objEditTime:null}],{knowledgeBaseRoot:kb,sheetCsvPaths:()=>[]}),mode:'full',workset:new Map([['tok','added']]),stagingRoot:stage,finishInfo:null,docMeta:new Map(),v2:{actorStore:store,generation:1}};
const svc:any=new AgentToolService({dataRoot:root,documentsProvider:()=>[]});const {token}=svc.createRunContext({runKind:'build',buildId:'b_family',outputRoot:path.join(root,'out'),knowledgeBaseRoot:kb,buildState:state,allowedToolsOverride:V2_CHILD_ALL_TOOLS,orchestration:{mode:'pi-amagi',buildId:'b_family',generation:1,credential:'child',actorStore:store}});
const obj={clientKey:'obj',type:'rule',title:'Rule',familyKey:'family-owned-by-b',variantKey:'v',scopeKey:'s',scopeText:'scope'};
const args={path:'a.md',title:'A',markdown:'A definition',sources:['tok'],summary:'s'};
const call=(operationId:string,objects:any[])=>svc.executeTool(token,'kb_write_doc',{...args,operationId,objects},{amagiTaskId:'a',amagiAgent:'luban'});
await call('initial',[obj]);store.assignOutputs({targets:[obj.familyKey],targetKind:'family',ownerTaskId:'b'});
for(const [operationId,objects] of [['remove-objects',[]]] as const){
 try{const result=await call(operationId,objects as any); console.log(operationId,'SUCCESS',JSON.stringify(result));}catch(e){console.log(operationId,'ERROR',String(e));}
 console.log('registry',fs.readFileSync(path.join(stage,'knowledge-draft.json'),'utf8'));
}
console.log('oldFamilyOwner',store.activeFamilyAssignmentFor(obj.familyKey)?.ownerTaskId,'receipts',store.listReceipts().length);
