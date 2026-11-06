/**
 * build-runtime 契约测试（设计v2 §8）
 *
 * - BuildRunSpec 校验不变量（buildId 前缀 = 现有 createBuild 真实规则
 *   kb-build-service.ts:574；pools 合计/同池一致/provider 冻结/角色白名单）
 * - modelSpecPoolKey 与 amagi 池键同语义（去 thinking 档位后缀）
 */

import { describe, expect, it } from 'vitest';
import {
  BUILD_ID_PATTERN, DEFAULT_AUTO_ROUNDS, DEFAULT_ROLE_AGENTS, KNOWN_AMAGI_AGENTS,
  modelSpecPoolKey, validateBuildRunSpec,
  type BuildModelDescriptor, type BuildRunSpec,
} from '../src/agent/build-runtime/contracts.js';

function makeDescriptor(id: string): BuildModelDescriptor {
  return {
    id,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    api: 'openai-completions',
    reasoning: true,
    thinkingLevelMap: { off: null, low: 'low', medium: 'medium' },
    thinking: 'low',
    contextWindow: 128_000,
    maxTokens: 32_768,
  };
}

export function makeSpec(overrides: Partial<BuildRunSpec> = {}): BuildRunSpec {
  const descriptors = [makeDescriptor('glm-5.3'), makeDescriptor('glm-5.3-flash')];
  return {
    buildId: 'b_20261101090000_abcdef',
    generation: 1,
    orchestrationMode: 'pi-amagi',
    mode: 'full',
    sourceManifestHash: 'a'.repeat(16),
    workflowRevision: 'b'.repeat(12),
    workflowSkillPath: '/tmp/skills/kb-build/SKILL.md',
    amagiPackage: { version: '2.21.31', installDir: '/x', packageRoot: '/x/npm/node_modules/amagi-pi', contentHash: 'c'.repeat(16) },
    piVersion: '1.4.0',
    agentDirConfigHash: 'd'.repeat(16),
    models: {
      leader: 'zhipuai/glm-5.3',
      writer: 'zhipuai/glm-5.3-flash',
      reviewer: 'zhipuai/glm-5.3',
      research: 'zhipuai/glm-5.3',
    },
    modelDescriptors: descriptors,
    roles: { ...DEFAULT_ROLE_AGENTS },
    limits: { maxConcurrentAgents: 6, admissionPools: { writer: 4, reviewer: 2 } },
    autoRounds: { ...DEFAULT_AUTO_ROUNDS },
    publicationPolicy: 'auto',
    ...overrides,
  };
}

describe('validateBuildRunSpec', () => {
  it('基准 spec 通过', () => {
    expect(validateBuildRunSpec(makeSpec())).toEqual([]);
  });

  it('不同端点不能被单provider悄悄合并，Leader模型也必须静态声明', () => {
    const spec = makeSpec();
    spec.modelDescriptors[1].baseUrl = 'https://another.example/v1';
    spec.models.leader = 'zhipuai/not-declared';
    expect(validateBuildRunSpec(spec).join('\n')).toContain('同一非空 baseUrl');
    expect(validateBuildRunSpec(spec).join('\n')).toContain('models.leader 未在');
  });

  it('独立研究模型无冻结池时拒绝，避免amagi默认容量突破总上限', () => {
    const spec = makeSpec();
    spec.models.research = 'zhipuai/research';
    spec.modelDescriptors.push(makeDescriptor('research'));
    expect(validateBuildRunSpec(spec).join('\n')).toContain('models.research 缺少冻结准入池');
  });

  it('buildId 前缀契约 = 现有 createBuild 规则（b_ + 字符集）', () => {
    expect(BUILD_ID_PATTERN.test('b_20261101090000_abcdef')).toBe(true);
    expect(BUILD_ID_PATTERN.test('kb_123')).toBe(false);
    expect(BUILD_ID_PATTERN.test('b_')).toBe(false);
    expect(validateBuildRunSpec(makeSpec({ buildId: 'kb_x' }))[0]).toContain('buildId');
  });

  it('pools 合计不得超过 maxConcurrentAgents', () => {
    const issues = validateBuildRunSpec(makeSpec({
      limits: { maxConcurrentAgents: 4, admissionPools: { writer: 4, reviewer: 2 } },
    }));
    expect(issues.join('\n')).toContain('超过 maxConcurrentAgents');
  });

  it('同模型多角色池容量不一致 → 拒绝', () => {
    const spec = makeSpec();
    spec.models = { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3', reviewer: 'zhipuai/glm-5.3' };
    spec.limits = { maxConcurrentAgents: 6, admissionPools: { writer: 4, reviewer: 2 } };
    const issues = validateBuildRunSpec(spec);
    expect(issues.join('\n')).toContain('池容量不一致');
  });

  it('同模型同容量 → 合法（合并为一个 amagi 池）', () => {
    const spec = makeSpec();
    spec.models = { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3', reviewer: 'zhipuai/glm-5.3', research: 'zhipuai/glm-5.3' };
    spec.limits = { maxConcurrentAgents: 6, admissionPools: { writer: 3, reviewer: 3 } };
    expect(validateBuildRunSpec(spec)).toEqual([]);
  });

  it('research 角色存在但未冻结模型 → 拒绝（实测：回退角色卡模型而非 Leader 模型）', () => {
    const spec = makeSpec();
    spec.models = { leader: 'zhipuai/glm-5.3', writer: 'zhipuai/glm-5.3-flash', reviewer: 'zhipuai/glm-5.3' };
    const issues = validateBuildRunSpec(spec);
    expect(issues.join()).toContain('models.research');
  });

  it('未映射密钥的 provider 模型 → 拒绝', () => {
    const spec = makeSpec();
    spec.models = { leader: 'zhipuai/glm-5.3', writer: 'unmapped/gpt-5', reviewer: 'zhipuai/glm-5.3' };
    const issues = validateBuildRunSpec(spec);
    expect(issues.join('\n')).toContain('models.writer');
    expect(issues.join('\n')).toContain('受支持 provider');
  });

  it('角色表外的 amagi agent → 拒绝', () => {
    const spec = makeSpec({ roles: { writer: 'kb-writer' as never, reviewer: 'diting', research: 'baize' } });
    const issues = validateBuildRunSpec(spec);
    expect(issues.join('\n')).toContain('不是内置 amagi 角色');
  });

  it('内置五角色本身合法（guard 允许集才收窄，spec 只查内置表）', () => {
    for (const agent of KNOWN_AMAGI_AGENTS) {
      const spec = makeSpec({ roles: { writer: agent, reviewer: 'diting', research: 'baize' } });
      expect(validateBuildRunSpec(spec)).toEqual([]);
    }
  });

  it('缺 piVersion / amagiPackage → 拒绝', () => {
    expect(validateBuildRunSpec(makeSpec({ piVersion: '' })).join()).toContain('piVersion');
    const bad = makeSpec();
    bad.amagiPackage = { version: '', installDir: '', packageRoot: '', contentHash: '' };
    expect(validateBuildRunSpec(bad).join()).toContain('amagiPackage');
  });

  it('orchestrationMode 只支持 pi-amagi', () => {
    const spec = makeSpec();
    // @ts-expect-error 验证外部输入不能绕过运行模式限制。
    spec.orchestrationMode = 'legacy';
    expect(validateBuildRunSpec(spec).join()).toContain('pi-amagi');
  });
});

describe('modelSpecPoolKey', () => {
  it('去合法 thinking 后缀（与 amagi stripModelThinkingSuffix 同语义）', () => {
    expect(modelSpecPoolKey('zhipuai/glm-5.3:high')).toBe('zhipuai/glm-5.3');
    expect(modelSpecPoolKey('zhipuai/glm-5.3')).toBe('zhipuai/glm-5.3');
    // qwen:32b 冒号是模型身份的一部分，不是档位
    expect(modelSpecPoolKey('zhipuai/qwen:32b')).toBe('zhipuai/qwen:32b');
  });
});
