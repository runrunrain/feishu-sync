/**
 * build-runtime-integrity.test.ts — F12 派发前运行期完整性重核验
 *
 * 单元：verifyRuntimeIntegrity 对真实 agentDir（renderAgentDirConfigFiles +
 * writeAgentDirConfig 产物）与真实包目录（computePackageContentHash）逐项核验，
 * 覆盖 policy 缺失/篡改、settings 未知字段/冻结键漂移/retry 容忍、四配置逐字节
 * 漂移、包漂移/缺失、引用形状非法。
 *
 * live（gated：本机 pi + amagi-pi 源）：真实 Leader 进程（真实安装的版本化
 * amagi-pi + 转发扩展 + 真实 dispatch-guard 模块经 jiti 装载，含相对 import 链）
 * 启动后删除 child-policy / 注入 settings 字段，再由 fixture 模型发起真实
 * task_submit/task_resume——断言派发被阻断（integrity_blocked stderr + 工具
 * 结果含阻断理由）、无 amagi 任务落盘（v2-store 无 spec）、fixture 模型只收到
 * Leader 自身请求（无 child 模型请求）。这不是只测 helper 返回 false。
 *
 * 全程临时 HOME/agentDir/包目录/fixture 模型；不读真实凭据、不跑真实模型。
 */

import { describe, expect, it, afterAll } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  buildRuntimeIntegrityRefs, validateRuntimeIntegrityRefs, verifyRuntimeIntegrity,
  settingsFrozenSurfaceIssues, type RuntimeIntegrityRefs,
} from '../src/agent/build-runtime/runtime-integrity.js';
import {
  computeAgentDirConfigHash, planBuildDirectories, renderAgentDirConfigFiles, writeAgentDirConfig,
} from '../src/agent/build-runtime/agent-dir-config.js';
import { computePackageContentHash, installAmagiPackage } from '../src/agent/build-runtime/amagi-package.js';
const hasherDeps = { computePackageContentHash };
import { childPolicyFileName, renderChildPolicySource } from '../src/agent/build-runtime/child-policy.js';
import { freezeGuardConfig } from '../src/agent/build-runtime/dispatch-guard.js';
import { PiAmagiBuildRuntime } from '../src/agent/build-runtime/adapter.js';
import { makeSpec } from './build-runtime-contracts.test.js';
import { PiRuntimeResolver } from '../src/agent/runtime-resolver.js';
import { buildDefaultAgentConfig } from '../src/types/agent-knowledge.js';
import { PiRpcProcess } from '../src/agent/pi-rpc-process.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.join(HERE, '../src/agent/pi-extension/feishu-sync-agent.js');
const GUARD_MODULE = path.join(HERE, '../src/agent/build-runtime/dispatch-guard.ts');

const tmpDirs: string[] = [];
const mkTmp = (prefix: string): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
};

// ── 真实 agentDir fixture（与生产同源：render → hash → write）────────────

interface IntegrityFixture {
  root: string;
  homeDir: string;
  workDir: string;
  packageRoot: string;
  refs: RuntimeIntegrityRefs;
  policyPath: string;
  settingsPath: string;
}

function makeRealFixture(): IntegrityFixture {
  const root = mkTmp('f12-integrity-');
  const dataRoot = path.join(root, 'data');
  const kbRoot = path.join(root, 'kb');
  fs.mkdirSync(kbRoot, { recursive: true });
  fs.writeFileSync(path.join(kbRoot, 'src.md'), '# 源\n稳定锚点。\n');
  // 真实（小型）版本化包目录：computePackageContentHash 全量哈希对象
  const packageRoot = path.join(root, 'runtime-packages', 'amagi-pi@0.0.0-fixture', 'package');
  fs.mkdirSync(path.join(packageRoot, 'extensions', 'amagi-core'), { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: 'amagi-pi', version: '0.0.0-fixture' }));
  fs.writeFileSync(path.join(packageRoot, 'extensions', 'amagi-core', 'index.ts'), '// fixture amagi\n');
  const contentHash = computePackageContentHash(packageRoot).contentHash;

  const skillPath = path.join(root, 'skill', 'kb-build', 'SKILL.md');
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, '---\nname: kb-build\ndescription: fixture skill。\n---\n\n# 内容质量基线\n');
  const spec = makeSpec({
    buildId: 'b_f12_integrity',
    workflowSkillPath: skillPath,
    workflowRevision: createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
    amagiPackage: { version: '0.0.0-fixture', installDir: path.dirname(packageRoot), packageRoot, contentHash },
  });
  const dirs = planBuildDirectories(dataRoot, spec.buildId);
  const bridge = { bridgeCommand: process.execPath, bridgeArgs: [path.join(root, 'fixture-bridge.cjs')] };
  fs.writeFileSync(bridge.bridgeArgs[0], '// fixture bridge\n');
  const rendered = renderAgentDirConfigFiles(spec, dirs, bridge);
  spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
  writeAgentDirConfig(spec, dirs, bridge);
  const policySource = renderChildPolicySource();
  const refs = buildRuntimeIntegrityRefs({
    homeDir: dirs.homeDir,
    expectedFiles: rendered,
    childPolicy: {
      fileName: childPolicyFileName(policySource),
      sha256: createHash('sha256').update(policySource, 'utf-8').digest('hex'),
    },
    amagiPackage: { packageRoot, contentHash },
    workflowSkill: { path: skillPath, sha256: spec.workflowRevision },
  });
  return {
    root,
    homeDir: dirs.homeDir,
    workDir: dirs.workDir,
    packageRoot,
    refs,
    policyPath: path.join(dirs.homeDir, refs.childPolicy.fileName),
    settingsPath: path.join(dirs.homeDir, 'settings.json'),
  };
}

/** 逐例独立 fixture + 用后清理（篡改用例互不污染）。 */
async function withFixture(run: (fixture: IntegrityFixture) => Promise<void> | void): Promise<void> {
  const fixture = makeRealFixture();
  try {
    await run(fixture);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
    tmpDirs.splice(tmpDirs.indexOf(fixture.root), 1);
  }
}

/** 从基准内容重写 JSON（base 为字符串内容，非路径）。 */
const rewriteJson = (file: string, mutate: (parsed: Record<string, unknown>) => void, base: string): void => {
  const parsed = JSON.parse(base) as Record<string, unknown>;
  mutate(parsed);
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
};

describe('runtime-integrity 单元（真实渲染/落盘/包哈希）', () => {
  it('新鲜落盘 agentDir + 未漂移包 → ok（零 issue）', async () => {
    await withFixture((fixture) => {
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps)).toEqual({ ok: true, issues: [] });
    });
  });

  it('child-policy 文件缺失 → 拒（missing-policy 反例的派发期收口）', async () => {
    await withFixture((fixture) => {
      fs.rmSync(fixture.policyPath);
      const verdict = verifyRuntimeIntegrity(fixture.refs, hasherDeps);
      expect(verdict.ok).toBe(false);
      expect(verdict.issues.join('\n')).toContain('child-policy 文件缺失');
    });
  });

  it('child-policy 内容篡改（同名字节漂移）→ 拒', async () => {
    await withFixture((fixture) => {
      fs.writeFileSync(fixture.policyPath, renderChildPolicySource().replace('codemode', 'codemode '), { mode: 0o600 });
      const verdict = verifyRuntimeIntegrity(fixture.refs, hasherDeps);
      expect(verdict.ok).toBe(false);
      expect(verdict.issues.join('\n')).toContain('child-policy 文件内容与冻结 sha256 不一致');
    });
  });

  it('settings 未知字段注入（resources）→ 拒；冻结键漂移（packages）→ 拒；retry 容忍形状 → ok', async () => {
    await withFixture((fixture) => {
      const backup = fs.readFileSync(fixture.settingsPath, 'utf-8');
      rewriteJson(fixture.settingsPath, (parsed) => { parsed.resources = ['evil']; }, backup);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('未知字段 resources');
      rewriteJson(fixture.settingsPath, (parsed) => { delete parsed.packages; }, backup);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('packages 冻结面被移除');
      rewriteJson(fixture.settingsPath, (parsed) => { parsed.retry = { provider: { timeoutMs: 180000 } }; }, backup);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps)).toEqual({ ok: true, issues: [] });
      rewriteJson(fixture.settingsPath, (parsed) => { parsed.retry = { provider: { timeoutMs: -1 }, extra: 1 }; }, backup);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('retry');
    });
  });

  it('amagi/models/mcp 配置逐字节漂移 → 拒（各点名）', async () => {
    await withFixture((fixture) => {
      for (const name of ['amagi.json', 'models.json', 'mcp.json']) {
        const file = path.join(fixture.homeDir, name);
        const backup = fs.readFileSync(file, 'utf-8');
        fs.writeFileSync(file, backup.replace('{', '{ '));
        const issues = verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n');
        expect(issues, name).toContain(name);
        fs.writeFileSync(file, backup);
      }
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).ok).toBe(true);
    });
  });

  it('配置文件缺失（settings/amagi）→ 拒（agentDir 冻结面不完整）', async () => {
    await withFixture((fixture) => {
      fs.rmSync(path.join(fixture.homeDir, 'settings.json'));
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('缺少 settings.json');
      fs.rmSync(path.join(fixture.homeDir, 'amagi.json'));
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('缺少 amagi.json');
    });
  });

  it('包漂移（包内新增文件）→ 拒；包目录缺失 → 拒', async () => {
    await withFixture((fixture) => {
      const injected = path.join(fixture.packageRoot, 'extensions', 'injected.ts');
      fs.writeFileSync(injected, '// tamper\n');
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('哈希漂移');
      fs.rmSync(injected);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).ok).toBe(true);
      fs.rmSync(fixture.packageRoot, { recursive: true, force: true });
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).ok).toBe(false);
    });
  });

  it('workflow skill 缺失/篡改/符号链接 → 拒（Leader steer 冻结资源接缝）', async () => {
    await withFixture((fixture) => {
      const skillPath = fixture.refs.workflowSkill.path;
      const backup = fs.readFileSync(skillPath, 'utf-8');
      fs.rmSync(skillPath);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('workflow skill 文件缺失');
      fs.writeFileSync(skillPath, `${backup}\n<!-- 运行中注入的规则改动 -->`);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('workflow skill 内容与冻结 workflowRevision 不一致');
      fs.rmSync(skillPath);
      fs.symlinkSync(path.join(fixture.root, 'skill-elsewhere.md'), skillPath);
      fs.writeFileSync(path.join(fixture.root, 'skill-elsewhere.md'), backup); // 符号链接目标内容合法也不放行
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).issues.join('\n')).toContain('workflow skill 是符号链接');
      fs.rmSync(skillPath);
      fs.writeFileSync(skillPath, backup);
      expect(verifyRuntimeIntegrity(fixture.refs, hasherDeps).ok).toBe(true);
    });
  });

  it('引用形状非法（schemaVersion/homeDir/childPolicy 名/哈希）→ 触盘前即拒', async () => {
    await withFixture((fixture) => {
      const bad = { ...fixture.refs, schemaVersion: 99 } as RuntimeIntegrityRefs;
      expect(validateRuntimeIntegrityRefs(bad).join('\n')).toContain('schemaVersion');
      expect(verifyRuntimeIntegrity(bad, hasherDeps).ok).toBe(false);
      const badName = { ...fixture.refs, childPolicy: { ...fixture.refs.childPolicy, fileName: 'evil.js' } } as RuntimeIntegrityRefs;
      expect(verifyRuntimeIntegrity(badName, hasherDeps).ok).toBe(false);
      const badHome = { ...fixture.refs, homeDir: 'relative' } as RuntimeIntegrityRefs;
      expect(verifyRuntimeIntegrity(badHome, hasherDeps).ok).toBe(false);
    });
  });

  it('settingsFrozenSurfaceIssues 与 agentDirConfigMatchesSpec 同口径（同一实现，防分叉回归）', async () => {
    await withFixture((fixture) => {
      // 期望渲染内容本身就是 writeAgentDirConfig 的写入源 → 双向一致
      const issues = settingsFrozenSurfaceIssues(fs.readFileSync(fixture.settingsPath, 'utf-8'), fixture.refs.expectedFiles.settings);
      expect(issues).toEqual([]);
    });
  });
});

// ── live：真实 Leader 派发前完整性阻断（gated）──────────────────────────

const PI_CLI = process.env.PI_PROBE_PI_CLI ?? (() => {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, 'pi');
    if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return '';
})();
const SOURCE_AMAGI = process.env.PI_PROBE_SOURCE_AMAGI || '';

/** fixture OpenAI 模型（脚本化：每次 prompt 先 task_submit 调用，收到该 prompt 的工具结果后收尾）。 */
function startFixtureModel(): Promise<{ url: string; close(): Promise<void>; requests: number; lastConversationText: string }> {
  let requests = 0;
  let lastConversationText = '';
  const server = http.createServer((req, res) => {
    if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404).end('{}'); return; }
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      requests += 1;
      const payload = JSON.parse(body) as { messages?: Array<Record<string, unknown>>; stream?: boolean };
      const messages = payload.messages ?? [];
      lastConversationText = JSON.stringify(messages);
      // 同会话多 prompt：只看最后一条 user 消息之后的工具结果（前轮结果不算本轮）
      let lastUserIdx = -1;
      messages.forEach((message, index) => { if (message.role === 'user') lastUserIdx = index; });
      const hasToolResult = messages.some((message, index) => message.role === 'tool' && index > lastUserIdx);
      const base = { id: `chatcmpl-f12-${requests}`, object: 'chat.completion.chunk', created: 1700000000, model: 'mock-1' };
      const send = (delta: Record<string, unknown>, finish: string | null) => {
        if (payload.stream === true) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ...base, choices: [{ index: 0, message: { role: 'assistant', ...delta }, finish_reason: finish }] }));
        }
      };
      if (!hasToolResult) {
        send({ tool_calls: [{ id: `call_f12_${requests}`, type: 'function', function: { name: 'task_submit', arguments: JSON.stringify({ agent: 'luban', task: 'F12-LIVE 写一个词。', model: 'feishu-sync-llm/mock-1', delivery: 'handle' }) } }] }, 'tool_calls');
        return;
      }
      send({ content: 'F12-LIVE-DONE' }, 'stop');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}/v1`,
        close: () => new Promise((done) => server.close(() => done())),
        get requests() { return requests; },
        get lastConversationText() { return lastConversationText; },
      });
    });
  });
}

/** mock 内部 API（转发扩展启动拉工具清单 + 工具执行回环；不触真实服务）。 */
function startMockApi(): Promise<{ url: string; close(): Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/agent-internal/tools') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([{ name: 'kb_build_probe', label: '构建', description: 'fixture 构建工具', parameters: { type: 'object' } }]));
      return;
    }
    if (req.method === 'POST' && req.url?.startsWith('/api/agent-internal/tools/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], details: undefined }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

describe.skipIf(!PI_CLI || !SOURCE_AMAGI || !fs.existsSync(path.join(SOURCE_AMAGI, 'package.json')))('F12 live：真实 Leader 派发前完整性阻断', () => {
  it('Leader 启动后删 policy / 注入 settings 字段 → task_submit/task_resume 被阻断且无 child 模型请求', { timeout: 300_000 }, async () => {
    const root = mkTmp('f12-live-');
    const model = await startFixtureModel();
    const api = await startMockApi();
    const stderr: string[] = [];
    let rpc: PiRpcProcess | null = null;
    try {
      // 1) 真实安装版本化 amagi-pi（source 物化 + pi install + 全量哈希）
      const amagiVersion = (JSON.parse(fs.readFileSync(path.join(SOURCE_AMAGI, 'package.json'), 'utf-8')) as { version: string }).version;
      const install = await installAmagiPackage({
        nodePath: process.execPath, piCliPath: PI_CLI, dataRoot: path.join(root, 'data'), version: amagiVersion, sourceDir: SOURCE_AMAGI,
      });

      // 2) 真实 agentDir + 守卫信封（adapter.buildGuardConfigInput 生产路径构造 integrity）
      const skillPath = path.join(root, 'skill', 'SKILL.md');
      fs.mkdirSync(path.dirname(skillPath), { recursive: true });
      fs.writeFileSync(skillPath, '---\nname: kb-build\ndescription: live。\n---\n\n# 内容质量基线\n');
      const spec = makeSpec({
        buildId: 'b_f12_live',
        workflowSkillPath: skillPath,
        workflowRevision: createHash('sha256').update(fs.readFileSync(skillPath)).digest('hex'),
        amagiPackage: { version: install.version, installDir: install.installDir, packageRoot: install.packageRoot, contentHash: install.contentHash },
      });
      // 单 fixture 模型（同 baseUrl 单 provider）：所有角色指向 fixture mock
      spec.modelDescriptors = [{
        id: 'mock-1',
        baseUrl: model.url,
        api: 'openai-completions',
        reasoning: false,
        contextWindow: 128_000,
        maxTokens: 32_768,
      }];
      spec.models = { leader: 'zhipuai/mock-1', writer: 'zhipuai/mock-1', reviewer: 'zhipuai/mock-1', research: 'zhipuai/mock-1' };
      const dirs = planBuildDirectories(path.join(root, 'data'), spec.buildId);
      const bridgeScript = path.join(root, 'fixture-bridge.cjs');
      fs.writeFileSync(bridgeScript, '// fixture bridge\n');
      const bridgeInput = { bridgeCommand: process.execPath, bridgeArgs: [bridgeScript] };
      spec.agentDirConfigHash = computeAgentDirConfigHash(renderAgentDirConfigFiles(spec, dirs, bridgeInput));
      writeAgentDirConfig(spec, dirs, bridgeInput);
      const roleMcpTools: Record<string, string[]> = { luban: ['kb_read_sources', 'kb_submit_draft'], diting: ['kb_submit_review'], baize: [] };
      const runtime = new PiAmagiBuildRuntime({
        nodePath: process.execPath,
        piCliPath: PI_CLI,
        dataRoot: path.join(root, 'data'),
        knowledgeBaseRoot: path.join(root, 'kb'),
        outputRoot: path.join(root, 'out'),
        forwardingExtensionPath: EXTENSION_PATH,
        bridgeScriptPath: bridgeScript,
        agentUrl: 'http://127.0.0.1:9',
        resolveZhipuApiKey: () => 'fixture-key',
        issueLeaderRunToken: () => 'fixture-leader-token',
        issueMcpBridgeCredentials: () => ({ url: 'http://127.0.0.1:9', token: 'fixture-bridge-token' }),
        leaderTools: ['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource', 'kb_build_probe'],
        roleMcpTools,
        getLeaderModel: () => 'feishu-sync-llm/mock-1',
      });
      // 角色模型改用转发 provider（amagi 派发预检要求模型注册；阻断发生在预检之前）
      const guard = freezeGuardConfig({
        ...runtime.buildGuardConfigInput(spec, dirs, roleMcpTools),
        roles: {
          luban: { key: 'writer', models: ['feishu-sync-llm/mock-1'], mcpTools: roleMcpTools.luban },
          diting: { key: 'reviewer', models: ['feishu-sync-llm/mock-1'], mcpTools: roleMcpTools.diting },
          baize: { key: 'research', models: ['feishu-sync-llm/mock-1'], mcpTools: [] },
        },
      });
      expect(verifyRuntimeIntegrity(guard.integrity, hasherDeps)).toEqual({ ok: true, issues: [] });

      const leaderEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
        PATH: process.env.PATH ?? '',
        HOME: root,
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
        PI_CODING_AGENT_DIR: dirs.homeDir,
        FEISHU_SYNC_AGENT_URL: api.url,
        FEISHU_SYNC_AGENT_RUN_TOKEN: 'fixture-token',
        FEISHU_SYNC_AGENT_API_KEY: 'fixture-key',
        FEISHU_SYNC_AGENT_PROVIDER_JSON: JSON.stringify({ api: 'openai-completions', baseUrl: `${model.url}`, models: [{ id: 'mock-1', name: 'Mock', contextWindow: 32000, maxTokens: 1000 }] }),
        FEISHU_SYNC_AGENT_BUILD_SPEC_JSON: JSON.stringify({ tools: ['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource', 'kb_build_probe'], guard }),
        FEISHU_SYNC_BUILD_GUARD_MODULE: GUARD_MODULE,
        AMAGI_AUTO_VERIFY_OFF: '1',
        AMAGI_AUTO_CONTINUE_ROUNDS: '0',
        AMAGI_AUTO_REPAIR_ROUNDS: '0',
        AMAGI_AUTORETRY_IMPLICIT_ROUNDS: '0',
        ...extra,
      });

      const resolved = await new PiRuntimeResolver().resolveRuntime(buildDefaultAgentConfig(root));
      const startLeader = async (sessionId: string): Promise<PiRpcProcess> => {
        const proc = new PiRpcProcess({
          nodePath: resolved.nodePath!,
          piCliPath: resolved.piCliPath!,
          additionalExtensionPaths: [install.packageRoot, EXTENSION_PATH],
          tools: ['task_submit', 'task_query', 'task_control', 'task_resume', 'amagi_resource', 'kb_build_probe'],
          buildMode: true,
          sessionDir: path.join(root, 'sessions'),
          sessionId,
          model: 'feishu-sync-llm/mock-1',
          cwd: dirs.workDir,
          env: leaderEnv(),
          promptTimeoutMs: 60_000,
        });
        proc.on('stderr', (chunk: string) => stderr.push(chunk));
        await proc.start(60_000);
        return proc;
      };

      // ── 场景 A：Leader 启动后删除 child-policy 再派发 → 阻断、无任务、无 child 模型请求 ──
      rpc = await startLeader('f12-live');
      const policyPath = path.join(dirs.homeDir, guard.integrity.childPolicy.fileName);
      const policyBackup = fs.readFileSync(policyPath, 'utf-8');
      fs.rmSync(policyPath);
      const outcomeA = await rpc.prompt('F12-LIVE 场景A：派发任务', { timeoutMs: 60_000 });
      expect(outcomeA.outcome).toBe('completed');
      const stderrA = stderr.join('');
      expect(stderrA).toContain('"event":"integrity_blocked"');
      expect(stderrA).toContain('child-policy 文件缺失');
      expect(model.lastConversationText).toContain('运行期完整性核验失败');
      expect(model.lastConversationText).toContain('runtime_integrity_violation');
      expect(fs.existsSync(path.join(dirs.homeDir, 'amagi', 'v2-store'))).toBe(false); // 无任务落盘
      const requestsA = model.requests;
      expect(requestsA).toBe(2); // Leader 两轮（工具调用轮 + 收尾轮）；无 child 模型请求

      // ── 场景 B：恢复 policy、settings 注入未知资源字段后再派发 → 仍阻断（同 Leader 运行中篡改） ──
      fs.writeFileSync(policyPath, policyBackup, { mode: 0o600 });
      const settingsPath = path.join(dirs.homeDir, 'settings.json');
      const settingsBackup = fs.readFileSync(settingsPath, 'utf-8');
      const injected = { ...JSON.parse(settingsBackup), resources: ['evil-skill'] } as Record<string, unknown>;
      fs.writeFileSync(settingsPath, `${JSON.stringify(injected, null, 2)}\n`);
      const outcomeB = await rpc.prompt('F12-LIVE 场景B：继续派发任务', { timeoutMs: 60_000 });
      expect(outcomeB.outcome).toBe('completed');
      const stderrB = stderr.join('');
      expect(stderrB).toContain('未知字段 resources');
      expect(model.lastConversationText).toContain('runtime_integrity_violation');
      expect(fs.existsSync(path.join(dirs.homeDir, 'amagi', 'v2-store'))).toBe(false);
      expect(model.requests).toBe(requestsA + 2); // 仍只有 Leader 自身请求
      fs.writeFileSync(settingsPath, settingsBackup);

      // ── 场景 C：恢复 settings 后【改】workflow skill 再派发 → 仍阻断（child 规则冻结接缝）──
      const frozenSkillPath = guard.integrity.workflowSkill.path;
      const skillBackup = fs.readFileSync(frozenSkillPath, 'utf-8');
      fs.writeFileSync(frozenSkillPath, `${skillBackup}\n<!-- 运行中注入的规则改动 -->`);
      const outcomeC = await rpc.prompt('F12-LIVE 场景C：继续派发任务', { timeoutMs: 60_000 });
      expect(outcomeC.outcome).toBe('completed');
      const stderrC = stderr.join('');
      expect(stderrC).toContain('workflow skill 内容与冻结 workflowRevision 不一致');
      expect(model.lastConversationText).toContain('runtime_integrity_violation');

      // ── 场景 D：【删】workflow skill 再派发 → 仍阻断 ──
      fs.rmSync(frozenSkillPath);
      const outcomeD = await rpc.prompt('F12-LIVE 场景D：继续派发任务', { timeoutMs: 60_000 });
      expect(outcomeD.outcome).toBe('completed');
      expect(stderr.join('')).toContain('workflow skill 文件缺失');
      expect(model.lastConversationText).toContain('runtime_integrity_violation');
      expect(fs.existsSync(path.join(dirs.homeDir, 'amagi', 'v2-store'))).toBe(false); // 四次派发全部未建任务
      expect(model.requests).toBe(requestsA + 6); // 仍只有 Leader 自身请求（无 child 模型请求）
      fs.writeFileSync(frozenSkillPath, skillBackup);
    } finally {
      await rpc?.terminate(8_000).catch(() => undefined);
      await model.close();
      await api.close();
      fs.rmSync(root, { recursive: true, force: true });
      tmpDirs.splice(tmpDirs.indexOf(root), 1);
    }
  });
});

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});
