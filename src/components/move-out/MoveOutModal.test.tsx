/**
 * MoveOutModal SSR 测试（P2-S7）——哑面板锚定（HistoryRevertModal 无壳
 * SSR 同法：effects 不跑，异步轮询由真机浏览器验证覆盖）：
 *   - preview 面板：blocked 八分支抽查 / 后果文案 / 确认值精确匹配门控
 *   - result 面板：moving（徽标+任务） / moved / failed（原因） / unknown（引导）
 *   - 弹窗壳初始渲染：preview loading 态
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../common/Toast', () => ({ useToast: () => ({ push: vi.fn() }) }));
import { MoveOutModal, MoveOutPreviewPanel, MoveOutResultPanel } from './MoveOutModal';
import { deriveMoveOutConfirmValue } from './labels';
import type { MoveOutPreview } from '../../types';

function makePlan(overrides: Partial<MoveOutPreview> = {}): MoveOutPreview {
  return {
    objToken: 'doxcnT1',
    title: '过时草稿',
    nodeToken: 'wikinfAbc123',
    watchedRootId: 'wr1',
    watchedRootLabel: '/Users/x/kb/团队知识库',
    hasChildren: false,
    target: { folderToken: null, label: '个人空间根' },
    consequences: [
      '文档将离开知识库「团队知识库」',
      '知识库成员将不再通过知识库权限访问它',
      '本应用将停止同步该文档，本地文件与标准库内容保持不变',
      '本应用不提供移回',
    ],
    blockedReason: null,
    ...overrides,
  };
}

const noop = () => {};

describe('MoveOutPreviewPanel blocked 呈现（八分支抽查）', () => {
  it('has_children → 暂不能移出 + 可读文案', () => {
    const html = renderToStaticMarkup(
      <MoveOutPreviewPanel
        plan={makePlan({ blockedReason: 'has_children' })}
        confirmText=""
        onConfirmTextChange={noop}
        executing={false}
        execError={null}
        onCancel={noop}
        onExecute={noop}
      />,
    );
    expect(html).toContain('暂不能移出');
    expect(html).toContain('子节点');
    // blocked 时不渲染确认输入与执行按钮。
    expect(html).not.toContain('moveout-confirm-input');
    expect(html).not.toContain('moveout-execute');
  });

  it('kb_build_active / not_watched_root 文案映射正确', () => {
    for (const reason of ['kb_build_active', 'not_watched_root'] as const) {
      const html = renderToStaticMarkup(
        <MoveOutPreviewPanel
          plan={makePlan({ blockedReason: reason })}
          confirmText=""
          onConfirmTextChange={noop}
          executing={false}
          execError={null}
          onCancel={noop}
          onExecute={noop}
        />,
      );
      expect(html).toContain('暂不能移出');
    }
  });

  it('preview 加载失败错误码也走可读文案（source_not_found）', () => {
    const html = renderToStaticMarkup(
      <MoveOutPreviewPanel
        plan={makePlan({ blockedReason: 'source_not_found' })}
        confirmText=""
        onConfirmTextChange={noop}
        executing={false}
        execError={null}
        onCancel={noop}
        onExecute={noop}
      />,
    );
    expect(html).toContain('文档不在库中');
  });
});

describe('MoveOutPreviewPanel 正常面：信息卡 + 后果 + 确认值门控', () => {
  const render = (confirmText: string) =>
    renderToStaticMarkup(
      <MoveOutPreviewPanel
        plan={makePlan()}
        confirmText={confirmText}
        onConfirmTextChange={noop}
        executing={false}
        execError={null}
        onCancel={noop}
        onExecute={noop}
      />,
    );

  it('展示文档名 / 所属知识库 / 目标=个人空间根 / 权威 node token', () => {
    const html = render(deriveMoveOutConfirmValue('wikinfAbc123'));
    expect(html).toContain('过时草稿');
    expect(html).toContain('团队知识库');
    expect(html).toContain('个人空间根');
    expect(html).toContain('wikinfAbc123');
  });

  it('后果固定文案 + 不可逆提示（不再同步，本地与标准库保留不动）', () => {
    const html = render(deriveMoveOutConfirmValue('wikinfAbc123'));
    expect(html).toContain('文档将离开知识库');
    expect(html).toContain('本应用不提供移回');
    expect(html).toContain('移出后不再同步该文档；本地文件与标准库内容保留不动');
    expect(html).toContain('不可逆操作');
  });

  it('确认值精确匹配门控：不匹配 → 执行按钮 disabled + 提示需精确匹配', () => {
    const html = render('MOVE_OUT:wrongToken');
    const button = html.match(/<button[^>]*moveout-execute[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).toContain('disabled=""');
    expect(html).toContain('需要精确匹配');
    expect(html).toContain('MOVE_OUT:wikinfAbc123');
  });

  it('确认值匹配（预填值原样）→ 按钮可执行（无 disabled 属性）', () => {
    const html = render(deriveMoveOutConfirmValue('wikinfAbc123'));
    const button = html.match(/<button[^>]*moveout-execute[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).not.toBe('');
    expect(button).not.toContain('disabled=""');
  });
});

describe('MoveOutResultPanel 终态呈现', () => {
  it('moving：徽标 + 任务 id + 轮询说明', () => {
    const html = renderToStaticMarkup(
      <MoveOutResultPanel result={{ kind: 'moving', moveId: 'mv_1', taskId: 'task-9', message: null }} pollCount={3} onClose={noop} />,
    );
    expect(html).toContain('移出执行中');
    expect(html).toContain('task-9');
    expect(html).toContain('已轮询 3 次');
    expect(html).toContain('mv_1');
  });

  it('moved：成功文案 + 本地保留说明', () => {
    const html = renderToStaticMarkup(
      <MoveOutResultPanel result={{ kind: 'moved', moveId: 'mv_1', taskId: null, message: '移出完成于 2026-01-01 08:00:05' }} pollCount={0} onClose={noop} />,
    );
    expect(html).toContain('已移出到云空间');
    expect(html).toContain('本地文件与标准库内容保留不动');
  });

  it('failed：失败原因 + 可重新发起说明', () => {
    const html = renderToStaticMarkup(
      <MoveOutResultPanel result={{ kind: 'failed', moveId: 'mv_1', taskId: null, message: 'upstream 99991400' }} pollCount={0} onClose={noop} />,
    );
    expect(html).toContain('移出失败');
    expect(html).toContain('upstream 99991400');
    expect(html).toContain('重新发起');
  });

  it('unknown：不自动重试 + 到飞书核对引导（P2-S6 语义）', () => {
    const html = renderToStaticMarkup(
      <MoveOutResultPanel result={{ kind: 'unknown', moveId: 'mv_1', taskId: null, message: '轮询超时' }} pollCount={120} onClose={noop} />,
    );
    expect(html).toContain('移出状态未知（不自动重试）');
    expect(html).toContain('到飞书知识库核对');
    expect(html).toContain('只读刷新');
  });
});

describe('MoveOutModal 壳初始渲染', () => {
  it('target 存在 + open：渲染标题与说明行（SSR 不跑 effects，preview 由加载后驱动）', () => {
    const html = renderToStaticMarkup(
      <MoveOutModal
        open
        onClose={noop}
        objToken="doxcnT1"
        target={{ objToken: 'doxcnT1', title: '过时草稿' }}
        onMoved={noop}
      />,
    );
    expect(html).toContain('移出到云空间');
    expect(html).toContain('删除的安全替代');
    // 初始态无 preview 数据：确认输入与执行按钮尚未渲染。
    expect(html).not.toContain('moveout-confirm-input');
    expect(html).not.toContain('moveout-execute');
  });

  it('target 为 null：不渲染弹窗内容（入口守卫）', () => {
    const html = renderToStaticMarkup(
      <MoveOutModal open onClose={noop} objToken={null} target={null} onMoved={noop} />,
    );
    expect(html).not.toContain('删除的安全替代');
  });
});
