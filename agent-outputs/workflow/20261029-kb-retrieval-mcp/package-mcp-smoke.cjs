// Synthetic-only packaged-runtime smoke; no real user data or credentials.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const server = process.argv[2], root = process.argv[3];
if (!server || !root || !process.versions.electron || process.env.ELECTRON_RUN_AS_NODE !== '1') throw Error('need packaged Electron server and synthetic root');
const req = createRequire(path.join(server, 'package.json'));
const { Client } = req('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = req('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = req('@modelcontextprotocol/sdk/client/streamableHttp.js');
const release = path.join(root, 'releases', 'fixture-r1');
fs.mkdirSync(path.join(release, 'docs'), { recursive: true });
const body = '<!--\nfeishu_sync_kb:\n  doc_id: synthetic\n  sources:\n    - fixture\n  build_id: b_fixture-r1\n-->\n# 合成伤害\n## 暴击规则\n暴击伤害按倍率计算。\n';
fs.writeFileSync(path.join(release, 'docs', 'synthetic.md'), body);
const contentHash = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
const manifest = {schemaVersion:1, releaseId:'fixture-r1', buildId:'b_fixture-r1', mode:'full', baseReleaseId:null, publishedAt:'2026-10-29T00:00:00Z', model:'fixture', sourceSnapshot:[], docs:[{docId:'synthetic',path:'synthetic.md',title:'合成伤害',summary:'暴击伤害',headings:[],tags:[],sources:['fixture'],contentHash,updatedInBuild:'b_fixture-r1'}],skippedSources:[]};
fs.writeFileSync(path.join(release, 'manifest.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(root, 'CURRENT.json'), JSON.stringify({schemaVersion:1,releaseId:'fixture-r1',publishedAt:manifest.publishedAt}));
const childEnv = { PATH: process.env.PATH, HOME: root, ELECTRON_RUN_AS_NODE:'1', FEISHU_SYNC_HOME:root };
async function query(client, name) {
  const list = await client.listTools(); assert.equal(list.tools.length, 7);
  const result = await client.callTool({name:'search_knowledge', arguments:{query:'暴击 伤害'}});
  assert.notEqual(result.isError, true);
  const text = result.content[0].text, data = JSON.parse(text);
  console.log(`${name} synthetic search response:`, JSON.stringify(data));
  assert.equal(data.releaseId,'fixture-r1'); assert.ok(data.results.some(x=>x.docId==='synthetic'));
  const read = await client.callTool({name:'get_knowledge',arguments:{path:'synthetic.md',releaseId:'fixture-r1'}});
  assert.notEqual(read.isError,true); assert.ok(read.content[0].text.includes('暴击伤害按倍率计算'));
  console.log(`${name}: 7 tools, search hit synthetic, document text verified`);
}
async function freePort() { const s=net.createServer(); await new Promise((ok,fail)=>s.once('error',fail).listen(0,'127.0.0.1',ok)); const p=s.address().port; await new Promise(ok=>s.close(ok)); return p; }
async function main() {
  const client = new Client({name:'candidate-smoke',version:'1'});
  try { await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(server,'dist/mcp/kb-mcp.cjs'),'--kb-root',root],env:childEnv})); await query(client,'stdio'); } finally { await client.close(); }
  const port=await freePort(); const token='fskb_'+crypto.randomBytes(32).toString('base64url');
  const child=spawn(process.execPath,[path.join(server,'dist/mcp/kb-mcp-gateway.cjs'),'--kb-root',root,'--host','127.0.0.1','--port',String(port)],{env:{...childEnv,KB_LAN_TOKEN_SHA256:crypto.createHash('sha256').update(token).digest('hex')},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',b=>output+=b); child.stderr.resume();
  try {
    const deadline=Date.now()+10000;
    while (!output.includes('"type":"ready"')) { if(child.exitCode!==null)throw Error('gateway exited before ready'); if(Date.now()>deadline)throw Error('gateway ready timeout'); await new Promise(r=>setTimeout(r,50)); }
    const httpClient=new Client({name:'candidate-smoke-http',version:'1'});
    try { await httpClient.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`),{requestInit:{headers:{Authorization:`Bearer ${token}`}}})); await query(httpClient,'loopback HTTP'); } finally { await httpClient.close(); }
  } finally {
    if (child.exitCode===null && child.signalCode===null) await new Promise(resolve=>{ const timer=setTimeout(()=>child.kill('SIGKILL'),3000); child.once('close',()=>{clearTimeout(timer);resolve();}); child.kill('SIGTERM'); });
    console.log('gateway child reaped',child.exitCode,child.signalCode);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1});
