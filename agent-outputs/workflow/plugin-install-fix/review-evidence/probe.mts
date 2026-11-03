// Independent evidence only; real SDK/CLI; no production writes or auth reads.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {installAmagiFromGit, installAmagiPackage, acquireAmagiFromGit, verifyAmagiPackage} from '../../../../server/src/agent/build-runtime/amagi-package.ts';
import {scanAmagiHome, resolveGlobalPiAgentDir} from '../../../../server/src/agent/build-runtime/amagi-discovery.ts';
const repo=process.cwd();
const base=fs.mkdtempSync('/tmp/plugin-install-fix-review-');
const sdk='/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent';
const cli=path.join(sdk,'dist/bundle/cli.js');
const helper=path.join(repo,'server/src/agent/pi-extension');
const home=path.join(base,'home');fs.mkdirSync(home);
const oldGlobal=process.env.PI_CODING_AGENT_DIR;
const globalSettings=path.join(process.env.HOME!,'.pi/agent/settings.json');
const sha=(p:string)=>fs.existsSync(p)?crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'):null;
const before=sha(globalSettings);
process.env.FEISHU_SYNC_HOME=path.join(base,'data');process.env.PI_CODING_AGENT_DIR=path.join(home,'.pi/agent');
const common={nodePath:process.execPath,piCliPath:cli,piPackageRoot:sdk,helperPackageRoot:helper,version:'2.21.31'};
console.log('TEMP_ROOT',base);
// Real default installation, repeat hash, and CLI after moving the frozen directory.
const installed=await installAmagiFromGit({...common,dataRoot:path.join(base,'default')});
const again=await installAmagiFromGit({...common,dataRoot:path.join(base,'default')});
console.log('REAL_DEFAULT',JSON.stringify({version:installed.version,fresh:installed.fresh,repeatFresh:again.fresh,hashEqual:installed.contentHash===again.contentHash,commit:installed.record.acquisition?.commit}));
const moved=path.join(base,'moved frozen "q" $HOME `x`');fs.renameSync(installed.installDir,moved);
console.log('REAL_BIN_MOVED',execFileSync(path.join(moved,'package/node_modules/.bin/typescript-language-server'),['--version'],{encoding:'utf8'}).trim());
// Synthetic local source with hostile *relative target* (not merely acquisition root).
const src=path.join(base,'source');const targetName='strange "q" $HOME `x`';
fs.mkdirSync(path.join(src,'node_modules',targetName),{recursive:true});fs.mkdirSync(path.join(src,'node_modules/.bin'));
fs.writeFileSync(path.join(src,'package.json'),JSON.stringify({name:'amagi-pi',version:'2.21.31',pi:{extensions:[]}}));
const target=path.join(src,'node_modules',targetName,'cli.mjs');fs.writeFileSync(target,'#!/usr/bin/env node\nconsole.log(JSON.stringify({url:import.meta.url,args:process.argv.slice(2)}));\n',{mode:0o755});
fs.symlinkSync(path.join('..',targetName,'cli.mjs'),path.join(src,'node_modules/.bin/hostile'));
const custom=await installAmagiPackage({...common,dataRoot:path.join(base,'custom'),sourceDir:src,includeDependencies:true});
const out=JSON.parse(execFileSync(path.join(custom.packageRoot,'node_modules/.bin/hostile'),['a b','"','`','$HOME'],{encoding:'utf8'}));
console.log('HOSTILE_RELATIVE_TARGET',JSON.stringify({correctTarget:out.url===pathToFileURL(fs.realpathSync(path.join(custom.packageRoot,'node_modules',targetName,'cli.mjs'))).href,args:out.args,shim:fs.readFileSync(path.join(custom.packageRoot,'node_modules/.bin/hostile'),'utf8')}));
const outsideTarget=path.join(base,'external-cli.mjs');fs.writeFileSync(outsideTarget,'#!/usr/bin/env node\n',{mode:0o755});fs.symlinkSync(outsideTarget,path.join(src,'node_modules/.bin/outside'));
try {await installAmagiPackage({...common,dataRoot:path.join(base,'external-negative'),sourceDir:src,includeDependencies:true}); console.log('OUTSIDE_UNEXPECTED_ACCEPT');}catch(e:any){console.log('OUTSIDE_REJECT',e.code);}
fs.appendFileSync(path.join(custom.packageRoot,'package.json'),' ');
try{verifyAmagiPackage({dataRoot:path.join(base,'custom'),version:'2.21.31'});console.log('DRIFT_UNEXPECTED_ACCEPT');}catch(e:any){console.log('DRIFT_REJECT',e.code);}
// Real SDK read-only mode for missing declarations / broken settings / absent home.
const scanHome=path.join(base,'scan');fs.mkdirSync(scanHome);fs.writeFileSync(path.join(scanHome,'settings.json'),JSON.stringify({packages:['npm:amagi-pi@2.21.31','git:github.com/runrunrain/amagi-pi@929000ecbd8725e72b191493345d6abeef51c147']}));
const scan=(agentDir:string)=>scanAmagiHome({nodePath:process.execPath,piPackageRoot:sdk,helperPackageRoot:helper,agentDir,origin:'global-pi-home',pinnedVersion:'2.21.31'});
const scanBefore=sha(path.join(scanHome,'settings.json'));const scanned=await scan(scanHome);
console.log('SDK_MISSING',JSON.stringify({status:scanned.status,candidates:scanned.candidates,settingsUnchanged:scanBefore===sha(path.join(scanHome,'settings.json')),files:fs.readdirSync(scanHome)}));
fs.writeFileSync(path.join(scanHome,'settings.json'),'{broken');const broken=await scan(scanHome);console.log('SDK_BROKEN',JSON.stringify({status:broken.status,errors:broken.settingsErrors.length}));
await scan(path.join(base,'absent'));console.log('SDK_ABSENT_CREATED',fs.existsSync(path.join(base,'absent')));
// Compare official home parser and application's parser on official supported tilde override.
const realHome=process.env.HOME;process.env.HOME=home;process.env.PI_CODING_AGENT_DIR='~/.pi/agent';
const officialHome=path.join(home,'.pi/agent');fs.mkdirSync(officialHome,{recursive:true});
const pkg36=path.join(base,'candidate36');fs.mkdirSync(pkg36);fs.writeFileSync(path.join(pkg36,'package.json'),JSON.stringify({name:'amagi-pi',version:'2.21.36'}));fs.writeFileSync(path.join(officialHome,'settings.json'),JSON.stringify({packages:[pkg36]}));
const {getAgentDir}=await import(pathToFileURL(path.join(sdk,'dist/config.js')).href);
const official=getAgentDir();const app=resolveGlobalPiAgentDir();console.log('TILDE_HOME',JSON.stringify({official,app,equal:path.resolve(official)===app}));
console.log('TILDE_SCAN',JSON.stringify({officialCandidates:(await scan(path.resolve(official))).candidates.length,appCandidates:(await scan(app)).candidates.length,appStatus:(await scan(app)).status}));process.env.HOME=realHome;
// Acquisition-root adversarial substitution after the real CLI completed, before SDK lookup.
// Represents a symlinked result; real CLI and SDK are NOT replaced. All files remain in this temporary root.
let swapped=false;
const external=path.join(base,'outside-acquisition');
const acq=await acquireAmagiFromGit({...common,dataRoot:path.join(base,'containment'),log:(line:string)=>{
 if(swapped||!line.includes('install stdout 尾部'))return;
 const roots=fs.readdirSync(path.join(base,'containment/agent/runtime-packages')).filter(x=>x.startsWith('.acquire-'));
 const p=path.join(base,'containment/agent/runtime-packages',roots[0],'git/github.com/runrunrain/amagi-pi');
 fs.renameSync(p,external);fs.symlinkSync(external,p);swapped=true;
}});
console.log('ACQUISITION_CONTAINER',JSON.stringify({accepted:true,lexical:acq.packageRoot,real:fs.realpathSync(acq.packageRoot),realInside:fs.realpathSync(acq.packageRoot).startsWith(fs.realpathSync(acq.acquisitionRoot)+path.sep),head:acq.acquisition.commit}));
const escapedInstall=await installAmagiPackage({...common,dataRoot:path.join(base,'outside-materialized'),sourceDir:acq.packageRoot,includeDependencies:true,acquisition:acq.acquisition});console.log('OUTSIDE_MATERIALIZED',JSON.stringify({fresh:escapedInstall.fresh,verified:verifyAmagiPackage({dataRoot:path.join(base,'outside-materialized'),version:'2.21.31'}).contentHash===escapedInstall.contentHash}));
console.log('GLOBAL_SETTINGS_SHA_UNCHANGED',before===sha(globalSettings));
console.log('ORIGINAL_GLOBAL_OVERRIDE_PRESENT',Boolean(oldGlobal));
