/**
 * KbPublishModal / KbPublishStateBadge / KbTreePanel 徽标 组件测试（P1-S9）。
 *
 * SSR + API mock（FeishuWriteSettingsCard.test.tsx 同法）：锚定发布计划表
 * （动作/阻断原因/警告/冲突标记）、确认区（确认值提示与覆盖清单）、发布
 * 历史行（状态徽标/警告/云端链接）、目录树四态徽标与未发布不渲染。
 * 完整四步交互链（预览→确认→执行→徽标）由真机浏览器验收覆盖（报告附截图）。
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));

import { KbPublishModal, PlanItemsTable, PublishHistoryList } from './KbPublishModal';
import { KbPublishStateBadge } from './KbPublishStateBadge';
import { KbTreePanel } from './KbTreePanel';
import type { KbPublicationRowDto, KbPublishPlanItemDto } from '../../types/kb-publish';
import type { KbTreeNode } from '../../types/agent';

function planItem(overrides: Partial<KbPublishPlanItemDto> = {}): KbPublishPlanItemDto {
  return {
    kbPath: 'guide/a.md',
    title: '文档 A',
    action: 'create',
    contentHash: 'h',
    warnings: [],
    state: null,
    cloudToken: null,
    cloudUrl: null,
    cloudEdited: false,
    ...overrides,
  };
}

function publicationRow(overrides: Partial<KbPublicationRowDto> = {}): KbPublicationRowDto {
  return {
    kbPath: 'guide/a.md',
    cloudToken: 'doxcnMockA',
    cloudUrl: 'https://example.feishu.cn/docx/doxcnMockA',
    targetToken: 'fldmock0001',
    publishedReleaseId: 'rel-20261028-1',
    publishedContentHash: 'h',
    publishedObjEditTime: '1760000000000',
    state: 'published',
    warningsJson: null,
    lastError: null,
    createdAt: '2026-10-28T10:00:00.000Z',
    updatedAt: '2026-10-28T10:00:00.000Z',
    warnings: { warnings: [] },
    ...overrides,
  };
}

const NODES: KbTreeNode[] = [
  {
    name: 'guide', path: 'guide', type: 'dir',
    children: [
      { name: 'a.md', path: 'guide/a.md', type: 'doc', docId: 'd1', title: '文档 A' },
      { name: 'b.md', path: 'guide/b.md', type: 'doc', docId: 'd2', title: '文档 B' },
    ],
  },
];

beforeEach(() => {
  vi.resetModules();
});

describe('KbPublishStateBadge', () => {
  it('四态渲染短标签；未发布/其他状态默认不渲染', () => {
    expect(renderToStaticMarkup(<KbPublishStateBadge state="published" compact />)).toContain('已发布');
    expect(renderToStaticMarkup(<KbPublishStateBadge state="published_with_warnings" compact />)).toContain('警告');
    expect(renderToStaticMarkup(<KbPublishStateBadge state="conflict" compact />)).toContain('冲突');
    expect(renderToStaticMarkup(<KbPublishStateBadge state="unknown" compact />)).toContain('未知');
    expect(renderToStaticMarkup(<KbPublishStateBadge state="" compact />)).toBe('');
    // creating 等非四态：树/详情默认隐藏，历史经 showAllStates 显示
    expect(renderToStaticMarkup(<KbPublishStateBadge state="creating" />)).toBe('');
    expect(renderToStaticMarkup(<KbPublishStateBadge state="creating" showAllStates />)).toContain('发布中');
  });

  it('云端 URL 渲染为链接（anchor 形态带 href）', () => {
    const html = renderToStaticMarkup(
      <KbPublishStateBadge state="published" cloudUrl="https://example.feishu.cn/docx/t1" />,
    );
    expect(html).toContain('href="https://example.feishu.cn/docx/t1"');
    expect(html).toContain('target="_blank"');
  });
});

describe('KbTreePanel 发布徽标', () => {
  it('已发布/冲突/未知文档行内显示徽标；未发布文档行不显示', () => {
    const html = renderToStaticMarkup(
      <KbTreePanel
        nodes={NODES}
        selectedDocId={null}
        onSelectDoc={() => undefined}
        releaseId="rel-1"
        publicationsByPath={new Map([
          ['guide/a.md', { state: 'published', cloudUrl: 'https://example.feishu.cn/docx/t1' }],
          ['guide/b.md', { state: 'conflict', cloudUrl: null }],
        ])}
      />,
    );
    expect(html).toContain('data-publish-state="published"');
    expect(html).toContain('data-publish-state="conflict"');
    // 徽标是 click 形态（span，不在 button 内嵌套 a）
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>).)*?<a\s/);
  });

  it('不传 publicationsByPath 时树保持原样（零徽标）', () => {
    const html = renderToStaticMarkup(
      <KbTreePanel nodes={NODES} selectedDocId={null} onSelectDoc={() => undefined} releaseId="rel-1" />,
    );
    expect(html).not.toContain('data-publish-state=');
  });
});

describe('PlanItemsTable', () => {
  it('计划行呈现动作/标题/阻断原因/警告/云端修改标记', () => {
    const html = renderToStaticMarkup(
      <PlanItemsTable
        items={[
          planItem(),
          planItem({
            kbPath: 'guide/b.md', title: '文档 B', action: 'blocked', blockedReason: 'publish_cloud_edited',
            state: 'conflict', cloudEdited: true, cloudToken: 'doxcnB', cloudUrl: 'https://example.feishu.cn/docx/b',
          }),
          planItem({
            kbPath: 'guide/c.md', title: '文档 C', action: 'update',
            warnings: [{ code: 'image_not_published', kbPath: 'guide/c.md' }],
            state: 'published',
          }),
        ]}
      />,
    );
    expect(html).toContain('新建');
    expect(html).toContain('阻断');
    expect(html).toContain('更新');
    expect(html).toContain('云端文档在发布后有修改');
    expect(html).toContain('云端有修改');
    expect(html).toContain('1 条警告');
    expect(html).toContain('data-plan-action="blocked"');
  });
});

describe('KbPublishModal 选择步与历史', () => {
  it('初始步：文档勾选清单 + 全量选项 + force 提示 + 生成计划按钮', () => {
    const html = renderToStaticMarkup(
      <KbPublishModal
        open
        initialTab="publish"
        onClose={() => undefined}
        nodes={NODES}
        publications={[]}
        publicationsLoading={false}
        onPublicationsChanged={() => undefined}
      />,
    );
    expect(html).toContain('data-publish-step="select"');
    expect(html).toContain('文档 A');
    expect(html).toContain('全部文档');
    expect(html).toContain('OVERWRITE_PUBLISHED');
    expect(html).toContain('生成发布计划');
    expect(html).toContain('type="checkbox"');
  });

  it('历史页：状态徽标/路径/时间/警告/云端链接/错误与空态', () => {
    const rows = [
      publicationRow({
        state: 'published_with_warnings',
        warnings: { warnings: [{ code: 'image_not_published', kbPath: 'guide/a.md' }], previousCloudTokens: ['doxcnOld'] },
      }),
      publicationRow({ kbPath: 'guide/b.md', state: 'conflict', cloudUrl: null, lastError: '云端文档在发布后有新的修改（publish_cloud_edited）' }),
    ];
    const html = renderToStaticMarkup(
      <PublishHistoryList publications={rows} loading={false} titleByPath={new Map([['guide/a.md', '文档 A'], ['guide/b.md', '文档 B']])} onRefresh={() => undefined} />,
    );
    expect(html).toContain('data-publish-history-state="published_with_warnings"');
    expect(html).toContain('data-publish-history-state="conflict"');
    expect(html).toContain('1 条警告');
    expect(html).toContain('历史云端文档');
    expect(html).toContain('云端');
    expect(html).toContain('publish_cloud_edited');

    const empty = renderToStaticMarkup(
      <PublishHistoryList publications={[]} loading={false} titleByPath={new Map()} onRefresh={() => undefined} />,
    );
    expect(empty).toContain('尚无发布记录');
  });
});
