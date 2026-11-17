import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAgentPromptAssets, readAgentPromptFile } from '../src/agent/agent-assets.js';
import { AppPluginStore } from '../src/agent/app-plugin-store.js';
import { RoleRegistry } from '../src/agent/tasks/role-registry.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcAgentRoot = path.join(serverRoot, 'src', 'agent');
const distAgentRoot = path.join(serverRoot, 'dist', 'agent');

const tmpRoots: string[] = [];
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('策划文档约束与文风提示词升级契约', () => {
  it('内置提示词资产完整可读；dist 存在时与 src 逐字节一致', () => {
    const assets = readAgentPromptAssets();
    expect(assets).not.toBeNull();
    expect(assets!.buildRules.trim().length).toBeGreaterThan(200);
    expect(assets!.styleGuide.trim().length).toBeGreaterThan(200);

    for (const file of [
      'standard-kb-style.md',
      'standard-kb-build.md',
      'standard-kb-review.md',
      'standard-kb-plan.md',
      'image-describe.md',
    ]) {
      const content = readAgentPromptFile(file);
      expect(content, `${file} 读取为空`).not.toBeNull();
      expect(content!.trim().length).toBeGreaterThan(100);
    }

    if (fs.existsSync(distAgentRoot)) {
      const mirroredRelatives = [
        'prompts/standard-kb-style.md',
        'prompts/standard-kb-build.md',
        'prompts/standard-kb-review.md',
        'prompts/standard-kb-plan.md',
        'prompts/image-describe.md',
        'roles/kb-analyst.md',
        'roles/kb-converter.md',
        'roles/kb-reviewer.md',
        'skills/knowledge-build/SKILL.md',
        'skills/knowledge-build/leader-protocol.md',
        'skills/knowledge-build/author-protocol.md',
        'skills/knowledge-build/reviewer-protocol.md',
        'skills/knowledge-build/achievement-protocol.md',
        'skills/knowledge-build/mcp-examples.md',
      ];
      for (const rel of mirroredRelatives) {
        const srcFile = path.join(srcAgentRoot, rel);
        const distFile = path.join(distAgentRoot, rel);
        expect(fs.existsSync(distFile), `dist 缺失资产 ${rel}，请运行 npm --prefix server run build`).toBe(true);
        expect(
          fs.readFileSync(distFile).equals(fs.readFileSync(srcFile)),
          `dist 资产 ${rel} 与 src 不一致，请运行 npm --prefix server run build`,
        ).toBe(true);
      }
    }
  });

  it('standard-kb-style.md 覆盖新版中文句法、字段用途、正交矩阵、禁表后复述与语义保护约束', () => {
    const style = fs.readFileSync(path.join(srcAgentRoot, 'prompts', 'standard-kb-style.md'), 'utf-8');
    expect(style).toContain('实词动词');
    expect(style).toContain('长定语');
    expect(style).toContain('顺承');
    expect(style).toContain('表后同义复述');
    expect(style).toContain('零信息防呆套话');
    expect(style).toContain('保存什么、用于什么');
    expect(style).toContain('指向的具体对象类型');
    expect(style).toContain('便于查看');
    expect(style).toContain('行维度 \\ 列维度');
    expect(style).toContain('父级 · 子级');
    expect(style).toContain('不在可见表头写 `[键]`');
    expect(style).toContain('否定半句');
    expect(style).toContain('配置下一局生效');
    expect(style).toContain('两阶段结算');
    expect(style).toContain('二维坐标');
    expect(style).toContain('HTML 注释');
    expect(style).not.toMatch(/待定项写成[「"]问题＋建议值[」"]/);
  });

  it('standard-kb-review.md 保留八个检查维度名称，并补齐示例代入、表后复述/句法检查与防误伤说明', () => {
    const review = fs.readFileSync(path.join(srcAgentRoot, 'prompts', 'standard-kb-review.md'), 'utf-8');
    for (const dim of [
      '事实与数值',
      '条件和例外',
      '重要遗漏',
      '来源冲突处理',
      '术语一致性',
      '表述是否改变原意',
      '对象声明与正文一致',
      '表达规范',
    ]) {
      expect(review, `审查维度缺失: ${dim}`).toContain(`**${dim}**`);
    }
    expect(review).toContain('示例取值代入');
    expect(review).toContain('表后同义复述');
    expect(review).toContain('形式弱动词');
    expect(review).toContain('欧化长定语');
    expect(review).toContain('按语境判断');
    expect(review).toContain('不机械判错');
    expect(review).toContain('多列字段表');
  });

  it('RoleRegistry 成功加载三张角色卡，AppPluginStore 默认上下文与快照满足字节上限', () => {
    const registry = new RoleRegistry(path.join(srcAgentRoot, 'roles'));
    expect(registry.size()).toBe(3);
    expect(registry.get('kb-analyst')?.requiresMode).toBe('any');
    expect(registry.get('kb-converter')?.requiresMode).toBe('work');
    expect(registry.get('kb-reviewer')?.requiresMode).toBe('any');
    expect(registry.get('kb-converter')?.body).toContain('<!-- roles: ... -->');
    expect(registry.get('kb-reviewer')?.body).toContain('示例取值代入');
    expect(registry.get('kb-analyst')?.body).toContain('事件 Log');

    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-upgrade-'));
    tmpRoots.push(dataRoot);
    const store = new AppPluginStore(dataRoot);
    const { plugins } = store.list();
    expect(plugins).toHaveLength(5);
    for (const plugin of plugins) {
      expect(Buffer.byteLength(plugin.content, 'utf-8'), `${plugin.id} 超出单插件 64KB 限制`).toBeLessThanOrEqual(
        64 * 1024,
      );
    }
    expect(Buffer.byteLength(JSON.stringify(plugins), 'utf-8')).toBeLessThanOrEqual(256 * 1024);

    for (const scope of ['discuss', 'work', 'build'] as const) {
      const snap = store.snapshot(scope, { includeNative: false });
      expect(fs.existsSync(snap.path)).toBe(true);
    }
  });
});
