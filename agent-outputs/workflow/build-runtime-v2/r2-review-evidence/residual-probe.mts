import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';
import {reconcileBuildRootResiduals} from '/tmp/feishu-build-v2-r2/feature-final/server/src/agent/build-runtime/adapter.ts';
import {KbBuildService} from '/tmp/feishu-build-v2-r2/feature-final/server/src/kb/kb-build-service.ts';
import {readBirthIdentities} from '/tmp/feishu-build-v2-r2/feature-final/server/src/agent/build-runtime/process-identity.ts';
const root=fs.mkdtempSync('/tmp/feishu-build-v2-r2/review/residual-');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise(r=>child.once('spawn',r));
try{
 const pid=child.pid!;const birth=(await readBirthIdentities([pid])).get(pid);
 const buildId='b_missing_binding',buildRoot=path.join(root,'agent','builds',buildId),home=path.join(buildRoot,'epochs','e1','home');
 const audit=path.join(home,'amagi','data','process-audits','owned');fs.mkdirSync(audit,{recursive:true});
 fs.writeFileSync(path.join(audit,'launch-anchor.json'),JSON.stringify({version:1,taskId:'owned',runs:[{rootPid:pid,pgid:pid,rootIdentityToken:birth,leaderPid:999999,at:Date.now()}]}));
 const task=path.join(home,'amagi','v2-store','owned');fs.mkdirSync(task,{recursive:true});fs.writeFileSync(path.join(task,'current.json'),JSON.stringify({execution:'running',processState:'running'}));
 console.log('OWN_CHILD',JSON.stringify({pid,birth,alive:child.exitCode===null}));
 console.log('UNBOUND_ANCHOR',JSON.stringify(await reconcileBuildRootResiduals({buildId,buildRoot,binding:null},{reap:false,includeLeaders:false})));
 console.log('SHUTDOWN_UNBOUND',JSON.stringify(await new KbBuildService({dataRoot:root} as any).shutdown({} as any,{timeoutMs:100})));
 const root2=fs.mkdtempSync('/tmp/feishu-build-v2-r2/review/scan-'),br=path.join(root2,'agent','builds','b_scan'),h=path.join(br,'epochs','e1','home');fs.mkdirSync(path.join(h,'amagi','data'),{recursive:true});
 fs.writeFileSync(path.join(h,'amagi','data','process-audits'),'not a directory');fs.writeFileSync(path.join(h,'amagi','v2-store'),'not a directory');
 console.log('UNREADABLE_SCAN',JSON.stringify(await reconcileBuildRootResiduals({buildId:'b_scan',buildRoot:br,binding:null},{reap:false})));
 console.log('SHUTDOWN_UNREADABLE',JSON.stringify(await new KbBuildService({dataRoot:root2} as any).shutdown({} as any,{timeoutMs:100})));
}finally{child.kill('SIGTERM');await new Promise(r=>child.once('close',r)); console.log('OWN_CHILD_CLOSED',child.exitCode,child.signalCode);}
