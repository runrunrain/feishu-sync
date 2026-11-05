// Independent bounded evidence probe; no project or real user settings are changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const repo = '/Users/run.mao/workpace/feishu-sync/.amagi-worktrees/work-local-resources';
const pi = '/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent';
const { PiPluginService } = await import(pathToFileURL(`${repo}/server/src/agent/pi-plugin-service.ts`).href);
const { PiRuntimeResolver } = await import(pathToFileURL(`${repo}/server/src/agent/runtime-resolver.ts`).href);
const { buildDefaultAgentConfig } = await import(pathToFileURL(`${repo}/server/src/types/agent-knowledge.ts`).href);
const { SettingsManager } = await import(pathToFileURL(`${pi}/dist/core/settings-manager.js`).href);
const { DefaultPackageManager } = await import(pathToFileURL(`${pi}/dist/core/package-manager.js`).href);
const { DefaultResourceLoader } = await import(pathToFileURL(`${pi}/dist/core/resource-loader.js`).href);
const { builtInExtensions } = await import(pathToFileURL(`${pi}/dist/extensions/index.js`).href);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'toggle-review-'));
try {
 const user = path.join(root, 'user'); const app = path.join(root, 'app'); const cwd = path.join(root, 'cwd');
 fs.mkdirSync(user); fs.mkdirSync(app); fs.mkdirSync(cwd);
 for (const name of ['a', 'b']) {
   fs.mkdirSync(path.join(user, name));
   fs.writeFileSync(path.join(user, name, 'package.json'), JSON.stringify({name:'same-name',pi:{extensions:['./extension.mjs']}}));
   fs.writeFileSync(path.join(user, name, 'extension.mjs'), 'export default pi=>{}');
 }
 fs.mkdirSync(path.join(user,'skills/secret'),{recursive:true});
 fs.writeFileSync(path.join(user,'skills/secret/SKILL.md'),'---\nname: secret\ndescription: private\n---\nprivate');
 fs.writeFileSync(path.join(user,'settings.json'),JSON.stringify({packages:['./a','./b'],extensions:['!builtin:mcp'],skills:['!skills/secret/**']}));
 const config=buildDefaultAgentConfig(app);
 const service=new PiPluginService({dataRoot:app,resolver:new PiRuntimeResolver(),agentConfig:()=>config,running:()=>false,retireIdle:async()=>{},bundledAmagi:null});
 await service.refresh();
 const overlay=await service.prepareLocalWorkHome(user);
 const settings=JSON.parse(fs.readFileSync(path.join(overlay,'settings.json'),'utf8'));
 const manager=new DefaultPackageManager({cwd,agentDir:overlay,settingsManager:SettingsManager.inMemory(settings),builtinExtensions:['mcp']});
 const resolved=await manager.resolve();
 console.log('OVERLAY',JSON.stringify(settings));
 console.log('ENABLED_MCP',resolved.extensions.filter((r:any)=>r.path==='builtin:mcp'));
 console.log('SECRET_SKILL',resolved.skills.filter((r:any)=>r.path.includes('secret')));
 console.log('SAME_NAME_EXTENSIONS',resolved.extensions.filter((r:any)=>r.path.includes('/a/')||r.path.includes('/b/')));
 const loader=new DefaultResourceLoader({cwd,agentDir:app,settingsManager:SettingsManager.inMemory({}),extensionFactories:builtInExtensions,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,additionalExtensionPaths:['builtin:mcp']});
 await loader.reload();
 console.log('CLOSED_BUILTINS',loader.getExtensions().extensions.map((e:any)=>({path:e.path,tools:[...e.tools.keys()]})));
 console.log('REVISION_BEFORE_PROJECT_CONFIG',service.localWorkRevision(user));
 fs.mkdirSync(path.join(cwd,'.pi'));
 fs.writeFileSync(path.join(cwd,'.pi/settings.json'),JSON.stringify({extensions:[]}));
 console.log('REVISION_AFTER_PROJECT_CONFIG',service.localWorkRevision(user));
} finally {fs.rmSync(root,{recursive:true,force:true});}
