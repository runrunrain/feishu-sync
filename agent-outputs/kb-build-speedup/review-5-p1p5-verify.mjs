// R5-01/R5-03 修复验证探针（P1–P5 节选自 review-5-probe.mjs，断言按修复后语义翻转）。
// Run from server: node --import tsx ../agent-outputs/kb-build-speedup/review-5-p1p5-verify.mjs
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import assert from 'node:assert/strict';
import { AgentToolService } from '../../server/src/agent/agent-tool-service.ts';
import { RawSourceSnapshot, computeSourceHash } from '../../server/src/kb/raw-source-snapshot.ts';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'r5fix-')); process.env.FEISHU_SYNC_HOME = root;
const kb = path.join(root, 'kb'); fs.mkdirSync(kb); fs.writeFileSync(path.join(kb, 'a.md'), '倍率 2.0\n上限 500\n');
const secret = 'PrivateSourceSecretToken9876';
const service = new AgentToolService({ dataRoot: root, documentsProvider: () => [{ objToken: secret, localRelPath: 'private.md', objType: 'docx', title: 'outside' }] });
function fixture(name) {
  const stagingRoot = path.join(root, name); fs.mkdirSync(path.join(stagingRoot, 'docs'), { recursive: true });
  const state = { knowledgeBaseRoot: kb, snapshot: RawSourceSnapshot.fromEntries([{ objToken: 'tokA', objType: 'docx', title: 'a', relPath: 'a.md', contentHash: computeSourceHash(path.join(kb, 'a.md'), [], kb), objEditTime: null }], { knowledgeBaseRoot: kb }), mode: 'full', workset: new Map([['tokA', 'rebuild']]), stagingRoot, finishInfo: null };
  const token = service.createRunContext({ runKind: 'build', buildId: 'b_probe', outputRoot: path.join(root, 'out'), knowledgeBaseRoot: kb, buildState: state }).token;
  return { state, call: (tool, args) => service.executeTool(token, tool, args), draft: () => JSON.parse(fs.readFileSync(path.join(stagingRoot, 'knowledge-draft.json'), 'utf8')) };
}
async function reject(fn) { try { await fn(); throw Error('unexpected success'); } catch (e) { if (e.message === 'unexpected success') throw e; return { code: e.code, message: e.message }; } }
try {
  // P1 FIXED：构建态探测构建外 token 前缀 → 不泄露（无建议、无 secret）
  const f = fixture('leak');
  const leak = await reject(() => f.call('raw_read', { objToken: 'Priv', offset: 0, limit: 10 }));
  assert.equal(leak.code, 'not_found');
  assert.ok(!leak.message.includes('你是不是想读'), `leaked hint: ${leak.message}`);
  assert.ok(!leak.message.includes(secret), `leaked token: ${leak.message}`);
  // 快照内双拼 token 建议照常
  const near = await reject(() => f.call('raw_read', { objToken: 'tokAtokA', offset: 0, limit: 10 }));
  assert.ok(near.message.includes('你是不是想读 tokA'));
  console.log('P1 FIXED ok: no leak, in-snapshot hint works');
  // 非构建态（discuss）：可见 documents 给建议照常
  const dtoken = service.createRunContext({ runKind: 'discuss', outputRoot: path.join(root, 'out'), knowledgeBaseRoot: kb }).token;
  const derr = await reject(() => service.executeTool(dtoken, 'raw_read', { objToken: 'Priv', offset: 0, limit: 10 }));
  assert.ok(derr.message.includes(`你是不是想读 ${secret}`), `discuss hint missing: ${derr.message}`);
  console.log('P1b ok: discuss mode still hints from its visible documents');

  const g = fixture('objects'); await g.call('raw_read', { objToken: 'tokA', offset: 0, limit: 10 });
  const obj = { clientKey: 'original', type: 'rule', title: '规则', familyKey: 'family', variantKey: 'v', scopeKey: 's', scopeText: '规则', headingPath: ['规则'], claims: [{ claimKey: 'c', riskCategory: 'normal' }] };
  const base = { path: '规则.md', markdown: '## 规则\n倍率 2.0\n', sources: ['tokA'], summary: '规则' };
  await g.call('kb_write_doc', { ...base, objects: [obj], evidenceClaims: [{ clientKey: 'ev', objectKey: 'original', claimKey: 'c', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, selector: { kind: 'text_span', lineStart: 1, lineEnd: 2 }, role: 'supports', nature: 'direct' }], coverageUpdates: [{ itemId: 'cov', sourceId: 'tokA', category: 'rule', importance: 'important', disposition: 'mapped', targetKeys: ['original'] }] });
  const id = g.draft().objects[0].objectId; const before = JSON.stringify(g.draft());
  // P2/P3 门禁保持：锚点/keepObjects 不能保留被移除对象；拒绝原子
  const anchor = await reject(() => g.call('kb_write_doc', { ...base, markdown: `## 规则\n<a id="${id}"></a>\n`, objects: [] }));
  assert.equal(anchor.code, 'kb_coverage_invalid'); assert.equal(JSON.stringify(g.draft()), before);
  const keep = await reject(() => g.call('kb_write_doc', { ...base, objects: [], keepObjects: [id] }));
  assert.equal(keep.code, 'kb_coverage_invalid'); assert.equal(JSON.stringify(g.draft()), before);
  console.log('P2/P3 ok: anchor/keepObjects cannot bypass gate');
  // P4 FIXED：同 call 重述去向 → 成功，对象移除、无悬空
  const explicit = await g.call('kb_write_doc', { ...base, markdown: '## 已移除\n已无支撑\n', objects: [], coverageUpdates: [{ itemId: 'cov', sourceId: 'tokA', category: 'rule', importance: 'important', disposition: 'unresolved' }] });
  assert.ok(explicit.content[0].text.includes('规则.md'));
  const after = g.draft();
  assert.ok(!after.objects.some((o) => o.objectId === id));
  assert.equal(after.coverage.find((c) => c.itemId === 'cov').disposition, 'unresolved');
  console.log('P4 FIXED ok: same-call coverageUpdates remediation succeeds, no dangling');
  // P4b 守卫：重述项仍指向被移除对象 → 拒绝
  const h = fixture('guard'); await h.call('raw_read', { objToken: 'tokA', offset: 0, limit: 10 });
  await h.call('kb_write_doc', { ...base, objects: [obj], evidenceClaims: [{ clientKey: 'ev', objectKey: 'original', claimKey: 'c', sourceRef: { sourceId: 'tokA', resourceId: 'tokA' }, selector: { kind: 'text_span', lineStart: 1, lineEnd: 2 }, role: 'supports', nature: 'direct' }], coverageUpdates: [{ itemId: 'cov', sourceId: 'tokA', category: 'rule', importance: 'important', disposition: 'mapped', targetKeys: ['original'] }] });
  const gid = h.draft().objects[0].objectId; const gbefore = JSON.stringify(h.draft());
  const dangling = await reject(() => h.call('kb_write_doc', { ...base, markdown: '## 已移除\n已无支撑\n', objects: [], coverageUpdates: [{ itemId: 'cov', sourceId: 'tokA', category: 'rule', importance: 'important', disposition: 'mapped', targetKeys: [gid] }] }));
  assert.equal(dangling.code, 'kb_coverage_invalid');
  assert.ok(dangling.message.includes('重述后仍指向本次移除的对象'));
  assert.equal(JSON.stringify(h.draft()), gbefore);
  console.log('P4b ok: restated mapped target to removed object rejected atomically');
  // P5：includeCoverage:false 仍拒
  const include = await reject(() => f.call('draft_read', { path: '规则.md', includeCoverage: false }));
  assert.equal(include.code, 'invalid_request');
  console.log('P5 ok: includeCoverage=false still rejected');
  console.log('ALL P1-P5 VERIFIED');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
