/**
 * SourceEditControls 组件挂载级测试（T4b-08 终修，jsdom 环境）
 *
 * 与 SourceEditControls.test.tsx（SSR + helper 锚定）互补：本文件真实挂载
 * 组件（createRoot），经 jsdom 事件（element.click）走完
 * 「编辑状态 → 写回飞书 → 计划阻断 → 对比云端与本地」按钮链路，断言：
 *   - 真实 client.request 发出的 fetch URL（history-content 不带
 *     revisionId = 云端当前正文）；
 *   - CloudDiffModal 回填渲染（云端侧真实拉取内容 + 本地正文）；
 *   - 只有真实失败（502）才进入不可读降级态，原因如实展示。
 *
 * 真机浏览器/Electron 点击与视觉走查不在 jsdom 覆盖范围（留给主上环境
 * 清单，见 T4b-fixC-report.md）。
 *
 * @vitest-environment jsdom
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { SourceEditControls } from './SourceEditControls';

// React 18 act 环境标记（createRoot + act 同步刷新状态更新）
(globalThis as unknown as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const HEADER = [
  '<!--',
  'feishu_sync:',
  '  obj_token: "doxcnT1"',
  '  obj_type: "docx"',
  '-->',
  '',
  '',
].join('\n');
const BODY = '# 本地标题\n\n本地当前正文（挂载链路）。\n';

const EDIT_STATUS_DIRTY = {
  objToken: 'doxcnT1',
  relPath: '_custom/folder/doxcnT1.md',
  title: '挂载测试文档',
  bodyHash: 'hash-base',
  editState: {
    objToken: 'doxcnT1',
    relPath: '_custom/folder/doxcnT1.md',
    title: '挂载测试文档',
    state: 'dirty',
    bodyHash: 'hash-dirty',
    baseBodyHash: 'hash-base',
    editCount: 1,
    lastActor: 'user',
    error: null,
    updatedAt: '2026-10-27T00:00:00Z',
  },
};

/** blocked(rollback_anchor_unavailable) 计划：弹窗内渲染「对比云端与本地」入口。 */
const PLAN_ANCHOR_BLOCKED = {
  mode: 'blocked',
  blockedReason: 'rollback_anchor_unavailable',
  bytes: 64,
  cloud: { objEditTime: null, revisionId: null },
  conflict: false,
  warnings: [],
};

interface FetchLog {
  url: string;
  method?: string;
}

/** 最小 response 替身：只覆盖 client.request 消费面（ok/status/statusText/json）。 */
function fakeResponse(status: number, body: unknown) {
  const ok = status >= 200 && status < 300;
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  };
}

interface MountHandle {
  container: HTMLElement;
  fetchLog: FetchLog[];
}

function mountSourceEditControls(stub: (url: string) => { status: number; body: unknown } | null): MountHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const fetchLog: FetchLog[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    fetchLog.push({ url, method: init?.method ?? 'GET' });
    const routed = stub(url);
    if (routed) return fakeResponse(routed.status, routed.body);
    return fakeResponse(404, { error: 'test_no_stub', message: `测试未提供 ${url} 的响应` });
  }));
  return { container, fetchLog };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor 超时：${what}`);
    }
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function findButtonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const buttons = Array.from(scope.querySelectorAll('button'));
  const hit = buttons.find((b) => (b.textContent ?? '').includes(text));
  if (!hit) throw new Error(`未找到文本为「${text}」的按钮；现有：${buttons.map((b) => b.textContent).join(' | ')}`);
  return hit;
}

let cleanupRoots: Array<() => void> = [];

afterEach(() => {
  for (const fn of cleanupRoots) fn();
  cleanupRoots = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('T4b-08 组件挂载点击链：对比云端与本地（真实 fetch 请求 + 回填渲染）', () => {
  it('点击链触发不带 revisionId 的 history-content 请求，弹窗回填云端/本地两侧行级差异', async () => {
    const CLOUD_BODY = '# 云端当前标题\n\n云端当前正文（服务端真实拉取回填）。\n';
    const mount = mountSourceEditControls((url) => {
      if (url === '/api/sources/doxcnT1/edit-status') return { status: 200, body: EDIT_STATUS_DIRTY };
      if (url === '/api/sources/doxcnT1/push/preview') return { status: 200, body: PLAN_ANCHOR_BLOCKED };
      if (url === '/api/sources/doxcnT1/history-content') {
        return { status: 200, body: { revisionId: null, content: CLOUD_BODY } };
      }
      return null;
    });
    const { container, fetchLog } = mount;
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <SourceEditControls
          objToken="doxcnT1"
          objType="docx"
          mdContent={HEADER + BODY}
        />,
      );
    });
    cleanupRoots.push(() => act(() => { root.unmount(); }));

    // 1) 挂载即拉取编辑状态 → dirty → 「写回飞书」入口渲染
    await waitFor(() => findButtonByText(container, '写回飞书') !== undefined, '写回飞书入口');
    expect(fetchLog.map((c) => c.url)).toContain('/api/sources/doxcnT1/edit-status');
    expect(fetchLog.some((c) => c.url.includes('history-content'))).toBe(false);

    // 2) 点击「写回飞书」→ 真实 POST push/preview → 计划 blocked（锚点不可读）
    await act(async () => {
      findButtonByText(container, '写回飞书').click();
    });
    await waitFor(() => findButtonByText(container, '对比云端与本地') !== undefined, '对比云端与本地入口');
    const preview = fetchLog.find((c) => c.url === '/api/sources/doxcnT1/push/preview');
    expect(preview?.method).toBe('POST');

    // 3) 点击「对比云端与本地」→ jsdom 点击链发起 history-content 请求（缺省
    //    revisionId = 云端当前正文），弹窗从读取中回填两侧行级差异
    await act(async () => {
      findButtonByText(container, '对比云端与本地').click();
    });
    await waitFor(() => container.textContent!.includes('云端当前正文（服务端真实拉取回填）'), '云端正文回填');
    expect(fetchLog.filter((c) => c.url.includes('history-content'))).toEqual([
      { url: '/api/sources/doxcnT1/history-content', method: 'GET' },
    ]);
    // URL 不带 revisionId（缺省 = 云端当前正文），非历史版本读取
    expect(fetchLog.find((c) => c.url.includes('history-content'))?.url.includes('revisionId')).toBe(false);
    // 回填渲染：两侧 label 与正文都在弹窗 DOM 中（行级差异行）
    const text = container.textContent!;
    expect(text).toContain('云端当前正文');
    expect(text).toContain('本地当前正文');
    expect(text).toContain('# 云端当前标题');
    expect(text).toContain('本地当前正文（挂载链路）');
  });

  it('真实失败（502）才降级：弹窗如实展示服务端错误码与消息，本地侧保留', async () => {
    const mount = mountSourceEditControls((url) => {
      if (url === '/api/sources/doxcnT1/edit-status') return { status: 200, body: EDIT_STATUS_DIRTY };
      if (url === '/api/sources/doxcnT1/push/preview') return { status: 200, body: PLAN_ANCHOR_BLOCKED };
      if (url === '/api/sources/doxcnT1/history-content') {
        return {
          status: 502,
          body: { error: 'history_content_unavailable', message: '云端正文读取失败：upstream boom' },
        };
      }
      return null;
    });
    const { container, fetchLog } = mount;
    let root!: Root;
    await act(async () => {
      root = createRoot(container);
      root.render(
        <SourceEditControls
          objToken="doxcnT1"
          objType="docx"
          mdContent={HEADER + BODY}
        />,
      );
    });
    cleanupRoots.push(() => act(() => { root.unmount(); }));

    await waitFor(() => findButtonByText(container, '写回飞书') !== undefined, '写回飞书入口');
    await act(async () => {
      findButtonByText(container, '写回飞书').click();
    });
    await waitFor(() => findButtonByText(container, '对比云端与本地') !== undefined, '对比云端与本地入口');
    await act(async () => {
      findButtonByText(container, '对比云端与本地').click();
    });
    await waitFor(() => container.textContent!.includes('云端正文暂不可读'), '不可读降级态');
    expect(fetchLog.filter((c) => c.url.includes('history-content'))).toHaveLength(1);
    const text = container.textContent!;
    // 如实展示失败原因（服务端错误码 + 消息 + 引导核对），不冒充不可接入
    expect(text).toContain('history_content_unavailable');
    expect(text).toContain('upstream boom');
    expect(text).toContain('打开飞书文档核对');
    // 本地侧仍以单侧预览保留
    expect(text).toContain('本地当前正文');
    expect(text).toContain('本地当前正文（挂载链路）');
  });
});
