import fs from 'node:fs';
import path from 'node:path';
import { scanLaunchAnchors, scanV2StoreIntents, listBuildHomeDirs } from '/tmp/feishu-build-v2-r5/feature-final/server/src/agent/build-runtime/process-residual.ts';
import { reconcileBuildRootResiduals } from '/tmp/feishu-build-v2-r5/feature-final/server/src/agent/build-runtime/adapter.ts';
import { KbBuildService } from '/tmp/feishu-build-v2-r5/feature-final/server/src/kb/kb-build-service.ts';
import { FileTaskStore } from '/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/task-store.ts';
import { validateTaskRun } from '/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/contracts/task.ts';
import { appendLaunchAnchor, readLaunchAnchor, launchAnchorPath } from '/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/launch-anchor.ts';
const base=fs.mkdtempSync('/tmp/feishu-build-v2-r5/review/independent-matrix-');
const taskId='12345678-1234-4234-8234-123456789abc';
let index=0;
async function probe(name:string,setup:(f:any)=>Promise<void>|void){
 const root=path.join(base,'case-'+(++index)); fs.mkdirSync(root,{recursive:true});
 const buildId='b_probe';const buildRoot=path.join(root,'agent','builds',buildId);const home=path.join(buildRoot,'epochs','e1','home');fs.mkdirSync(home,{recursive:true});
 const storeRoot=path.join(home,'amagi','v2-store'); const currentFile=path.join(storeRoot,taskId,'current.json');
 process.env.PI_CODING_AGENT_DIR=home;
 const f={root,buildRoot,home,storeRoot,currentFile,
  async current(execution='done',processState='exited'){
   const run={version:1,ownerId:'owner',taskId,revision:1,specId:'spec',stateSeq:0,execution,settlement:'pending',acceptance:'unreviewed',backend:'rpc',recovery:'none',queuedAt:1,processState};
   await new FileTaskStore(storeRoot).replaceCurrent(null,run as any);
   return run;
  },
  anchor(fields:Record<string,unknown>={}){
   const failure=appendLaunchAnchor(taskId,{rootPid:999999,pgid:999999,leaderPid:999998,at:1,...fields} as any);
   if(failure)throw Error(failure);
  }
 };
 await setup(f);
 let nativeCurrent:any; if(fs.existsSync(currentFile)){try {nativeCurrent=validateTaskRun(JSON.parse(fs.readFileSync(currentFile,'utf8'))).ok;}catch{nativeCurrent=false;}}
 const nativeAnchor=readLaunchAnchor(taskId);
 const outcome=await reconcileBuildRootResiduals({buildId,buildRoot,binding:null});
 const shutdown=await new KbBuildService({dataRoot:root} as any).shutdown({getKbBuild:()=>null,updateKbBuild:()=>undefined} as any,{timeoutMs:100});
 console.log(JSON.stringify({name,nativeCurrent,nativeAnchor:!!nativeAnchor,homeScan:listBuildHomeDirs(buildRoot),anchorScan:scanLaunchAnchors(home),intentScan:scanV2StoreIntents(home,new Set(),false),state:outcome?.state??'no-facts',quiesced:shutdown.quiesced,children:outcome?.children}));
}
await probe('empty',()=>{});
await probe('native-valid-current',f=>f.current());
for(const execution of ['queued','running','blocked','answering','done','error','answered','cancelled','truncated','resolved-external']) {
 for(const processState of ['alive','unknown','exited','not-started']) await probe(execution+'/'+processState,f=>f.current(execution,processState));
}
for(const [name,field,value] of [['unknown-execution','execution','corrupt'],['unknown-process','processState','corrupt'],['missing-process','processState',undefined]] as const){
 await probe(name,async f=>{const run=await f.current();(run as any)[field]=value;fs.writeFileSync(f.currentFile,JSON.stringify(run));});
}
for(const [field,value] of [['rootPid',999999.5],['pgid',999999.5],['leaderPid',999998.5],['at',-1],['rootIdentityToken',23],['rootIdentityToken',null],['pgid',null],['leaderIdentityToken',23],['bootId','bad'],['bootTimeMs',-1]] as const){
 await probe('anchor/'+field+'/'+value, f=>f.anchor({[field]:value}));
}
await probe('native-valid-anchor',f=>f.anchor());
for(const droppedRuns of [-1,0,1,0.5,'bad',null]) await probe('dropped/'+droppedRuns,f=>{f.anchor();const p=launchAnchorPath(taskId);const a=JSON.parse(fs.readFileSync(p,'utf8'));a.droppedRuns=droppedRuns;fs.writeFileSync(p,JSON.stringify(a));});
for(const kind of ['epoch-file','legacy-file','home-dangling','epoch-dangling','audit-root-dangling','audit-task-dangling','anchor-file-dangling','store-root-dangling','task-file','task-link','ancestor-dangling','auxiliary']) await probe(kind,async f=>{
 const link=(p:string)=>fs.symlinkSync(path.join(f.root,'missing'),p);
 if(kind==='epoch-file'){fs.rmdirSync(f.home);fs.writeFileSync(f.home,'x');}
 else if(kind==='legacy-file')fs.writeFileSync(path.join(f.buildRoot,'home'),'x');
 else if(kind==='home-dangling'){fs.rmdirSync(f.home);link(f.home);}
 else if(kind==='epoch-dangling'){const p=path.dirname(f.home);fs.rmSync(p,{recursive:true});link(p);}
 else if(kind==='ancestor-dangling')link(path.join(f.home,'amagi'));
 else if(kind==='auxiliary'){fs.mkdirSync(f.storeRoot,{recursive:true});for(const n of ['README','README.md','.DS_Store','.gitkeep'])fs.writeFileSync(path.join(f.storeRoot,n),'aux');}
 else if(kind==='task-file'||kind==='task-link'){await f.current('running','alive');const p=path.dirname(f.currentFile);fs.rmSync(p,{recursive:true});kind==='task-file'?fs.writeFileSync(p,'bad'):link(p);}
 else if(kind==='store-root-dangling'){fs.mkdirSync(path.dirname(f.storeRoot),{recursive:true});link(f.storeRoot);}
 else{const audits=path.join(f.home,'amagi','data','process-audits');fs.mkdirSync(path.dirname(audits),{recursive:true});if(kind==='audit-root-dangling')link(audits);else{fs.mkdirSync(audits);if(kind==='audit-task-dangling')link(path.join(audits,taskId));else{fs.mkdirSync(path.join(audits,taskId));link(path.join(audits,taskId,'launch-anchor.json'));}}}
});
