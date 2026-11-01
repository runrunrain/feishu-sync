import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {recordLaunchAnchor, launchAnchorPath, readLaunchAnchor} from '/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/launch-anchor.ts';
import {scanLaunchAnchors} from '/tmp/feishu-build-v2-r5/feature-final/server/src/agent/build-runtime/process-residual.ts';
import {reconcileBuildRootResiduals} from '/tmp/feishu-build-v2-r5/feature-final/server/src/agent/build-runtime/adapter.ts';
import {KbBuildService} from '/tmp/feishu-build-v2-r5/feature-final/server/src/kb/kb-build-service.ts';
const taskId='12345678-1234-4234-8234-123456789abc';
for(const kind of ['exact-duplicate','different-boot-id','different-boot-time','legacy','uppercase-uuid','zero-boot-time','unsafe-boot-time','null-boot-pair','empty-birth']){
 const root=fs.mkdtempSync('/tmp/feishu-build-v2-r5/review/association-'); const buildId='b_boot';const buildRoot=path.join(root,'agent','builds',buildId);const home=path.join(buildRoot,'epochs','e1','home');fs.mkdirSync(home,{recursive:true});process.env.PI_CODING_AGENT_DIR=home;
 const result=recordLaunchAnchor(taskId,{backendRunId:'fixture',pid:999999,pgid:999999,identityToken:Promise.resolve('fixture-token')});assert.equal(result.failure,undefined);assert.equal(await result.tokens,undefined);
 const file=launchAnchorPath(taskId);const anchor=JSON.parse(fs.readFileSync(file,'utf8'));const r=anchor.runs[0];assert.ok(r.bootId&&r.bootTimeMs);
 if(kind.includes('duplicate')||kind.startsWith('different')){const next={...r};if(kind==='different-boot-id')next.bootId=taskId;if(kind==='different-boot-time')next.bootTimeMs+=1;anchor.runs.push(next);}
 if(kind==='legacy'){delete r.bootId;delete r.bootTimeMs;}
 if(kind==='uppercase-uuid')r.bootId=r.bootId.toUpperCase();
 if(kind==='zero-boot-time')r.bootTimeMs=0;
 if(kind==='unsafe-boot-time')r.bootTimeMs=Number.MAX_SAFE_INTEGER+1;
 if(kind==='null-boot-pair'){r.bootId=null;r.bootTimeMs=null;}
 if(kind==='empty-birth')r.rootIdentityToken='';
 fs.writeFileSync(file,JSON.stringify(anchor));const scanned=scanLaunchAnchors(home);const nativeAccepted=!!readLaunchAnchor(taskId);const outcome=await reconcileBuildRootResiduals({buildId,buildRoot,binding:null});const shutdown=await new KbBuildService({dataRoot:root} as any).shutdown({getKbBuild:()=>null,updateKbBuild:()=>undefined} as any,{timeoutMs:100});
 const bad=['zero-boot-time','unsafe-boot-time','null-boot-pair','empty-birth'].includes(kind);assert.equal(scanned.untrusted,bad);assert.equal(outcome?.state,bad?'unconfirmed':'confirmed');assert.equal(shutdown.quiesced,!bad);
 if(!bad){assert.equal(outcome!.children.length,kind.startsWith('different')?2:1);for(const item of scanned.runs){assert.equal(item.bootId,anchor.runs[scanned.runs.indexOf(item)].bootId);assert.equal(item.bootTimeMs,anchor.runs[scanned.runs.indexOf(item)].bootTimeMs);}}
 console.log(JSON.stringify({kind,nativeAccepted,untrusted:scanned.untrusted,runs:scanned.runs,state:outcome?.state,quiesced:shutdown.quiesced,children:outcome?.children.length}));
}
