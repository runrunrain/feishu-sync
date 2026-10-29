/**
 * SourceEditControls 组件测试（S13）
 *
 * SSR + 纯函数锚定（CliAccessSettingsCard.test.tsx 同法：effects 不跑，
 * 初始渲染只含入口按钮；异步流由 server 侧测试与真机浏览器验证覆盖）：
 *   - docx + 本地正文 → 展示写回记录和历史，不提供手动编辑
 *   - sheet / 无本地正文 → 整体不渲染
 *   - splitFeishuSyncHeader 与 S11 splitHeaderBody 同规则切分
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { SourceEditControls, buildCloudDiffContext, splitFeishuSyncHeader } from './SourceEditControls';

const HEADER = [
  '<!--',
  'feishu_sync:',
  '  obj_token: "doxcnT1"',
  '  obj_type: "docx"',
  '-->',
  '',
  '',
].join('\n');
const BODY = '# 标题\n\n正文。\n';

function render(props: Partial<Parameters<typeof SourceEditControls>[0]> = {}) {
  return renderToStaticMarkup(
    <SourceEditControls
      objToken="doxcnT1"
      objType="docx"
      mdContent={HEADER + BODY}
      {...props}
    />,
  );
}

describe('splitFeishuSyncHeader（与 S11 服务端切分同规则）', () => {
  it('规范头：`-->\\n\\n` 计入头部，body 从其后开始', () => {
    const split = splitFeishuSyncHeader(HEADER + BODY);
    expect(split).not.toBeNull();
    expect(split!.header.endsWith('-->\n\n')).toBe(true);
    expect(split!.body).toBe(BODY);
  });

  it('非规范间距（`-->\\n` 单换行）：不吞并，换行保留为正文首字符', () => {
    const split = splitFeishuSyncHeader('<!--\nfeishu_sync:\n  obj_token: "t"\n-->\n正文');
    expect(split!.body).toBe('\n正文');
  });

  it('历史头格式（无 feishu_sync 键）→ null', () => {
    expect(splitFeishuSyncHeader('<!--\n来源: 飞书知识库\nobj_token: t (docx)\n-->\n\n' + BODY)).toBeNull();
  });

  it('无注释块 → null', () => {
    expect(splitFeishuSyncHeader(BODY)).toBeNull();
  });
});

describe('SourceEditControls 渲染分支', () => {
  it('docx + 本地正文：无手动编辑入口', () => {
    const html = render();
    expect(html).not.toContain('编辑正文');
    expect(html).not.toContain('正文编辑器');
    expect(html).not.toContain('写回飞书'); // 无编辑行时不显示写回入口
  });

  it('写回记录 / 云端历史入口继续可用', () => {
    const html = render();
    expect(html).toContain('data-testid="open-push-log"');
    expect(html).toContain('data-testid="open-cloud-history"');
    expect(html).toContain('写回记录');
    expect(html).toContain('云端历史');
  });

  it('sheet 类型：整体不渲染', () => {
    expect(render({ objType: 'sheet' })).toBe('');
  });

  it('未同步（mdContent null）：整体不渲染', () => {
    expect(render({ mdContent: null })).toBe('');
  });
});

describe('T4b-08 对比云端当前 — 宿主消费链（真实 client 请求路径 fetch 断言）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('宿主发起不带 revisionId 的 history-content 请求（=云端当前正文），并回填两侧行级 diff 上下文', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ revisionId: null, content: '# 云端当前正文\n\n服务端真实拉取。' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    const ctx = await buildCloudDiffContext('doxcnT1', { title: '对比云端与本地 · 写回冲突', note: 'n' }, '# 本地正文');
    // 宿主级断言：真实 client.request 发出的 URL（缺省 revisionId = 当前正文）。
    expect(urls).toEqual(['/api/sources/doxcnT1/history-content']);
    expect(ctx.cloud).toMatchObject({ label: '云端当前正文', body: '# 云端当前正文\n\n服务端真实拉取。' });
    expect(ctx.local).toMatchObject({ label: '本地当前正文', body: '# 本地正文' });
  });

  it('只有真实失败才降级：fetch 502 → cloud.body=null + 如实原因（含服务端错误码与消息）；本地侧保留', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'history_content_unavailable', message: '云端正文读取失败：upstream boom' }),
      { status: 502, headers: { 'Content-Type': 'application/json' } },
    )));
    const ctx = await buildCloudDiffContext('doxcnT1', { title: 't', note: 'n' }, '# 本地正文');
    expect(ctx.cloud.body).toBeNull();
    expect(ctx.cloud.unavailableReason).toContain('history_content_unavailable');
    expect(ctx.cloud.unavailableReason).toContain('upstream boom');
    expect(ctx.cloud.unavailableReason).toContain('打开飞书文档核对');
    expect(ctx.local.body).toBe('# 本地正文');
  });

  it('fetchImpl 注入面：消费方可直接注入替身（不依赖全局 fetch）', async () => {
    const requested: string[] = [];
    const ctx = await buildCloudDiffContext('doxcnT1', { title: 't', note: 'n' }, 'L', async (token) => {
      requested.push(token);
      return { content: 'C' };
    });
    expect(requested).toEqual(['doxcnT1']);
    expect(ctx.cloud.body).toBe('C');
    expect(ctx.local.body).toBe('L');
  });
});
