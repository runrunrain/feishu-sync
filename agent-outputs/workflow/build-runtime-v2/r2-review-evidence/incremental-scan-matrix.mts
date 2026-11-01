import fs from 'node:fs';import path from 'node:path';
import {reconcileBuildRootResiduals} from '/tmp/feishu-build-v2-r3/feature-final/server/src/agent/build-runtime/adapter.ts';
import {KbBuildService} from '/tmp/feishu-build-v2-r3/feature-final/server/src/kb/kb-build-service.ts';
import {scanLaunchAnchors,scanV2StoreIntents,listBuildHomeDirs} from '/tmp/feishu-build-v2-r3/feature-final/server/src/agent/build-runtime/process-residual.ts';
const top='/tmp/feishu-build-v2-r3/review';fs.mkdirSync(top,{recursive:true});
for(const kind of ['unknown-execution','task-entry-file','home-file','fractional-anchor','bad-current-type','truncated-anchor','empty-home']){
 const root=fs.mkdtempSync(path.join(top,'scan-')),buildId='b_probe',buildRoot=path.join(root,'agent','builds',buildId),home=path.join(buildRoot,'epochs','e1','home');fs.mkdirSync(home,{recursive:true});
 if(kind==='unknown-execution'||kind==='bad-current-type'){
  const d=path.join(home,'amagi','v2-store','task');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'current.json'),JSON.stringify({execution:kind==='unknown-execution'?'corrupted-state':123,processState:'alive'}));
 }
 let currentReadError:string|null=null;
 if(kind==='task-entry-file'){const d=path.join(home,'amagi','v2-store');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'task'),'corrupted task directory');try{fs.readFileSync(path.join(d,'task','current.json'));}catch(e){currentReadError=(e as NodeJS.ErrnoException).code??null;}}
 if(kind==='home-file'){fs.rmdirSync(home);fs.writeFileSync(home,'corrupted home directory');}
 if(kind==='fractional-anchor'||kind==='truncated-anchor'){
  const d=path.join(home,'amagi','data','process-audits','task');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'launch-anchor.json'),kind==='truncated-anchor'?'{':JSON.stringify({version:1,taskId:'task',runs:[{rootPid:999999.5,pgid:999999.5,leaderPid:999999,at:Date.now()}]}));
 }
 const scans={homes:listBuildHomeDirs(buildRoot),anchors:scanLaunchAnchors(home),intents:scanV2StoreIntents(home,new Set(),false)};
 const outcome=await reconcileBuildRootResiduals({buildId,buildRoot,binding:null},{reap:false,includeLeaders:false});
 const report=await new KbBuildService({dataRoot:root} as any).shutdown({} as any,{timeoutMs:100});
 console.log(JSON.stringify({kind,currentReadError,scans,outcome,shutdown:report}));
}
