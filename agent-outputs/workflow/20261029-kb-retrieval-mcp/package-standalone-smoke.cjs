// Synthetic §13.10 standalone product entry -> desktop management API -> child MCP gateway.
// No production data, credentials, client configuration, npm installation, or remote model.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const crypto = require('node:crypto'), net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../../..'), server = path.join(repo, 'server');
const req = createRequire(path.join(server, 'package.json'));
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function probePort(port) {
  const s=net.createServer();
  try { await new Promise((ok,fail)=>s.once('error',fail).listen(port,'127.0.0.1',ok)); const actual=s.address().port; await new Promise(ok=>s.close(ok)); return actual; }
  catch(e) { if(e.code==='EADDRINUSE') throw Error(`port ${port} occupied; no process was touched`); throw e; }
}
function ownsListener(pid,port) {
  const r=spawnSync('/usr/sbin/lsof',['-nP','-a','-p',String(pid),`-iTCP:${port}`,'-sTCP:LISTEN','-Fn'],{encoding:'utf8'});
  return r.status===0 && r.stdout.split('\n').some(x=>x.startsWith('n')&&x.endsWith(`:${port}`));
}
async function waitFor(fn,label,ms=12000) {const until=Date.now()+ms; while(Date.now()<until){if(await fn())return;await sleep(75);}throw Error(`${label} timeout`);}
function fixture(kb) {
  const rel=path.join(kb,'releases','fixture-r1');fs.mkdirSync(path.join(rel,'docs'),{recursive:true});
  const content='<!--\nfeishu_sync_kb:\n  doc_id: synthetic\n  sources:\n    - fixture\n  build_id: b_fixture-r1\n-->\n# 合成伤害\n## 暴击规则\n暴击伤害按倍率计算。\n';
  fs.writeFileSync(path.join(rel,'docs','synthetic.md'),content);
  const m={schemaVersion:1,releaseId:'fixture-r1',buildId:'b_fixture-r1',mode:'full',baseReleaseId:null,publishedAt:'2026-10-29T00:00:00Z',model:'fixture',sourceSnapshot:[],docs:[{docId:'synthetic',path:'synthetic.md',title:'合成伤害',summary:'暴击伤害',headings:[],tags:[],sources:['fixture'],contentHash:'sha256:'+crypto.createHash('sha256').update(content).digest('hex'),updatedInBuild:'b_fixture-r1'}],skippedSources:[]};
  fs.writeFileSync(path.join(rel,'manifest.json'),JSON.stringify(m));fs.writeFileSync(path.join(kb,'CURRENT.json'),JSON.stringify({schemaVersion:1,releaseId:'fixture-r1',publishedAt:m.publishedAt}));
}
async function main() {
  const requested=Number(process.env.STANDALONE_SMOKE_PORT ?? '3001');
  if (!Number.isInteger(requested) || requested < 0 || requested > 65535) throw Error('invalid STANDALONE_SMOKE_PORT');
  const mainPort=await probePort(requested);
  if (requested===0 && mainPort===3001) throw Error('automatic port selected protected port 3001');
  console.log(`preflight: 127.0.0.1:${mainPort} free`);
  let port; do { port=await probePort(0); } while(port===mainPort || port===3001);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feishu-standalone-smoke-'));
  const data=path.join(root,'data'),kb=path.join(root,'kb'),raw=path.join(root,'raw'),home=path.join(root,'home');
  for(const p of [data,kb,raw,home])fs.mkdirSync(p,{recursive:true,mode:0o700}); fixture(kb);
  fs.writeFileSync(path.join(data,'config.json'),JSON.stringify({knowledgeBaseRoot:raw,standardKb:{outputRoot:kb},agent:{},cli:{enabled:false},kbLanMcp:{enabled:false,bindAddress:'127.0.0.1',port,maxSessions:16}}),{mode:0o600});
  const log=path.join(root,'standalone.log'),fd=fs.openSync(log,'wx',0o600),desktop=crypto.randomBytes(32).toString('base64url');
  const env={PATH:process.env.PATH,HOME:home,TMPDIR:root,FEISHU_SYNC_HOME:data,FEISHU_SYNC_DEV_TOKEN:desktop,FEISHU_SYNC_PORT:String(mainPort),NODE_ENV:'test'};
  const child=spawn(process.execPath,[path.join(server,'dist/index.js')],{cwd:server,env,stdio:['ignore',fd,fd]});fs.closeSync(fd);
  let done=false, enabled=false, client, gatewayToken=null, success=false;
  const ended=new Promise(resolve=>child.once('close',(code,signal)=>{done=true;resolve({code,signal});}));
  const api=async(route,method='GET',body)=>{const r=await fetch(`http://127.0.0.1:${mainPort}`+route,{method,headers:{'X-Desktop-Token':desktop,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000)});if(r.status!==200)throw Error(`management ${route} status ${r.status}`);return r.json();};
  try {
    await waitFor(()=>{if(done)throw Error('standalone exited before listening');return ownsListener(child.pid,mainPort);},'owned main listener');
    const health=await fetch(`http://127.0.0.1:${mainPort}/api/health`,{signal:AbortSignal.timeout(3000)});assert.equal(health.status,200);
    assert.equal((await api('/api/kb-lan-mcp/status')).state,'disabled');console.log(`main listener: owned PID, 127.0.0.1:${mainPort} health 200, gateway disabled`);
    await api('/api/kb-lan-mcp/enable','POST',{bindAddress:'127.0.0.1',port});enabled=true;
    await waitFor(async()=>{if(done)throw Error('standalone exited');return (await api('/api/kb-lan-mcp/status')).state==='running';},'gateway running');
    gatewayToken=(await api('/api/kb-lan-mcp/token/reveal','POST')).token;assert.ok(typeof gatewayToken==='string'&&gatewayToken.startsWith('fskb_'));
    client=new Client({name:'standalone-synthetic-smoke',version:'1'});
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${gatewayToken}`}}}));
    assert.equal((await client.listTools()).tools.length,7);
    const result=await client.callTool({name:'search_knowledge',arguments:{query:'暴击 伤害'}});assert.notEqual(result.isError,true);
    const parsed=JSON.parse(result.content[0].text);assert.equal(parsed.releaseId,'fixture-r1');assert.ok(parsed.results.some(x=>x.docId==='synthetic'));
    assert.equal((await fetch(`http://127.0.0.1:${mainPort}/api/health`,{signal:AbortSignal.timeout(3000)})).status,200);
    console.log('gateway: loopback running; SDK listed seven tools; synthetic search hit; main health remains 200');
    await client.close();client=null;
    const disabled=await api('/api/kb-lan-mcp/disable','POST',{revokeToken:true});enabled=false;assert.equal(disabled.state,'disabled');if ((await api('/api/kb-lan-mcp/token/reveal','POST')).token !== null) throw Error('gateway token not revoked');
    let closed=false;try{await fetch(`http://127.0.0.1:${port}/mcp`,{signal:AbortSignal.timeout(3000)});}catch{closed=true;}assert.ok(closed,'gateway listener must close');
    console.log('disable: state disabled, token revoked, gateway connection refused');success=true;
  } finally {
    if(client)await client.close().catch(()=>{});
    if(enabled&&!done)await api('/api/kb-lan-mcp/disable','POST',{revokeToken:true}).catch(()=>{});
    if(!done)child.kill('SIGTERM');let timer;const outcome=await Promise.race([ended,new Promise(resolve=>{timer=setTimeout(()=>{child.kill('SIGKILL');resolve(null);},6000);})]);clearTimeout(timer);if(!outcome)await ended;
    const bytes=fs.readFileSync(log,'utf8');const mode=fs.statSync(log).mode&0o777;const leak=bytes.includes(desktop)||(gatewayToken!==null&&bytes.includes(gatewayToken));
    console.log('cleanup: child closed',outcome!==null,'exit',outcome?.code??null,'signal',outcome?.signal??null,'log mode',mode.toString(8),'token leak',leak,'fixture root',root);
    if(mode!==0o600||leak||!outcome||outcome.code!==0)throw Error('cleanup/log safety check failed');
  }
  if(!success)throw Error('standalone validation incomplete');
}
main().catch(e=>{console.error('standalone smoke failed:',e.message);process.exitCode=1;});
