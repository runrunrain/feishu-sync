import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {renderChildPolicySource} from '/tmp/feishu-build-v2-r2/feature-final/server/src/agent/build-runtime/child-policy.ts';
import {createReadToolDefinition} from '/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js';
const root=fs.realpathSync(fs.mkdtempSync('/tmp/feishu-build-v2-r2/review/path-'));const work=path.join(root,'work'),out=path.join(root,'outside');fs.mkdirSync(work);fs.mkdirSync(out);fs.writeFileSync(path.join(work,'allowed.md'),'ALLOWED');fs.writeFileSync(path.join(out,'secret.md'),'SYNTHETIC_OUTSIDE');fs.symlinkSync(out,path.join(work,'alias'));fs.writeFileSync(path.join(root,'policy.mjs'),renderChildPolicySource());
process.env.AMAGI_TASK_ID='probe';process.env.AMAGI_PERMISSION_CWD=work;process.env.PI_BUILD_CHILD_ROOTS_JSON=JSON.stringify({readRoots:[work],writeRoots:[path.join(work,'agent-outputs')]});
const handlers=new Map<string,any>();(await import(pathToFileURL(path.join(root,'policy.mjs')).href)).default({on:(n:string,f:any)=>handlers.set(n,f),getActiveTools:()=>[],setActiveTools:()=>{}});
const sdk=createReadToolDefinition(work);
for(const target of ['allowed.md',path.join(work,'allowed.md'),'@'+path.join(out,'secret.md'),pathToFileURL(path.join(out,'secret.md')).href,'alias/secret.md','../outside/secret.md','missing.md']){
 const args={path:target};const v=await handlers.get('tool_call')({toolName:'read',input:args});
 if(v?.block){console.log(JSON.stringify({target,blocked:true}));continue;}
 const result=await sdk.execute('probe',args);console.log(JSON.stringify({target,blocked:false,content:result.content}));
}
