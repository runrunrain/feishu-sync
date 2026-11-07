/**
 * 构建 agentDir 配置生成/校验/哈希测试（设计v2 §3.1–§3.3）
 *
 * 断言形状对齐真实解析器（已核实源码，非猜测）：
 * - pi settings.json packages（packages.md + DefaultPackageManager local source）
 * - amagi.json（schemas/amagi-config.json 2.21.31 + mcp-config.ts loadMcpRouting）
 * - pi models.json（models-configuration.md："$NAME" env 插值）
 * - pi mcp.json（mcp.md：mcpServers + autoEnableCodemode 在 mcpServers 旁）
 */

import { describe, expect, it, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildForbiddenZones, computeAgentDirConfigHash, planBuildDirectories,
  readAgentDirConfigHash, renderAgentDirConfigFiles, validateRenderedConfig,
  writeAgentDirConfig, agentDirConfigMatchesSpec,
} from '../src/agent/build-runtime/agent-dir-config.js';
import { childPolicyFileName, renderChildPolicySource } from '../src/agent/build-runtime/child-policy.js';
import { validateBuildRunSpec } from '../src/agent/build-runtime/contracts.js';
import { makeSpec } from './build-runtime-contracts.test.js';

const tmpDirs: string[] = [];
function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-agentdir-'));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => { for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true }); });

const BRIDGE = { bridgeCommand: '/usr/local/bin/node', bridgeArgs: ['/app/server/dist/agent/build-mcp-bridge.cjs'] };

function renderedFor(spec = makeSpec()) {
  const dirs = planBuildDirectories('/data', spec.buildId);
  const files = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
  return { spec, dirs, files };
}

describe('renderAgentDirConfigFiles', () => {
  it('settings.json：packages 单条本地版本化路径，资源收窄，extensions 只声明应用 child-policy', () => {
    const { files, spec } = renderedFor();
    const settings = JSON.parse(files.settings);
    expect(settings.packages).toHaveLength(1);
    expect(settings.packages[0].source).toBe(spec.amagiPackage.packageRoot);
    expect(settings.packages[0].skills).toEqual([]);
    expect(settings.packages[0].prompts).toEqual([]);
    expect(settings.packages[0].themes).toEqual([]);
    // child-policy（内容寻址文件名，相对路径按 agentDir 解析）；详见 build-runtime-child-policy.test.ts
    expect(settings.extensions).toEqual([childPolicyFileName()]);
    expect(settings.skills).toBeUndefined();
    expect(settings.defaultTools).toBeUndefined();
  });

  it('amagi.json：角色模型带冻结档位、skills 注入构建 skill、池键去档位、MCP 路由收敛', () => {
    const { files, spec } = renderedFor();
    const amagi = JSON.parse(files.amagi);
    expect(amagi.agents.luban.model).toBe('zhipuai/glm-5.3-flash');
    expect(amagi.agents.luban.skills).toEqual([spec.workflowSkillPath]);
    expect(amagi.agents.diting.model).toBe('zhipuai/glm-5.3');
    // 池键 = 去 thinking 后缀的 provider/model（amagi admission.ts 语义）
    expect(amagi.concurrency.models).toEqual({ 'zhipuai/glm-5.3-flash': 4, 'zhipuai/glm-5.3': 2 });
    expect(amagi.mcp.leader).toEqual([]);
    expect(amagi.mcp.default).toEqual([]);
    expect(amagi.mcp.agents.luban).toEqual(['feishu-kb-bridge']);
    expect(amagi.mcp.agents.baize).toEqual(['feishu-kb-bridge']);
  });

  it('models.json：zhipuai 静态声明 + apiKey 只写环境引用（无密钥值）', () => {
    const { files } = renderedFor();
    const models = JSON.parse(files.models);
    const provider = models.providers.zhipuai;
    expect(provider.apiKey).toBe('$ZHIPU_API_KEY');
    expect(provider.api).toBe('openai-completions');
    expect(provider.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    const ids = provider.models.map((m: { id: string }) => m.id).sort();
    expect(ids).toEqual(['glm-5.3', 'glm-5.3-flash']);
    expect(JSON.stringify(models)).not.toMatch(/[0-9a-zA-Z]{32}\./); // 无密钥形值
  });

  it('同名模型可分别绑定三家提供商的端点、密钥和准入池', () => {
    const spec = makeSpec({
      models: { leader: 'deepseek/shared', writer: 'zhipuai/shared', reviewer: 'openai/shared', research: 'zhipuai/shared' },
      modelDescriptors: [
        { id: 'shared', baseUrl: 'https://writer.example/v1', api: 'openai-completions' },
        { id: 'shared', provider: 'openai', baseUrl: 'https://reviewer.example/v1', api: 'openai-completions' },
        { id: 'shared', provider: 'deepseek', baseUrl: 'https://leader.example/v1', api: 'openai-completions' },
      ],
    });
    expect(validateBuildRunSpec(spec)).toEqual([]);
    const { files, dirs } = renderedFor(spec);
    expect(validateRenderedConfig(files, spec, dirs)).toEqual([]);
    expect(JSON.parse(files.models).providers).toMatchObject({
      zhipuai: { baseUrl: 'https://writer.example/v1', apiKey: '$ZHIPU_API_KEY', models: [{ id: 'shared' }] },
      openai: { baseUrl: 'https://reviewer.example/v1', apiKey: '$OPENAI_API_KEY', models: [{ id: 'shared' }] },
      deepseek: { baseUrl: 'https://leader.example/v1', apiKey: '$DEEPSEEK_API_KEY', models: [{ id: 'shared' }] },
    });
    expect(JSON.parse(files.amagi).concurrency.models).toEqual({ 'zhipuai/shared': 4, 'openai/shared': 2 });
  });

  it('R1：同模型角色共享单池，容量给满 max（不再均分）', () => {
    const spec = makeSpec({
      models: { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3:high', reviewer: 'zhipuai/glm-5.3', research: 'zhipuai/glm-5.3:high' },
      limits: { maxConcurrentAgents: 6, admissionPools: { writer: 6, reviewer: 6 } },
    });
    expect(validateBuildRunSpec(spec)).toEqual([]);
    const { files, dirs } = renderedFor(spec);
    expect(validateRenderedConfig(files, spec, dirs)).toEqual([]);
    expect(JSON.parse(files.amagi).concurrency.models).toEqual({ 'zhipuai/glm-5.3': 6 });
  });

  it('mcp.json：只登记桥接、env 用 ${VAR} 引用、autoEnableCodemode:false', () => {
    const { files } = renderedFor();
    const mcp = JSON.parse(files.mcp);
    const server = mcp.mcpServers['feishu-kb-bridge'];
    expect(Object.keys(mcp.mcpServers)).toEqual(['feishu-kb-bridge']);
    expect(server.command).toBe('/usr/local/bin/node');
    expect(server.args).toEqual(BRIDGE.bridgeArgs);
    expect(server.env.FEISHU_SYNC_BUILD_MCP_URL).toBe('${FEISHU_SYNC_BUILD_MCP_URL}');
    expect(server.env.FEISHU_SYNC_BUILD_MCP_TOKEN).toBe('${FEISHU_SYNC_BUILD_MCP_TOKEN}');
    expect(mcp.autoEnableCodemode).toBe(false);
  });

  it('未冻结模型的角色不写 model（amagi 解析链回退 Leader 模型）', () => {
    const spec = makeSpec();
    spec.models = { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3' };
    spec.roles = { writer: 'luban', reviewer: 'diting', research: 'baize' };
    const files = renderAgentDirConfigFiles(spec, null, BRIDGE);
    const amagi = JSON.parse(files.amagi);
    expect(amagi.agents.baize.model).toBeUndefined();
    expect(amagi.agents.baize.skills).toBeDefined();
  });
});

describe('validateRenderedConfig（篡改检测）', () => {
  it('正确产物零问题', () => {
    const { files, spec, dirs } = renderedFor();
    expect(validateRenderedConfig(files, spec, dirs)).toEqual([]);
  });

  it('apiKey 写入字面密钥 → 检出', () => {
    const { files, spec, dirs } = renderedFor();
    const models = JSON.parse(files.models);
    models.providers.zhipuai.apiKey = 'sk-real-secret';
    const issues = validateRenderedConfig({ ...files, models: `${JSON.stringify(models, null, 2)}\n` }, spec, dirs);
    expect(issues.join()).toContain('apiKey');
  });

  it('mcp.default 缺省（= * 全量路由）→ 检出', () => {
    const { files, spec, dirs } = renderedFor();
    const amagi = JSON.parse(files.amagi);
    delete amagi.mcp.default;
    const issues = validateRenderedConfig({ ...files, amagi: `${JSON.stringify(amagi, null, 2)}\n` }, spec, dirs);
    expect(issues.join()).toContain('mcp.default');
  });

  it('packages 多包 / bridge command 非绝对路径 / autoEnableCodemode 未关 → 检出', () => {
    const { files, spec, dirs } = renderedFor();
    const settings = JSON.parse(files.settings);
    settings.packages.push({ source: 'npm:evil-package' });
    const mcp = JSON.parse(files.mcp);
    mcp.mcpServers['feishu-kb-bridge'].command = 'node';
    mcp.autoEnableCodemode = true;
    const issues = validateRenderedConfig({
      settings: `${JSON.stringify(settings, null, 2)}\n`,
      mcp: `${JSON.stringify(mcp, null, 2)}\n`,
      amagi: files.amagi,
      models: files.models,
    }, spec, dirs);
    const joined = issues.join('\n');
    expect(joined).toContain('只声明一个包');
    expect(joined).toContain('绝对路径');
    expect(joined).toContain('autoEnableCodemode');
  });

  it('models.json 未声明角色模型 → 检出', () => {
    const { files, spec, dirs } = renderedFor();
    const models = JSON.parse(files.models);
    models.providers.zhipuai.models = models.providers.zhipuai.models.filter((m: { id: string }) => m.id !== 'glm-5.3-flash');
    const issues = validateRenderedConfig({ ...files, models: `${JSON.stringify(models, null, 2)}\n` }, spec, dirs);
    expect(issues.join()).toContain('glm-5.3-flash');
  });
});

describe('writeAgentDirConfig / 哈希', () => {
  let root: string;
  beforeEach(() => { root = tmpRoot(); });

  it('落盘四文件 + child-policy 物化；readAgentDirConfigHash 与 compute 一致', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    const { configHash } = writeAgentDirConfig(spec, dirs, BRIDGE);
    expect(configHash).toBe(spec.agentDirConfigHash);
    expect(readAgentDirConfigHash(dirs.homeDir)).toBe(configHash);
    for (const name of ['settings.json', 'amagi.json', 'models.json', 'mcp.json']) {
      expect(fs.existsSync(path.join(dirs.homeDir, name))).toBe(true);
    }
    expect(fs.readFileSync(path.join(dirs.homeDir, childPolicyFileName()), 'utf-8')).toBe(renderChildPolicySource());
    expect(fs.existsSync(path.join(dirs.workDir, 'agent-outputs'))).toBe(false); // ensureWorkLayout 由环境模块负责
  });

  it('工作目录已存在 amagi.json → 拒绝写入（项目级覆盖面）', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    fs.mkdirSync(dirs.workDir, { recursive: true });
    fs.writeFileSync(path.join(dirs.workDir, 'amagi.json'), '{}');
    expect(() => writeAgentDirConfig(spec, dirs, BRIDGE)).toThrow('amagi.json');
  });

  it('哈希对配置漂移敏感（改 baseUrl 即变化）', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const a = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    const spec2 = makeSpec();
    spec2.modelDescriptors = spec.modelDescriptors.map((d) => ({ ...d, baseUrl: 'https://other.example/v4' }));
    const b = renderAgentDirConfigFiles(spec2, dirs, BRIDGE);
    expect(computeAgentDirConfigHash(a)).not.toBe(computeAgentDirConfigHash(b));
  });

  it('容忍式比对：amagi 韧性链改 settings.json 追加字段仍匹配；改 amagi.json/未知字段即不匹配', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, BRIDGE);
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, BRIDGE);
    // 模拟实测发现：amagi 启动时向 settings.json 追加 retry 段（带备份）
    const settingsPath = path.join(dirs.homeDir, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    settings.retry = { provider: { timeoutMs: 300000 } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE)).toEqual({ ok: true, issues: [] });
    // packages 被换 = 不匹配
    settings.packages = [{ source: '/evil', skills: [] }];
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).ok).toBe(false);
    // 未知字段（资源注入面）= 不匹配（字段感知完整比对，详版见 build-runtime-child-policy.test.ts）
    settings.packages = JSON.parse(rendered.settings).packages;
    settings.mcpServers = { evil: { command: 'evil' } };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).ok).toBe(false);
    // amagi.json 被改 = 不匹配（核心冻结面）
    fs.writeFileSync(settingsPath, rendered.settings);
    const amagiPath = path.join(dirs.homeDir, 'amagi.json');
    const amagi = JSON.parse(fs.readFileSync(amagiPath, 'utf-8'));
    amagi.mcp.default = ['*'];
    fs.writeFileSync(amagiPath, JSON.stringify(amagi, null, 2));
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).ok).toBe(false);
  });

  it('容忍式比对：未提供 bridge 时跳过 mcp.json 字节比对（形状由 validate 保障）', () => {
    const spec = makeSpec();
    const dirs = planBuildDirectories(root, spec.buildId);
    const rendered = renderAgentDirConfigFiles(spec, dirs, { ...BRIDGE, bridgeCommand: '/other/node' });
    spec.agentDirConfigHash = computeAgentDirConfigHash(rendered);
    writeAgentDirConfig(spec, dirs, { ...BRIDGE, bridgeCommand: '/other/node' });
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec).ok).toBe(true);
    expect(agentDirConfigMatchesSpec(dirs.homeDir, spec, BRIDGE).ok).toBe(false);
  });
});

describe('buildForbiddenZones', () => {
  it('覆盖工作目录配置面 + 构建 agentDir home + 数据根敏感文件 + 原始库/标准库 + 用户 .pi', () => {
    const zones = buildForbiddenZones({
      workDir: '/data/builds/b_x/work',
      dataRoot: '/data',
      knowledgeBaseRoot: '/kb/raw',
      outputRoot: '/kb/std',
      userHome: '/home/u',
    });
    expect(zones).toContain('/data/builds/b_x/work/amagi.json');
    expect(zones).toContain('/data/builds/b_x/work/.pi');
    expect(zones).toContain('/data/builds/b_x/work/.mcp.json');
    expect(zones).toContain('/data/builds/b_x/work/AGENTS.md');
    expect(zones).toContain('/data/builds/b_x/work/CLAUDE.md');
    // 构建 agentDir 配置/policy 精确禁区（不整目录禁 home：skill 正文须可读）
    expect(zones).toContain('/data/builds/b_x/home/settings.json');
    expect(zones).toContain('/data/builds/b_x/home/amagi.json');
    expect(zones).toContain('/data/builds/b_x/home/models.json');
    expect(zones).toContain('/data/builds/b_x/home/mcp.json');
    expect(zones).toContain(`/data/builds/b_x/home/${childPolicyFileName()}`);
    expect(zones).not.toContain('/data/builds/b_x/home');
    expect(zones).toContain('/data/config.json');
    expect(zones).toContain('/data/feishu-sync.db');
    expect(zones).toContain('/data/run');
    expect(zones).toContain('/kb/raw');
    expect(zones).toContain('/kb/std');
    expect(zones).toContain('/home/u/.pi');
    expect(new Set(zones).size).toBe(zones.length); // 去重有序
  });
});
