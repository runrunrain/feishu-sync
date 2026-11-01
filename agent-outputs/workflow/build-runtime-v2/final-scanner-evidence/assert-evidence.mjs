import fs from 'node:fs';
import assert from 'node:assert/strict';
const here=new URL('.',import.meta.url);
const read=(name)=>fs.readFileSync(new URL(name,here),'utf8').trim().split('\n').map(JSON.parse);
const rows=read('scanner-probe-run.log');assert.equal(rows.length,74);
const get=n=>{const r=rows.find(r=>r.name===n);assert.ok(r,n);return r;};
const result=(n,state,quiesced)=>{const r=get(n);assert.equal(r.state,state,n);assert.equal(r.quiesced,quiesced,n);};
for(const n of ['epoch-file','legacy-file','home-dangling','epoch-dangling','audit-root-dangling','audit-task-dangling','anchor-file-dangling','store-root-dangling','task-file','task-link','ancestor-dangling','unknown-execution','unknown-process','anchor/rootPid/999999.5','anchor/pgid/999999.5','anchor/leaderPid/999998.5','anchor/at/-1','anchor/rootIdentityToken/23','dropped/-1','dropped/1','dropped/0.5','dropped/bad','dropped/null'])result(n,'unconfirmed',false);
for(const execution of ['queued','running','blocked','answering','done','error','answered','cancelled','truncated','resolved-external'])for(const p of ['alive','unknown','exited','not-started']){const n=execution+'/'+p;assert.equal(get(n).nativeCurrent,true,n);const unknown=p==='alive'||p==='unknown'||(p==='not-started'&&['queued','running','blocked','answering'].includes(execution));result(n,unknown?'unconfirmed':'confirmed',!unknown);}
for(const n of ['empty','auxiliary','native-valid-current','native-valid-anchor','dropped/0'])result(n,'confirmed',true);
// Assert observed remaining failure, not pretend this is a passing product contract.
assert.equal(get('missing-process').nativeCurrent,false);result('missing-process','confirmed',true);
for(const n of ['anchor/bootId/bad','anchor/bootTimeMs/-1']){assert.equal(get(n).nativeAnchor,false);result(n,'confirmed',true);}
const native=read('native-shape-probe.log');assert.equal(native.length,6);
for(const n of ['bootId-only','bootTime-only','boot-bad-type']){const r=native.find(r=>r.kind===n);assert.equal(r.nativeAccepted,false);assert.equal(r.untrusted,false);assert.equal(r.state,'confirmed');assert.equal(r.quiesced,true);assert.equal(r.children[0].verdict,'exited');}
console.log('74 matrix rows + 6 native producer rows: observed outcomes independently asserted. Remaining missing-processState and malformed boot evidence reproduce false confirmed/quiesced.');
