// Evidence-only dependency resolution: no frozen upstream source changes.
import {registerHooks, createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const req=createRequire('/Users/run.mao/.local/share/fnm/node-versions/v24.21.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/package.json');
const typeboxUrl=pathToFileURL(req.resolve('typebox')).href;
registerHooks({resolve(specifier,context,nextResolve){
 if(specifier==='typebox')return {url:typeboxUrl,shortCircuit:true};
 return nextResolve(specifier,context);
}});
