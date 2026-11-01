import fs from 'node:fs';import path from 'node:path';
import {scanV2StoreIntents} from '/tmp/feishu-build-v2-r3/feature-final/server/src/agent/build-runtime/process-residual.ts';
import {reconcileBuildRootResiduals} from '/tmp/feishu-build-v2-r3/feature-final/server/src/agent/build-runtime/adapter.ts';
import {KbBuildService} from '/tmp/feishu-build-v2-r3/feature-final/server/src/kb/kb-build-service.ts';
const taskId='12345678-1234-4234-8234-123456789abc';
for(const kind of ['directory-control','file-at-task-id','dangling-link-at-task-id']){
 const root=fs.mkdtempSync('/tmp/feishu-build-v2-r3/review/task-entry-'),buildId='b_taskentry',buildRoot=path.join(root,'agent','builds',buildId),home=path.join(buildRoot,'epochs','e1','home'),task=path.join(home,'amagi','v2-store',taskId);
 fs.mkdirSync(task,{recursive:true});fs.writeFileSync(path.join(task,'current.json'),JSON.stringify({taskId,execution:'running',processState:'alive'}));
 if(kind!=='directory-control'){fs.unlinkSync(path.join(task,'current.json'));fs.rmdirSync(task);if(kind==='file-at-task-id')fs.writeFileSync(task,'task-directory-corrupted');else fs.symlinkSync(path.join(root,'missing-task-directory'),task);}
 let readError:string|null=null;try{fs.readFileSync(path.join(task,'current.json'));}catch(e){readError=(e as NodeJS.ErrnoException).code??null;}
 const result={kind,taskId,taskPathType:fs.lstatSync(task).isSymbolicLink()?'symlink':fs.lstatSync(task).isDirectory()?'directory':'file',currentReadError:readError,scan:scanV2StoreIntents(home,new Set(),false),outcome:await reconcileBuildRootResiduals({buildId,buildRoot,binding:null},{reap:false,includeLeaders:false}),shutdown:await new KbBuildService({dataRoot:root} as any).shutdown({} as any,{timeoutMs:100})};
 console.log(JSON.stringify(result));
}
