/**
 * SourceEditControls 组件测试（S13）
 *
 * SSR + 纯函数锚定（CliAccessSettingsCard.test.tsx 同法：effects 不跑，
 * 初始渲染只含入口按钮；异步流由 server 侧测试与真机浏览器验证覆盖）：
 *   - docx + 本地正文 → 「编辑」入口渲染
 *   - sheet / 无本地正文 → 整体不渲染
 *   - mdTruncated → 编辑禁用（防整文替换丢尾部）
 *   - splitFeishuSyncHeader 与 S11 splitHeaderBody 同规则切分
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { SourceEditControls, splitFeishuSyncHeader } from './SourceEditControls';

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

  it('历史头格式（无 feishu_sync 键）→ null（编辑入口禁用）', () => {
    expect(splitFeishuSyncHeader('<!--\n来源: 飞书知识库\nobj_token: t (docx)\n-->\n\n' + BODY)).toBeNull();
  });

  it('无注释块 → null', () => {
    expect(splitFeishuSyncHeader(BODY)).toBeNull();
  });
});

describe('SourceEditControls 渲染分支', () => {
  it('docx + 本地正文：编辑入口渲染', () => {
    const html = render();
    expect(html).toContain('编辑');
    expect(html).not.toContain('写回飞书'); // 无编辑行时不显示写回入口
  });

  it('mdTruncated：编辑禁用（防整文替换丢尾部）', () => {
    const html = render({ mdTruncated: true });
    const editButton = html.match(/<button[\s\S]*?编辑[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(editButton).toContain('disabled');
    expect(editButton).toContain('超过预览大小上限');
  });

  it('头部非规范格式：编辑禁用并提示重新同步', () => {
    const html = render({ mdContent: '纯正文无头部\n' });
    const editButton = html.match(/<button[\s\S]*?编辑[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(editButton).toContain('disabled');
    expect(editButton).toContain('重新同步');
  });

  it('sheet 类型：整体不渲染', () => {
    expect(render({ objType: 'sheet' })).toBe('');
  });

  it('未同步（mdContent null）：整体不渲染', () => {
    expect(render({ mdContent: null })).toBe('');
  });
});
