import fs from 'node:fs';import path from 'node:path';
import {KbBuildService} from '/tmp/feishu-build-v2-r2/feature-final/server/src/kb/kb-build-service.ts';
import {buildDefaultAgentConfig,buildDefaultStandardKbConfig} from '/tmp/feishu-build-v2-r2/feature-final/server/src/types/agent-knowledge.ts';
const root=fs.mkdtempSync('/tmp/feishu-build-v2-r2/review/admission-');const kb=path.join(root,'raw');fs.mkdirSync(kb);
const config:any={knowledgeBaseRoot:kb,agent:buildDefaultAgentConfig(root),standardKb:{...buildDefaultStandardKbConfig(root),orchestrationMode:'pi-amagi'},llm:{providers:[]}};
config.agent.runtime.backend='pi';
let entered!:()=>void,release!:()=>void;const reached=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
const service=new KbBuildService({dataRoot:root,configProvider:()=>config,documentsProvider:()=>[],sheetCsvPaths:()=>[],buildRuntime:{} as any,toolService:{revokeByBuild:()=>{}} as any,resolver:{checkReadiness:async()=>{entered();await gate;return{code:'ready',model:{model:'fixture/model'}};}} as any,pool:{runningCount:()=>0} as any} as any);
let row:any=null;const store:any={getActiveKbBuild:()=>row&&['queued','preflight','running'].includes(row.status)?row:null,getKbBuild:()=>row,createKbBuild:(x:any)=>{row={id:x.id,mode:x.mode,status:x.status,created_at:x.createdAt};console.log('CREATE_ROW_AFTER_SHUTDOWN',x.id);},updateKbBuild:(_id:string,patch:any)=>{Object.assign(row,patch);}};
const pending=service.createBuild(store,{mode:'full',confirm:'BUILD'});await reached;
const report=await service.shutdown(store,{timeoutMs:100});console.log('SHUTDOWN_BEFORE_READINESS',JSON.stringify(report));
release();try{const dto=await pending;console.log('ADMITTED_AFTER_SHUTDOWN',JSON.stringify({id:dto.id,status:dto.status}));}catch(e){console.log('CREATE_ERROR',String(e));}
await new Promise(r=>setTimeout(r,50));console.log('PIPELINE_ROW',JSON.stringify(row));
