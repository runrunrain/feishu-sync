// Bounded independent probes. Only temporary fixtures are written; no SQLite or real credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo='/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/work-local-resources';
const {PiPluginService}=await import(pathToFileURL(`${repo}/server/src/agent/pi-plugin-service.ts`).href);
const {PiRuntimeResolver}=await import(pathToFileURL(`${repo}/server/src/agent/runtime-resolver.ts`).href);
const {buildDefaultAgentConfig}=await import(pathToFileURL(`${repo}/server/src/types/agent-knowledge.ts`).href);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'toggle-incremental-'));
try {
 const app=path.join(root,'app'),user=path.join(root,'user'),cwd=path.join(root,'cwd');
 for(const dir of [app,user,cwd])fs.mkdirSync(dir);
 const resolver=new PiRuntimeResolver(),config=buildDefaultAgentConfig(app);
 const service=new PiPluginService({dataRoot:app,resolver,agentConfig:()=>config,running:()=>false,retireIdle:async()=>{},bundledAmagi:null});
 await service.refresh();
 // Actual legacy npm lookup, not a mocked revision. Simulate a concurrent settings edit
 // from a child while localWorkRevision is awaiting getInstalledPath().
 const global=path.join(root,'global');fs.mkdirSync(path.join(global,'probe'),{recursive:true});
 fs.writeFileSync(path.join(global,'probe/package.json'),JSON.stringify({name:'probe'}));
 const marker=path.join(root,'armed'),command=path.join(root,'npm.cjs'),settingsFile=path.join(user,'settings.json');
 fs.writeFileSync(command,`const fs=require('fs');if(fs.existsSync(${JSON.stringify(marker)})){const n=Number(fs.readFileSync(${JSON.stringify(marker)},'utf8'));if(n>1){fs.writeFileSync(${JSON.stringify(marker)},String(n-1));process.stdout.write(${JSON.stringify(global)});process.exit(0);}fs.unlinkSync(${JSON.stringify(marker)});const f=${JSON.stringify(settingsFile)},s=JSON.parse(fs.readFileSync(f));s.extensions=['!builtin:mcp'];fs.writeFileSync(f,JSON.stringify(s));}process.stdout.write(${JSON.stringify(global)});`);
 fs.writeFileSync(settingsFile,JSON.stringify({packages:['npm:probe'],npmCommand:[process.execPath,command]}));
 const before=await service.localWorkRevision(user,cwd);
 fs.writeFileSync(marker,'1');
 const during=await service.localWorkRevision(user,cwd);
 const after=await service.localWorkRevision(user,cwd);
 console.log('REVISION_RACE',JSON.stringify({before,during,after,missedChange:before===during&&during!==after,settings:JSON.parse(fs.readFileSync(settingsFile,'utf8'))}));
 fs.writeFileSync(settingsFile,JSON.stringify({packages:['npm:probe'],npmCommand:[process.execPath,command]}));
 fs.writeFileSync(marker,'3');
 const staleOverlay=await service.prepareLocalWorkHome(user,cwd);
 console.log('PREPARE_ACCEPTED_STALE',JSON.stringify({user:JSON.parse(fs.readFileSync(settingsFile,'utf8')).extensions,overlay:JSON.parse(fs.readFileSync(path.join(staleOverlay,'settings.json'),'utf8')).extensions,returned:true}));
 // Observe the exact builtin computation child, preserving real resolver calls and results.
 // A preload only records synchronous fs accesses; it does not alter them.
 const ancestor=path.join(root,'.agents/skills/fixture');fs.mkdirSync(ancestor,{recursive:true});fs.writeFileSync(path.join(ancestor,'SKILL.md'),'fixture');
 const trace=path.join(root,'trace.jsonl'),preload=path.join(root,'trace.cjs');
 fs.writeFileSync(preload,`const fs=require('fs'),m=require('module');const out=${JSON.stringify(trace)},prefix=${JSON.stringify(path.join(root,'.agents'))};for(const key of ['readdirSync','readFileSync','statSync','existsSync']){const orig=fs[key];fs[key]=function(p,...args){if(String(p).includes('.agents'))fs.appendFileSync(out,JSON.stringify({op:key,path:String(p)})+'\\n');return orig.call(this,p,...args)}}m.syncBuiltinESMExports();`);
 const runtime=await resolver.resolveRuntime(config);
 // Use a wrapper Node to preload the observer even though buildPiProcessEnv drops NODE_OPTIONS.
 const wrapper=path.join(root,'node-wrapper');fs.writeFileSync(wrapper,`#!/bin/sh\nexec ${JSON.stringify(runtime.nodePath)} --require ${JSON.stringify(preload)} "$@"\n`,{mode:0o700});
 const observed=new PiPluginService({dataRoot:app,resolver:{resolveRuntime:async()=>({...runtime,nodePath:wrapper})},agentConfig:()=>config,running:()=>false,retireIdle:async()=>{},bundledAmagi:null});
 const builtins=await observed.enabledWorkBuiltins();
 console.log('ACTUAL_BUILTINS',JSON.stringify(builtins));
 console.log('ANCESTOR_USER_READS',fs.existsSync(trace)?fs.readFileSync(trace,'utf8'):'none');
} finally {fs.rmSync(root,{recursive:true,force:true});}
