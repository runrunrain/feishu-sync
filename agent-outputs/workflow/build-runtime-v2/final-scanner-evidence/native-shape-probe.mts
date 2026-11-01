import fs from 'node:fs';
import path from 'node:path';
import { recordLaunchAnchor, readLaunchAnchor, launchAnchorPath } from '/tmp/feishu-build-v2-r2/amagi-pi-2.21.31/extensions/amagi-core/launch-anchor.ts';
import { scanLaunchAnchors } from '/tmp/feishu-build-v2-r4/feature-final/server/src/agent/build-runtime/process-residual.ts';
import { reconcileBuildRootResiduals } from '/tmp/feishu-build-v2-r4/feature-final/server/src/agent/build-runtime/adapter.ts';
import { KbBuildService } from '/tmp/feishu-build-v2-r4/feature-final/server/src/kb/kb-build-service.ts';
const taskId='12345678-1234-4234-8234-123456789abc';
for(const kind of ['valid','bootId-only','bootTime-only','boot-bad-type','birth-bad-type','pgid-null']) {
 const root=fs.mkdtempSync('/tmp/feishu-build-v2-r4/review/native-shape-');const buildId='b_native';const buildRoot=path.join(root,'agent','builds',buildId);const home=path.join(buildRoot,'epochs','e1','home');fs.mkdirSync(home,{recursive:true});process.env.PI_CODING_AGENT_DIR=home;
 // Call the real producer, including synchronous boot and async token patching.
 // No subprocess spawned; root pid is an explicitly synthetic absent fixture.
 const record=recordLaunchAnchor(taskId,{backendRunId:'fixture-run',pid:999999,pgid:999999,identityToken:Promise.resolve('fixture-root-token')});
 if(record.failure)throw Error(record.failure);const failure=await record.tokens;if(failure)throw Error(failure);
 const file=launchAnchorPath(taskId);const anchor=JSON.parse(fs.readFileSync(file,'utf8'));const run=anchor.runs[0];
 if(kind==='bootId-only')delete run.bootTimeMs;
 if(kind==='bootTime-only')delete run.bootId;
 if(kind==='boot-bad-type'){run.bootId=23;run.bootTimeMs=-1;}
 if(kind==='birth-bad-type')run.rootIdentityToken=23;
 if(kind==='pgid-null')run.pgid=null;
 fs.writeFileSync(file,JSON.stringify(anchor));
 const nativeAccepted=!!readLaunchAnchor(taskId);const scanned=scanLaunchAnchors(home);const outcome=await reconcileBuildRootResiduals({buildId,buildRoot,binding:null});const report=await new KbBuildService({dataRoot:root} as any).shutdown({getKbBuild:()=>null,updateKbBuild:()=>undefined} as any,{timeoutMs:100});
 console.log(JSON.stringify({kind,nativeAccepted,run,untrusted:scanned.untrusted,state:outcome?.state,quiesced:report.quiesced,children:outcome?.children}));
}
