/**
 * AgentToolService 工具族注册（S1）等价性测试：
 *  - 表驱动快照：四个 runKind 的白名单与重构前逐字相等（顺序亦一致）
 *  - 规格面：族引用 tool-specs.ts 的 SPEC 常量（同一对象，不复制），顺序同白名单
 *  - dispatch 面：错误码/错误消息/状态码与重构前逐字一致（含白名单 403、
 *    401、各族 handler 的具名错误），并覆盖 ws_write→ws_read 成功路径
 *  - registerToolFamily 追加接口：新族只进声明 runKind 的白名单（追加在
 *    既有工具之后）、可被 dispatch、重复族名/工具名拒绝
 */

import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentToolService } from '../src/agent/agent-tool-service.js';
import { getToolSpec } from '../src/agent/tool-specs.js';
import { toolsForRunKind } from '../src/types/agent-knowledge.js';
import type { AgentRunKind, AgentToolSpec } from '../src/types/agent-knowledge.js';

/** 重构前 createRunContext 内联白名单的逐字快照（旧实现基线）。
 * S3/S4 增量：build + kb_unit_done；discuss/work + raw_read_image
 * （与 toolsForRunKind 的 TOOLS 常量同步追加，顺序仍在基线之后）。 */
const LEGACY_WHITELISTS: Record<AgentRunKind, string[]> = {
  build: ['raw_list', 'raw_read', 'raw_search', 'draft_list', 'draft_read', 'draft_search', 'kb_write_doc', 'kb_delete_doc', 'kb_unit_done', 'kb_finish'],
  work: ['kb_search', 'kb_read', 'raw_search', 'raw_read', 'raw_read_image', 'ws_ls', 'ws_read', 'ws_search', 'ws_write', 'ws_edit', 'ws_mkdir'],
  discuss: ['kb_search', 'kb_read', 'raw_search', 'raw_read', 'raw_read_image'],
  probe: [],
};

/** 裸服务未注册的外部族工具（ops/task 在 index.ts 按需注册）：在 pi
 * --tools 参数面（toolsForRunKind 常量）里，但不在裸服务白名单。 */
const EXTERNAL_FAMILY_TOOLS = ['app_command'];
const expectedWhitelist = (runKind: AgentRunKind): string[] =>
  toolsForRunKind(runKind).filter((name) => !EXTERNAL_FAMILY_TOOLS.includes(name));

describe('工具族注册：白名单等价（表驱动快照）', () => {
  const service = new AgentToolService({
    dataRoot: os.tmpdir(),
    documentsProvider: () => [],
  });

  it('registeredFamilies：内置四族 raw/kb/draft/ws（注册序）', () => {
    expect(service.registeredFamilies()).toEqual(['raw', 'kb', 'draft', 'ws']);
  });

  const kinds: AgentRunKind[] = ['build', 'work', 'discuss', 'probe'];

  for (const runKind of kinds) {
    it(`runKind=${runKind} 白名单 = pi 参数面（未注册外部族除外），S1 冻结基线全保留`, () => {
      const { context } = service.createRunContext({
        runKind,
        outputRoot: os.tmpdir(),
        knowledgeBaseRoot: os.tmpdir(),
      });
      // 白名单成员由族注册表派生：pi --tools 参数面（S3 追加 raw_read_image、
      // S10 追加 app_command）中已注册的工具按参数面顺序进入；外部族工具
      // （本服务未注册）不进白名单。断言两套面各自成立。
      expect(context.allowedTools).toEqual(expectedWhitelist(runKind));
      // S1 冻结基线工具一个不丢（防后续切片误删）
      for (const name of LEGACY_WHITELISTS[runKind]) {
        expect(context.allowedTools).toContain(name);
      }
    });
  }

  it('规格面：白名单工具逐一有规格，且与 tool-specs.ts 定义为同一对象（族引用不复制）', () => {
    for (const runKind of kinds) {
      const { token } = service.createRunContext({
        runKind,
        outputRoot: os.tmpdir(),
        knowledgeBaseRoot: os.tmpdir(),
      });
      const specs = service.getToolSpecsForToken(token)!;
      expect(specs.map((spec) => spec.name)).toEqual(expectedWhitelist(runKind));
      for (const spec of specs) {
        expect(spec).toBe(getToolSpec(spec.name));
      }
    }
  });

  it('无效令牌 → 规格面返回 null', () => {
    expect(service.getToolSpecsForToken('no-such-token')).toBeNull();
  });
});

describe('工具族注册：dispatch 等价（错误码逐字）', () => {
  let service: AgentToolService;
  let outputRoot: string;
  let knowledgeBaseRoot: string;
  let workspaceRoot: string;

  beforeAll(() => {
    outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's1-fam-out-'));
    knowledgeBaseRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's1-fam-kb-'));
    workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 's1-fam-ws-'));
    service = new AgentToolService({
      dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 's1-fam-data-')),
      documentsProvider: () => [],
    });
  });

  afterAll(() => {
    for (const dir of [outputRoot, knowledgeBaseRoot, workspaceRoot]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const tokenFor = (runKind: AgentRunKind, workspace?: string) =>
    service.createRunContext({
      runKind,
      outputRoot,
      knowledgeBaseRoot,
      workspaceRoot: workspace,
    }).token;

  it('无效令牌 → 401 run_token_invalid（消息逐字）', async () => {
    await expect(service.executeTool('bad-token', 'kb_search', { query: 'x' }))
      .rejects.toMatchObject({ code: 'run_token_invalid', status: 401, message: '运行令牌无效或已过期' });
  });

  it('白名单外工具 → 403 tool_not_allowed（消息逐字）', async () => {
    const token = tokenFor('discuss');
    await expect(service.executeTool(token, 'ws_write', { path: 'a.md', content: 'x' }))
      .rejects.toMatchObject({
        code: 'tool_not_allowed',
        status: 403,
        message: '工具 ws_write 不在本运行的工具白名单内（runKind=discuss）',
      });
  });

  it('kb 族：kb_search 未发布 → 404 kb_not_published（消息逐字）', async () => {
    const token = tokenFor('discuss');
    await expect(service.executeTool(token, 'kb_search', { query: 'x' }))
      .rejects.toMatchObject({ code: 'kb_not_published', status: 404, message: '标准知识库尚未发布，无法搜索' });
  });

  it('raw 族：raw_read 不存在 → 404 not_found（消息逐字）', async () => {
    const token = tokenFor('discuss');
    await expect(service.executeTool(token, 'raw_read', { objToken: 'missing-token' }))
      .rejects.toMatchObject({
        code: 'not_found',
        status: 404,
        message: '原始文档不存在或无成功本地版本: missing-token',
      });
  });

  it('draft 族：draft_list 非构建态 → 403 tool_not_allowed（消息逐字）', async () => {
    const token = tokenFor('build');
    await expect(service.executeTool(token, 'draft_list', {}))
      .rejects.toMatchObject({ code: 'tool_not_allowed', status: 403, message: '本运行不是构建运行' });
  });

  it('ws 族：未绑定 Workspace → 403（消息逐字）；成功路径 ws_write → ws_read 往返', async () => {
    const token = tokenFor('work'); // 无 workspaceRoot
    await expect(service.executeTool(token, 'ws_ls', {}))
      .rejects.toMatchObject({ code: 'tool_not_allowed', status: 403, message: '本运行未绑定 Workspace' });

    const bound = tokenFor('work', workspaceRoot);
    const writeResult = await service.executeTool(bound, 'ws_write', { path: 'a.md', content: 'hello' });
    expect(writeResult.content[0].text).toBe('已写入 a.md（5 字节）');
    const readResult = await service.executeTool(bound, 'ws_read', { path: 'a.md' });
    expect(readResult.content[0].text).toBe('<untrusted_workspace path="a.md">\nhello\n</untrusted_workspace>');
    expect(readResult.details).toMatchObject({ path: 'a.md', offset: 0, returnedLines: 1, totalLines: 1 });
  });
});

describe('registerToolFamily 追加接口（S3/S6/S10 消费面）', () => {
  const service = new AgentToolService({
    dataRoot: os.tmpdir(),
    documentsProvider: () => [],
  });

  const PROBE_SPEC: AgentToolSpec = {
    name: 's1_probe_tool',
    label: '测试工具',
    description: '验证族追加接口',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  };

  it('新族进入声明 runKind 的白名单（追加在既有工具后），其余 runKind 不受影响', async () => {
    let calls = 0;
    service.registerToolFamily({
      name: 's1-test',
      tools: [{
        spec: PROBE_SPEC,
        runKinds: ['discuss'],
        execute: () => {
          calls += 1;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      }],
    });
    const discuss = service.createRunContext({ runKind: 'discuss', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() });
    expect(discuss.context.allowedTools).toEqual([...expectedWhitelist('discuss'), 's1_probe_tool']);
    const work = service.createRunContext({ runKind: 'work', outputRoot: os.tmpdir(), knowledgeBaseRoot: os.tmpdir() });
    expect(work.context.allowedTools).toEqual(expectedWhitelist('work'));
    const specs = service.getToolSpecsForToken(discuss.token)!;
    expect(specs[specs.length - 1]).toBe(PROBE_SPEC);

    const result = await service.executeTool(discuss.token, 's1_probe_tool', {});
    expect(calls).toBe(1);
    expect(result.content[0].text).toBe('ok');
    // 新族工具对未声明 runKind 仍是白名单外（403 语义一致）
    await expect(service.executeTool(work.token, 's1_probe_tool', {}))
      .rejects.toMatchObject({
        code: 'tool_not_allowed',
        message: '工具 s1_probe_tool 不在本运行的工具白名单内（runKind=work）',
      });
  });

  it('重复族名 / 重复工具名注册期拒绝', () => {
    expect(() => service.registerToolFamily({ name: 's1-test', tools: [] }))
      .toThrow('工具族已注册: s1-test');
    expect(() => service.registerToolFamily({
      name: 's1-other',
      tools: [{ spec: PROBE_SPEC, runKinds: ['work'], execute: () => ({ content: [{ type: 'text', text: 'x' }] }) }],
    })).toThrow('工具已注册于其他工具族: s1_probe_tool');
  });
});
