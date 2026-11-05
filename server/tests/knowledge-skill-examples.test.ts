/**
 * 审核修复批 F14：冻结 knowledge-build skill 的 MCP 调用示例契约检查。
 * 解析六份冻结资产中所有 ```json 代码块，按真实契约逐项校验：
 * - 外层调用者可达性（F14-R1）：mcp_call 外壳仅子任务可用——内层工具
 *   必须在子任务桥真实工具面（V2_CHILD_ALL_TOOLS）；非 mcp_call 的直接
 *   调用仅 Leader 可用——外层工具必须在真实生产 Leader 白名单
 *   （LEADER_TOOL_WHITELIST = amagi 任务面 + V2_LEADER_TOOLS）。
 * - server 名 = BUILD_MCP_SERVER_NAME（feishu-kb-bridge）；
 * - tool 名已注册且 arguments 满足对应 spec 的 required/enum/
 *   additionalProperties/type 约束（两层各自按内/外层参数面校验）。
 * 示例不再与真实 schema 或调用者工具面脱节（首次调用即被拒）。
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getToolSpec, V2_LEADER_TOOLS } from '../src/agent/tool-specs.js';
import { BUILD_MCP_SERVER_NAME } from '../src/agent/build-runtime/contracts.js';
import { LEADER_TOOL_WHITELIST } from '../src/kb/build-runtime-host.js';
import { V2_CHILD_ALL_TOOLS } from '../src/kb/build-actors.js';

const skillsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'skills', 'knowledge-build');
const SKILL_FILES = [
  'SKILL.md',
  'leader-protocol.md',
  'author-protocol.md',
  'reviewer-protocol.md',
  'achievement-protocol.md',
  'mcp-examples.md',
];

interface JsonSchemaLike {
  type?: string;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaLike;
  enum?: unknown[];
  description?: string;
}

/** 轻量 JSON-Schema 子集校验（tool-specs 实际使用的面）。 */
function validateAgainstSchema(value: unknown, schema: JsonSchemaLike, pathLabel: string): string[] {
  const errors: string[] = [];
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pathLabel}: 值 ${JSON.stringify(value)} 不在 enum ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return [`${pathLabel}: 需要 object，实际 ${Array.isArray(value) ? 'array' : typeof value}`];
    }
    const record = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in record)) errors.push(`${pathLabel}: 缺必填字段 ${key}`);
    }
    const properties = schema.properties ?? {};
    for (const key of Object.keys(record)) {
      if (properties[key]) errors.push(...validateAgainstSchema(record[key], properties[key], `${pathLabel}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${pathLabel}: 未知字段 ${key}（additionalProperties: false）`);
    }
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return [`${pathLabel}: 需要 array，实际 ${typeof value}`];
    if (schema.items) value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items!, `${pathLabel}[${index}]`)));
    return errors;
  }
  if (schema.type === 'string' && typeof value !== 'string') errors.push(`${pathLabel}: 需要 string，实际 ${typeof value}`);
  if (schema.type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) errors.push(`${pathLabel}: 需要 integer`);
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push(`${pathLabel}: 需要 boolean`);
  return errors;
}

/** 提取 md 中全部 ```json 代码块。 */
function extractJsonBlocks(markdown: string): string[] {
  const blocks: string[] = [];
  for (const match of markdown.matchAll(/```json\n([\s\S]*?)```/g)) {
    blocks.push(match[1]!.trim());
  }
  return blocks;
}

describe('F14：冻结 skill 示例契约检查（schema + 调用者工具面）', () => {
  it('六份资产存在且示例全部按真实契约与真实工具面可执行', () => {
    const allErrors: string[] = [];
    let exampleCount = 0;
    for (const file of SKILL_FILES) {
      const full = path.join(skillsDir, file);
      expect(fs.existsSync(full), `${file} 缺失`).toBe(true);
      for (const block of extractJsonBlocks(fs.readFileSync(full, 'utf8'))) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block);
        } catch (error) {
          allErrors.push(`${file}: JSON 解析失败 ${String(error)}`);
          continue;
        }
        const call = parsed as { server?: string; tool?: string; arguments?: Record<string, unknown> };
        if (!call?.tool || !call.arguments || typeof call.arguments !== 'object') {
          allErrors.push(`${file}: 非工具调用结构的 json 块需单独说明：${block.slice(0, 80)}`);
          continue;
        }
        exampleCount += 1;
        if (call.server !== undefined) {
          // 文档代码块就是 mcp_call 的参数对象；不包含外层原生工具名。
          if (call.server !== BUILD_MCP_SERVER_NAME) {
            allErrors.push(`${file}: server 名 ${String(call.server)} ≠ ${BUILD_MCP_SERVER_NAME}`);
            continue;
          }
          const inner = call.tool;
          if (!(V2_CHILD_ALL_TOOLS as readonly string[]).includes(inner)) {
            allErrors.push(`${file}: mcp_call 内层工具 ${inner} 不在子任务桥真实工具面（V2_CHILD_ALL_TOOLS）——子任务不可达`);
            continue;
          }
          const spec = getToolSpec(inner);
          if (!spec) {
            allErrors.push(`${file}: 工具 ${inner} 未注册（不在 tool-specs）`);
            continue;
          }
          allErrors.push(...validateAgainstSchema(call.arguments, spec.parameters as JsonSchemaLike, `${file}:${inner}`));
        } else {
          // Leader 路径：原生直接调用 → 外层工具必须在真实生产 Leader 白名单
          if (!(LEADER_TOOL_WHITELIST as readonly string[]).includes(call.tool)) {
            allErrors.push(`${file}: 直接调用 ${call.tool} 不在真实 Leader 生产白名单（LEADER_TOOL_WHITELIST）——Leader 不可达`);
            continue;
          }
          const spec = getToolSpec(call.tool);
          if (!spec) {
            allErrors.push(`${file}: 工具 ${call.tool} 未注册（不在 tool-specs）`);
            continue;
          }
          allErrors.push(...validateAgainstSchema(call.arguments as Record<string, unknown>, spec.parameters as JsonSchemaLike, `${file}:${call.tool}`));
        }
      }
    }
    expect(exampleCount).toBeGreaterThanOrEqual(7); // 读取/写/审查/交接/manifest/分配/发布全覆盖
    expect(allErrors).toEqual([]);
  });

  it('关键工具示例覆盖：write 使用服务端补全的紧凑声明、review 与交接保留语义字段', () => {
    const examples = extractJsonBlocks(fs.readFileSync(path.join(skillsDir, 'mcp-examples.md'), 'utf8'))
      .map((block) => JSON.parse(block) as { server?: string; tool: string; arguments: Record<string, unknown> })
      .filter((call) => call.server === BUILD_MCP_SERVER_NAME);
    const innerArgs = (tool: string): Record<string, unknown> | undefined =>
      examples.find((call) => call.tool === tool)?.arguments;
    const write = innerArgs('kb_write_doc');
    expect(write).toMatchObject({
      path: '规则/行动.md', markdown: expect.any(String), sources: expect.any(Array), summary: expect.any(String),
      objects: [expect.objectContaining({ familyKey: expect.any(String), scopeText: expect.any(String) })],
      evidenceClaims: [expect.objectContaining({ selector: expect.any(Object) })],
      coverageUpdates: [expect.objectContaining({ disposition: 'mapped', targetKeys: expect.any(Array) })],
    });
    expect(write).not.toHaveProperty('title');
    expect(write).not.toHaveProperty('operationId');
    expect(innerArgs('kb_tool_schema')).toEqual({ name: 'kb_edit_doc' });
    expect(innerArgs('kb_edit_doc')).toMatchObject({
      path: '规则/行动.md', expectedContentHash: expect.any(String),
      patches: [expect.objectContaining({ anchor: { kind: 'exact_text', oldText: expect.any(String) }, newText: expect.any(String) })],
    });
    const review = innerArgs('kb_submit_review');
    expect(review).toMatchObject({
      conclusion: expect.stringMatching(/^(pass|needs_revision|insufficient_material|fail)$/),
      coverage: { sourceRefs: expect.any(Array) },
      issues: expect.any(Array),
    });
    expect(review).not.toHaveProperty('operationId');
    const handoff = innerArgs('build_handoff_submit');
    expect(handoff).toMatchObject({ summary: expect.any(String), artifactRefs: expect.any(Array), nextInfo: expect.any(Array) });
    expect(handoff).not.toHaveProperty('operationId');
  });

  it('F14-R1：Leader 示例为直接工具调用且全部在真实生产 Leader 白名单内（不投 mcp_call 权限）', () => {
    const text = fs.readFileSync(path.join(skillsDir, 'mcp-examples.md'), 'utf8');
    // 生产不变量：Leader 白名单永不包含 mcp_call（不为示例开权限）
    expect((LEADER_TOOL_WHITELIST as readonly string[])).not.toContain('mcp_call');
    const leaderSection = text.slice(text.indexOf('## Leader 工具'));
    const blocks = extractJsonBlocks(leaderSection.slice(0, leaderSection.indexOf('## 常见错误') > 0 ? leaderSection.indexOf('## 常见错误') : undefined));
    expect(blocks.length).toBeGreaterThanOrEqual(3); // manifest/分配/发布三例
    const directTools: string[] = [];
    for (const block of blocks) {
      const call = JSON.parse(block) as { tool: string; arguments: Record<string, unknown> };
      expect(call.tool, 'Leader 示例不得用 mcp_call 外壳（真实 Leader 无此工具）').not.toBe('mcp_call');
      directTools.push(call.tool);
    }
    for (const tool of ['build_manifest', 'build_assign_output', 'build_request_publish']) {
      expect(directTools, `Leader 段落缺 ${tool} 直连示例`).toContain(tool);
    }
    // Leader-only 工具（子任务工具面不可达）不得以 mcp_call 形式出现在任何冻结资产
    const leaderOnly = (V2_LEADER_TOOLS as readonly string[]).filter((tool) => !(V2_CHILD_ALL_TOOLS as readonly string[]).includes(tool));
    expect(leaderOnly).toContain('build_manifest');
    for (const file of SKILL_FILES) {
      for (const block of extractJsonBlocks(fs.readFileSync(path.join(skillsDir, file), 'utf8'))) {
        const call = JSON.parse(block) as { tool?: string; arguments?: { tool?: string } };
        if (call?.tool === 'mcp_call' && call.arguments?.tool) {
          expect(leaderOnly, `${file}: mcp_call 内层 ${call.arguments.tool} 是 Leader-only 工具，子任务不可达`).not.toContain(call.arguments.tool);
        }
      }
    }
  });

  it('Leader 区分桥接资源和真实文件，避免 staging 路径触发 required-input-missing', () => {
    const text = fs.readFileSync(path.join(skillsDir, 'leader-protocol.md'), 'utf8');
    const dispatch = text.slice(text.indexOf('3. **派写**'), text.indexOf('4. **派审**'));
    expect(dispatch).toContain('objToken 和 staging 草稿路径都是应用桥接资源');
    expect(dispatch).toContain('`raw_read` / `draft_read`');
    expect(dispatch).toContain('不要放进 `inputs`、`inputPaths`、`contextRefs` 或 `outputPaths`');
    expect(dispatch).toContain('`inputs.required=true` 的文件必须在派发时已存在');
  });

  it('审查读取契约明确元数据与声明互斥，并限制 schema 查询为本角色工具面', () => {
    const spec = getToolSpec('draft_read')!.parameters as JsonSchemaLike;
    const description = spec.properties!.metadataOnly!.description;
    expect(description).toContain('不能与 includeDeclarations=true、declarationClaimKey 或 declarationObjectKey 同时使用');
    expect(description).toContain('读取声明时省略 metadataOnly');
    const protocol = fs.readFileSync(path.join(skillsDir, 'reviewer-protocol.md'), 'utf8');
    expect(protocol).toContain('只查询本角色可用工具');
    expect(protocol).toContain('用 `draft_read` 的声明筛选读取');
  });

  it('问题清单 schema 说明条件必填范围和最新版本读取参数', () => {
    const submit = getToolSpec('build_issues_submit')!.parameters as JsonSchemaLike;
    expect(submit.properties!.issues!.items!.properties!.targetPath!.description)
      .toContain('severity=blocking 时必填');
    const list = getToolSpec('build_issues_list')!;
    expect(list.description).toContain('不接收 listId、issueListId 或 revision 参数');
    expect(Object.keys((list.parameters as JsonSchemaLike).properties!)).toEqual(['targetPath']);
  });

  it('交接 prose 字段与真实 schema 一致（achievement-protocol 不再使用 artifacts/needsFromLeader）', () => {
    const text = fs.readFileSync(path.join(skillsDir, 'achievement-protocol.md'), 'utf8');
    expect(text).toContain('`artifactRefs`');
    expect(text).toContain('`nextInfo`');
    expect(text).not.toContain('needsFromLeader');
    expect(text).not.toMatch(/`artifacts`/);
    expect(text).toContain('build_handoff_submit');
  });
});
