import fs from 'node:fs';import path from 'node:path';
import { KbBuildService } from '/tmp/feishu-build-v2-feature-tree/server/src/kb/kb-build-service.ts';
import { RawSourceSnapshot } from '/tmp/feishu-build-v2-feature-tree/server/src/kb/raw-source-snapshot.ts';
const root=fs.mkdtempSync('/tmp/feishu-build-v2-incremental-review/publish-');const out=path.join(root,'out'),stage=path.join(out,'.staging/b1'),kb=path.join(root,'kb');fs.mkdirSync(path.join(stage,'docs'),{recursive:true});fs.mkdirSync(kb);
const doc=path.join(stage,'docs/a.md');fs.writeFileSync(doc,'<!--\nfeishu_sync_kb:\n  doc_id: d1\n  sources: []\n-->\n# Title\naccepted fixture draft\n');
const svc=new KbBuildService({dataRoot:path.join(root,'data'),documentsProvider:()=>[],sheetCsvPaths:()=>[],configProvider:()=>({standardKb:{outputRoot:out},knowledgeBaseRoot:kb})} as any);
try{await (svc as any).publishRelease({buildId:'b1',releaseId:'r_probe',mode:'full',baseReleaseId:null,model:null,snapshot:RawSourceSnapshot.fromEntries([],{knowledgeBaseRoot:kb,sheetCsvPaths:()=>[]}),stagingRoot:stage,outputRoot:out,docMeta:new Map(),knowledgeBaseRoot:kb,preCommitLease:()=>{throw Error('run_token_invalid: revoked');}});}catch(e){console.log('LEASE_REJECTED',String(e));}
console.log('POST_ABORT',JSON.stringify({stagingDocs:fs.existsSync(path.join(stage,'docs')),acceptedDraft:fs.existsSync(doc),release:fs.existsSync(path.join(out,'releases/r_probe')),current:fs.existsSync(path.join(out,'CURRENT.json'))}));
