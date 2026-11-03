// Incremental independent evidence: real Pi CLI + SDK; no mock; temporary data only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {installAmagiFromGit,amagiInstallDir,INSTALL_RECORD_FILENAME} from '../../../../server/src/agent/build-runtime/amagi-package.ts';
import {resolveGlobalPiAgentDir,scanAmagiHome} from '../../../../server/src/agent/build-runtime/amagi-discovery.ts';
const root=fs.mkdtempSync('/tmp/plugin-install-fix-review-r2-');
const sdk='/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent';
const helper=path.join(process.cwd(),'server/src/agent/pi-extension');
const realHome=process.env.HOME!;
const settings=path.join(realHome,'.pi/agent/settings.json');
const sha=()=>fs.existsSync(settings)?crypto.createHash('sha256').update(fs.readFileSync(settings)).digest('hex'):null;
const before=sha();
process.env.FEISHU_SYNC_HOME=path.join(root,'data');process.env.PI_CODING_AGENT_DIR=path.join(root,'home');
const common={nodePath:process.execPath,piCliPath:path.join(sdk,'dist/bundle/cli.js'),piPackageRoot:sdk,helperPackageRoot:helper,version:'2.21.31'};
console.log('ROOT',root);
const dataRoot=path.join(root,'positive');
const installed=await installAmagiFromGit({...common,dataRoot});
const again=await installAmagiFromGit({...common,dataRoot});
assert.equal(installed.fresh,true);assert.equal(again.fresh,false);assert.equal(installed.contentHash,again.contentHash);
assert.equal(installed.record.acquisition?.commit,'929000ecbd8725e72b191493345d6abeef51c147');
const canonical=installed.record.acquisition!.acquiredPackageRoot;
assert.equal(canonical.startsWith('/private/tmp/'),true); // this host's /tmp alias must canonicalize
const moved=path.join(root,'moved "q" `x` $HOME');fs.renameSync(installed.installDir,moved);
const bin=path.join(moved,'package/node_modules/.bin/typescript-language-server');
assert.equal(fs.lstatSync(bin).isSymbolicLink(),false);
assert.equal(fs.readFileSync(bin,'utf8').includes('.acquire-'),false);
assert.equal(execFileSync(bin,['--version'],{encoding:'utf8'}).trim(),'6.0.0');
console.log('DEFAULT_REPEAT_MOVED_BIN_PASS',JSON.stringify({commit:installed.record.acquisition?.commit,canonical:true,version:'6.0.0'}));
for(const kind of ['package','git','root']){
 const dataRoot=path.join(root,'negative-'+kind);let swapped=false;let code='';
 try{
  await installAmagiFromGit({...common,dataRoot,log:line=>{
   if(swapped||!line.includes('install stdout 尾部'))return;
   const parent=path.join(dataRoot,'agent/runtime-packages');
   const acquire=path.join(parent,fs.readdirSync(parent).find(x=>x.startsWith('.acquire-'))!);
   const from=kind==='root'?acquire:kind==='git'?path.join(acquire,'git'):path.join(acquire,'git/github.com/runrunrain/amagi-pi');
   const outside=path.join(root,'outside-'+kind);fs.renameSync(from,outside);fs.symlinkSync(outside,from,'dir');swapped=true;
  }});
 }catch(e:any){code=e.code;}
 assert.equal(swapped,true);assert.equal(code,'amagi_acquisition_incomplete');
 const record=fs.existsSync(path.join(amagiInstallDir(dataRoot,'2.21.31'),INSTALL_RECORD_FILENAME));assert.equal(record,false);
 console.log('REAL_SYMLINK_REJECT',JSON.stringify({kind,code,record}));
}
// Repeat original tilde discrepancy with a real local manifest and the official parser.
const home=path.join(root,'tilde-home');const agentDir=path.join(home,'.pi/agent');const pkg=path.join(root,'candidate36');
fs.mkdirSync(agentDir,{recursive:true});fs.mkdirSync(pkg);fs.writeFileSync(path.join(pkg,'package.json'),JSON.stringify({name:'amagi-pi',version:'2.21.36'}));
fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({packages:[pkg]}));
process.env.HOME=home;process.env.PI_CODING_AGENT_DIR='~/.pi/agent';
const {getAgentDir}=await import(pathToFileURL(path.join(sdk,'dist/config.js')).href);
const official=path.resolve(getAgentDir());const app=resolveGlobalPiAgentDir();assert.equal(app,official);assert.equal(resolveGlobalPiAgentDir({PI_CODING_AGENT_DIR:'~'}),home);
const result=await scanAmagiHome({nodePath:process.execPath,piPackageRoot:sdk,helperPackageRoot:helper,agentDir:app,origin:'global-pi-home',pinnedVersion:'2.21.31'});
assert.equal(result.candidates.length,1);assert.equal(result.candidates[0].version,'2.21.36');assert.equal(result.candidates[0].matchesPin,false);
process.env.HOME=realHome;
console.log('TILDE_REAL_SDK_PASS',JSON.stringify({equal:app===official,candidates:result.candidates.length,version:result.candidates[0].version,matchesPin:false}));
assert.equal(sha(),before);console.log('GLOBAL_SETTINGS_SHA_UNCHANGED',true);
console.log('R2_PROBE_PASS');
