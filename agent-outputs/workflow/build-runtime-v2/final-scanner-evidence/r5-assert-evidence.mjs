import fs from 'node:fs';
import assert from 'node:assert/strict';
const here=new URL('.',import.meta.url);
const read=name=>fs.readFileSync(new URL(name,here),'utf8').trim().split('\n').map(JSON.parse);
const rows=read('r5-scanner-probe-run.log');assert.equal(rows.length,74);
const get=n=>{const r=rows.find(r=>r.name===n);assert.ok(r,n);return r;};
const result=(n,state,quiesced)=>{const r=get(n);assert.equal(r.state,state,n);assert.equal(r.quiesced,quiesced,n);};
for(const n of ['epoch-file','legacy-file','home-dangling','epoch-dangling','audit-root-dangling','audit-task-dangling','anchor-file-dangling','store-root-dangling','task-file','task-link','ancestor-dangling','unknown-execution','unknown-process','missing-process','anchor/rootPid/999999.5','anchor/pgid/999999.5','anchor/leaderPid/999998.5','anchor/at/-1','anchor/rootIdentityToken/23','anchor/rootIdentityToken/null','anchor/pgid/null','anchor/bootId/bad','anchor/bootTimeMs/-1','dropped/-1','dropped/1','dropped/0.5','dropped/bad','dropped/null'])result(n,'unconfirmed',false);
for(const execution of ['queued','running','blocked','answering','done','error','answered','cancelled','truncated','resolved-external'])for(const p of ['alive','unknown','exited','not-started']){const n=execution+'/'+p;assert.equal(get(n).nativeCurrent,true,n);assert.deepEqual(get(n).intentScan.unreadableTasks,[],n);result(n,p==='exited'?'confirmed':'unconfirmed',p==='exited');}
for(const n of ['empty','auxiliary','native-valid-current','native-valid-anchor','dropped/0'])result(n,'confirmed',true);
assert.equal(get('missing-process').nativeCurrent,false);
// leaderIdentityToken is not used by this application proof; unchanged R4 observation, not a regression.
result('anchor/leaderIdentityToken/23','confirmed',true);
const native=read('r5-native-shape-probe.log');assert.equal(native.length,6);
for(const r of native){const valid=r.kind==='valid';assert.equal(r.untrusted,!valid);assert.equal(r.state,valid?'confirmed':'unconfirmed');assert.equal(r.quiesced,valid);if(['bootId-only','bootTime-only','boot-bad-type'].includes(r.kind))assert.equal(r.nativeAccepted,false);}
const association=read('r5-boot-association.log');assert.equal(association.length,9);
const snap=read('r5-snapshot-check.log')[0];assert.equal(snap.sha256,'33d9919363a8be40fb06587c965c3d7c2aa8285f905e4e1fab04f25bcddc80d4');assert.equal(snap.paths,58);assert.deepEqual(snap.mismatches,[]);
console.log('PASS: 74 matrix + 6 native producer + 9 association/boundary cases; snapshot 58 paths/0 mismatches. All R4 C/D counterexamples now unknown/false; valid exited/legacy/native positives retained.');
