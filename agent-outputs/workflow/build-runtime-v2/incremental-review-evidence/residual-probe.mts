import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { reconcileResidualProcesses } from '/tmp/feishu-build-v2-feature-tree/server/src/agent/build-runtime/process-residual.ts';
import { readBirthIdentities } from '/tmp/feishu-build-v2-feature-tree/server/src/agent/build-runtime/process-identity.ts';
const base='/tmp/feishu-build-v2-incremental-review';
function fixture(name:string, pid:number, token:string){
 const home=path.join(base,name,'home'), build=path.join(base,name,'build');
 const a=path.join(home,'amagi/data/process-audits/t1');fs.mkdirSync(a,{recursive:true});
 fs.writeFileSync(path.join(a,'launch-anchor.json'),JSON.stringify({version:1,taskId:'t1',runs:[{rootPid:pid,pgid:pid,rootIdentityToken:token,leaderPid:4100,at:1}]}));
 const v=path.join(home,'amagi/v2-store/t1');fs.mkdirSync(v,{recursive:true});fs.writeFileSync(path.join(v,'current.json'),JSON.stringify({execution:'running',processState:'alive'}));
 return {homeDir:home,buildRoot:build,leaderPids:new Set([4100])};
}
// Real same-group orphan: no setsid escape, shell, model, or production data.
const childFile=path.join(base,'orphan-pid');
const parent=spawn(process.execPath,['-e',`const {spawn}=require('node:child_process');const fs=require('node:fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(childFile)},String(p.pid));setInterval(()=>{},1000);`],{detached:true,stdio:'ignore'});
let orphan=0;
try {
 for(let n=0;n<100&&!fs.existsSync(childFile);n++)await new Promise(r=>setTimeout(r,20));
 orphan=Number(fs.readFileSync(childFile,'utf8'));const root=parent.pid!;
 const birth=(await readBirthIdentities([root])).get(root);if(!birth)throw Error('birth unavailable');
 const input=fixture('real-orphan',root,birth);
 const exited=once(parent,'exit');parent.kill('SIGKILL');await exited;
 const outcome=await reconcileResidualProcesses(input,{reap:true});
 let alive=false;try{process.kill(orphan,0);alive=true;}catch{}
 console.log('REAL_ROOT_EXITED_SAME_GROUP_ORPHAN',JSON.stringify({root,orphan,orphanAlive:alive,outcome}));
}finally {if(orphan)try{process.kill(orphan,'SIGKILL');}catch{} if(parent.exitCode===null&&parent.signalCode===null)parent.kill('SIGKILL');}
// Safe injected race: root PID changes after classification, before group enumeration.
const input=fixture('group-reuse',5000,'darwin:old:1');let psCalls=0,rootReads=0;
const signals:any[]=[];const alive=new Set([5000,5001]);
const out=await reconcileResidualProcesses(input,{reap:true},{platform:'darwin',
 runPs:async()=>{psCalls++;return psCalls===1?'5000 1 5000 501 10:00 node':'5000 1 5000 501 10:00 unrelated-node\n5001 5000 5000 501 10:00 unrelated-worker';},
 probeBirthTokens:async(pids)=>new Map(pids.map(pid=>[pid,pid===5000?(++rootReads<=2?'darwin:old:1':'darwin:new:1'):'darwin:unrelated:2'])),
 isAlive:pid=>alive.has(pid),kill:(pid,signal)=>{signals.push({pid,signal});alive.delete(pid);},sleep:async()=>{},reapGraceMs:1});
console.log('ROOT_REUSED_BEFORE_MEMBER_DISCOVERY',JSON.stringify({signals,outcome:out}));
