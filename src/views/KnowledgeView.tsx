/**
 * KnowledgeView —— 标准知识库主区（F2，设计 §11.2）
 *
 * 布局：状态条（发布版本/待处理变更/构建入口）+ 三栏（目录树·搜索 │
 * Markdown 阅读 │ 来源追溯）+ 底部构建进度抽屉。
 *
 * 状态覆盖：加载骨架 / 未发布（Agent 就绪→引导构建；未就绪→原因+跳转）/
 * 服务不可达 / 文档加载失败 / 构建运行中（按钮禁用+取消）/ 构建失败
 * （issues + 「当前发布版本未变」）。不渲染任何假数据。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, BookOpen, Loader2, Settings2, Sparkles } from 'lucide-react';
import { KbTreePanel } from '../components/kb/KbTreePanel';
import { KbSourcePanel } from '../components/kb/KbSourcePanel';
import { KbBuildPanel, type BuildLogLine } from '../components/kb/KbBuildPanel';
import { RawSourceDrawer } from '../components/kb/RawSourceDrawer';
import { MarkdownView } from '../components/preview/MarkdownView';
import { Modal } from '../components/common/Modal';
import { Button } from '../components/common/Button';
import { StatusBadge } from '../components/common/StatusBadge';
import { useToast } from '../components/common/Toast';
import { useAgentStatus } from '../hooks/useAgentStatus';
import {
  APIError,
  cancelKbBuild,
  createKbBuild,
  getKbBuild,
  getKbDoc,
  getKbStatus,
  getKbTree,
  getSseAuth,
} from '../api/client';
import type { KbBuildDto, KbBuildIssue, KbDocDto, KbDocSourceRef, KbStatusDto, KbTreeNode } from '../types/agent';
import { SseConnection } from '../utils/sseStream';
import { describeReadinessCode as describeReadiness, formatDateTime, KB_BUILD_STATUS_LABEL } from '../utils/agentReadiness';

interface KnowledgeViewProps {
  active?: boolean;
  onJumpToSettings?: () => void;
}

const TERMINAL_BUILD = new Set(['published', 'failed', 'cancelled', 'interrupted']);

/** DFS 找第一篇文档（进入已发布库时自动选中首篇）。导出供单测。 */
export function firstDocId(nodes: KbTreeNode[]): string | null {
  for (const n of nodes) {
    if (n.type === 'doc' && n.docId) return n.docId;
    if (n.children) {
      const found = firstDocId(n.children);
      if (found) return found;
    }
  }
  return null;
}

/** 发布换树后保留仍存在的选择，否则选首篇，不能继续显示已移除的旧正文。 */
export function selectPublishedDoc(nodes: KbTreeNode[], previous: string | null): string | null {
  const contains = (items: KbTreeNode[]): boolean => items.some((node) =>
    (node.type === 'doc' && node.docId === previous) || (node.children ? contains(node.children) : false));
  return previous && contains(nodes) ? previous : firstDocId(nodes);
}

export function KnowledgeView({ active = true, onJumpToSettings }: KnowledgeViewProps) {
  const toast = useToast();
  const agent = useAgentStatus(active);

  const [kbStatus, setKbStatus] = useState<KbStatusDto | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [tree, setTree] = useState<{ releaseId: string; nodes: KbTreeNode[] } | null>(null);
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
  const [loadedDoc, setDoc] = useState<KbDocDto | null>(null);
  const doc = loadedDoc?.releaseId === tree?.releaseId && loadedDoc?.releaseId === kbStatus?.current?.releaseId ? loadedDoc : null;
  const [docReload, setDocReload] = useState(0);
  const [docLoading, setDocLoading] = useState(false);
  const [docError, setDocError] = useState<string | null>(null);

  const [build, setBuild] = useState<KbBuildDto | null>(null);
  const [buildIssues, setBuildIssues] = useState<KbBuildIssue[]>([]);
  const [buildLogs, setBuildLogs] = useState<BuildLogLine[]>([]);
  const [buildPanelOpen, setBuildPanelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState<'incremental' | 'full' | null>(null);
  const [starting, setStarting] = useState(false);

  const [source, setSource] = useState<KbDocSourceRef | null>(null);
  const docReqSeq = useRef(0);
  const buildConnRef = useRef<SseConnection | null>(null);
  const logSeq = useRef(0);

  const appendLog = useCallback((kind: BuildLogLine['kind'], text: string, at?: string) => {
    setBuildLogs((prev) => [
      ...prev.slice(-400),
      { id: (logSeq.current += 1), kind, text, at },
    ]);
  }, []);

  // ---- 状态与树加载 -------------------------------------------------------
  const loadStatus = useCallback(async () => {
    try {
      const data = await getKbStatus();
      setKbStatus(data);
      setStatusError(null);
      if (data.activeBuild && !TERMINAL_BUILD.has(data.activeBuild.status)) {
        // 刷新时发现进行中的构建：接管追踪（面板只在没有本地追踪时接管）。
        setBuild((cur) => cur ?? data.activeBuild ?? null);
        setBuildPanelOpen(true);
      }
      return data;
    } catch (err) {
      setStatusError(err instanceof APIError ? err.message : '标准库状态服务不可用');
      return null;
    } finally {
      setStatusLoading(false);
    }
  }, []);

  const loadTree = useCallback(async (): Promise<{ releaseId: string; nodes: KbTreeNode[] } | null> => {
    setTreeLoading(true);
    try {
      const data = await getKbTree();
      setTree(data);
      return data;
    } catch (err) {
      if (err instanceof APIError && err.statusCode === 404) {
        setTree(null); // 未发布：正常空状态
      } else {
        setTree(null);
        toast.push({ type: 'warning', message: '标准库目录加载失败', hint: String(err) });
      }
      return null;
    } finally {
      setTreeLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (!active) return;
    void loadStatus().then((status) => {
      if (status?.current) void loadTree();
    });
  }, [active, loadStatus, loadTree]);

  // 发布完成后刷新：状态 + 新树。
  const refreshPublished = useCallback(async () => {
    const status = await loadStatus();
    if (status?.current) {
      const nextTree = await loadTree();
      if (nextTree && !selectedDocId) {
        const first = firstDocId(nextTree.nodes);
        if (first) setSelectedDocId(first);
      }
    }
  }, [loadStatus, loadTree, selectedDocId]);

  // 每次发布换树都复核选择；同一docId也可能有新正文。
  useEffect(() => {
    if (tree) setSelectedDocId((previous) => selectPublishedDoc(tree.nodes, previous));
  }, [tree, selectedDocId]);

  // ---- 文档加载 -----------------------------------------------------------
  useEffect(() => {
    const seq = (docReqSeq.current += 1);
    if (!selectedDocId || !tree || selectPublishedDoc(tree.nodes, selectedDocId) !== selectedDocId) {
      setDoc(null);
      setDocLoading(false);
      setDocError(null);
      return;
    }
    const releaseId = tree.releaseId;
    setDocLoading(true);
    setDocError(null);
    setDoc(null);
    getKbDoc(selectedDocId)
      .then((data) => {
        if (docReqSeq.current !== seq) return;
        if (data.releaseId !== releaseId) throw new APIError('标准库版本已变化，请刷新目录后重试', 409);
        setDoc(data);
      })
      .catch((err) => {
        if (docReqSeq.current !== seq) return;
        setDocError(err instanceof APIError ? err.message : '文档加载失败');
      })
      .finally(() => {
        if (docReqSeq.current !== seq) return;
        setDocLoading(false);
      });
  }, [selectedDocId, tree, docReload]);

  // ---- 构建 SSE 追踪 ------------------------------------------------------
  const buildId = build && !TERMINAL_BUILD.has(build.status) ? build.id : null;
  useEffect(() => {
    if (!active || !buildId) return;
    const connection = new SseConnection({
      endpoint: `/api/kb/builds/${encodeURIComponent(buildId)}/events`,
      getAuth: getSseAuth,
      onMessage: (m) => {
        let payload: any;
        try {
          payload = JSON.parse(m.data);
        } catch {
          return;
        }
        switch (m.event) {
          case 'build_status': {
            const next = payload as KbBuildDto;
            setBuild(next);
            if (TERMINAL_BUILD.has(next.status)) {
              if (next.status === 'published') {
                if (next.noChanges) {
                  toast.push({ type: 'info', message: '原始库无变更，未生成新发布' });
                } else {
                  toast.push({ type: 'success', message: `标准库已发布：${next.releaseId ?? ''}` });
                }
                void refreshPublished();
              }
              if (next.status === 'failed') {
                // 失败态拉取校验报告（issues）。
                void getKbBuild(next.id)
                  .then((detail) => setBuildIssues(detail.report?.issues ?? []))
                  .catch(() => setBuildIssues([]));
              }
            }
            break;
          }
          case 'build_log':
            appendLog(payload?.level ?? 'info', String(payload?.message ?? ''), payload?.at);
            break;
          case 'tool':
            appendLog(
              payload?.phase === 'end' ? 'tool-end' : 'tool-start',
              `${payload?.toolName ?? ''} ${payload?.summary ?? ''}${payload?.isError ? ' ✕' : ''}`,
            );
            break;
          case 'assistant_delta':
            appendLog('assistant', String(payload?.delta ?? ''));
            break;
          default:
            break;
        }
      },
    });
    buildConnRef.current = connection;
    void connection.start();
    return () => {
      connection.stop();
      if (buildConnRef.current === connection) buildConnRef.current = null;
    };
  }, [active, buildId, appendLog, refreshPublished, toast]);

  // ---- 构建动作 -----------------------------------------------------------
  const startBuild = useCallback(
    async (mode: 'incremental' | 'full') => {
      setStarting(true);
      try {
        const dto = await createKbBuild(mode);
        setBuild(dto);
        setBuildIssues([]);
        setBuildLogs([]);
        setBuildPanelOpen(true);
        if (TERMINAL_BUILD.has(dto.status)) {
          // 立即终态（如 no_changes 直接 published）。
          if (dto.noChanges) {
            toast.push({ type: 'info', message: '原始库无变更，未生成新发布' });
            void loadStatus();
          }
        }
        setConfirming(null);
      } catch (err) {
        if (err instanceof APIError) {
          const code = (err.response as { error?: string } | undefined)?.error;
          if (code === 'agent_not_ready') {
            toast.push({ type: 'warning', message: `Agent 未就绪：${err.message}` });
            agent.refresh();
          } else if (code === 'kb_build_running') {
            toast.push({ type: 'warning', message: '已有构建正在进行' });
            setBuildPanelOpen(true);
            void loadStatus();
          } else {
            toast.push({ type: 'error', message: `构建启动失败：${err.message}` });
          }
        } else {
          toast.push({ type: 'error', message: '构建启动失败' });
        }
      } finally {
        setStarting(false);
      }
    },
    [agent, loadStatus, toast],
  );

  const cancelBuild = useCallback(async () => {
    if (!build) return;
    setCancelling(true);
    try {
      const dto = await cancelKbBuild(build.id);
      setBuild(dto);
      toast.push({ type: 'info', message: '已请求取消，等待构建停止' });
    } catch (err) {
      toast.push({ type: 'error', message: err instanceof APIError ? err.message : '取消失败' });
    } finally {
      setCancelling(false);
    }
  }, [build, toast]);

  // ---- 派生状态 -----------------------------------------------------------
  const agentReady = agent.status?.code === 'ready' && !agent.unreachable;
  const readiness = agent.status ? describeReadiness(agent.status.code, agent.status) : null;
  const running = build != null && !TERMINAL_BUILD.has(build.status);
  const pending = kbStatus?.pending;
  const pendingTotal = pending ? pending.added + pending.changed + pending.removed : 0;

  return (
    <div className="flex flex-col h-full min-h-0 gap-3" data-view="knowledge">
      {/* 状态条 */}
      <div className="shrink-0 rounded-md border border-line bg-card-bg shadow-sm px-4 py-2.5 flex items-center gap-3 flex-wrap">
        <BookOpen className="w-4 h-4 text-seal shrink-0" />
        {statusLoading ? (
          <span className="text-xs text-ink-faint inline-flex items-center gap-1.5">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 正在读取标准库状态…
          </span>
        ) : kbStatus?.current ? (
          <>
            <span className="text-xs text-ink">
              已发布 <span className="font-mono">{kbStatus.current.releaseId}</span>
            </span>
            <span className="text-[11px] text-ink-faint">{formatDateTime(kbStatus.current.publishedAt)}</span>
            <span className="text-[11px] text-ink-faint">{kbStatus.current.docCount} 篇文档</span>
            {kbStatus.current.model ? (
              <span className="text-[11px] text-ink-faint font-mono truncate max-w-[200px]" title={kbStatus.current.model}>
                {kbStatus.current.model}
              </span>
            ) : null}
          </>
        ) : (
          <span className="text-xs text-ink-faint">尚未发布标准库</span>
        )}

        {pending && pendingTotal > 0 && kbStatus?.current ? (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border border-[rgba(180,83,9,0.35)] bg-[rgba(180,83,9,0.06)] text-[11px] text-[#92580c]">
            <AlertTriangle className="w-3 h-3" />
            原始库 {pendingTotal} 处变更未进入标准库
            <span className="font-mono">
              +{pending.added} ~{pending.changed} -{pending.removed}
            </span>
          </span>
        ) : null}

        <div className="flex-1" />

        {/* Agent 就绪徽标：构建能力一目了然 */}
        <button
          type="button"
          onClick={agentReady ? () => agent.recheck() : (onJumpToSettings ?? (() => {}))}
          className="shrink-0"
          title={agentReady ? '点击重新检测' : readiness ? `${readiness.reason}：${readiness.action}` : 'Agent 状态未知'}
        >
          {agent.loading ? (
            <StatusBadge status="loading">检测中</StatusBadge>
          ) : agentReady ? (
            <StatusBadge status="success">Agent 就绪</StatusBadge>
          ) : agent.unreachable ? (
            <StatusBadge status="error">Agent 服务不可用</StatusBadge>
          ) : (
            <StatusBadge status="warning">Agent 未就绪</StatusBadge>
          )}
        </button>

        <Button
          size="sm"
          variant="secondary"
          disabled={!agentReady || running || starting}
          loading={starting && confirming === 'incremental'}
          onClick={() => setConfirming('incremental')}
          title={!agentReady && readiness ? `${readiness.reason}——${readiness.action}` : undefined}
        >
          增量构建
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!agentReady || running || starting}
          loading={starting && confirming === 'full'}
          onClick={() => setConfirming('full')}
          title={!agentReady && readiness ? `${readiness.reason}——${readiness.action}` : undefined}
        >
          全量构建
        </Button>
      </div>

      {/* 主体三栏 / 空状态 */}
      {statusError && !kbStatus ? (
        <EmptyCard
          icon={<AlertCircle className="w-8 h-8 text-seal-2" />}
          title="标准库服务不可用"
          description={statusError}
          action={
            <Button size="sm" variant="secondary" onClick={() => { setStatusLoading(true); void loadStatus(); }}>
              重试
            </Button>
          }
        />
      ) : treeLoading && !tree ? (
        <div className="flex-1 min-h-0 grid grid-cols-[280px_1fr_288px] gap-3">
          <div className="rounded-md border border-line bg-card-bg animate-pulse" />
          <div className="rounded-md border border-line bg-card-bg animate-pulse" />
          <div className="rounded-md border border-line bg-card-bg animate-pulse" />
        </div>
      ) : !tree ? (
        !agentReady && agent.status ? (
          <EmptyCard
            icon={<Settings2 className="w-8 h-8 text-seal" />}
            title={readiness?.reason ?? 'Agent 未就绪'}
            description={readiness?.action ?? ''}
            actions={
              <>
                {readiness?.recheck ? (
                  <Button size="sm" variant="secondary" onClick={() => agent.recheck()} loading={agent.rechecking}>
                    重新检测
                  </Button>
                ) : null}
                {readiness?.jumpSettings && onJumpToSettings ? (
                  <Button size="sm" variant="primary" onClick={onJumpToSettings}>
                    前往设置
                  </Button>
                ) : null}
              </>
            }
          />
        ) : (
          <EmptyCard
            icon={<Sparkles className="w-8 h-8 text-jade" />}
            title="尚未发布标准知识库"
            description="标准库由 AI 依据本地原始库生成：先在「同步」区完成飞书同步，再在此触发全量构建。构建会消耗已配置模型的额度。"
            actions={
              <Button
                size="sm"
                variant="primary"
                disabled={!agentReady || running}
                onClick={() => setConfirming('full')}
              >
                开始全量构建
              </Button>
            }
          />
        )
      ) : (
        <div className="flex-1 min-h-0 grid grid-cols-[minmax(200px,260px)_minmax(0,1fr)_auto] gap-3">
          <div className="min-h-0 rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
            <KbTreePanel
              nodes={tree.nodes}
              selectedDocId={selectedDocId}
              onSelectDoc={setSelectedDocId}
              releaseId={tree.releaseId}
            />
          </div>

          {/* 阅读中栏 */}
          <div className="min-h-0 rounded-md border border-line bg-card-bg shadow-sm flex flex-col overflow-hidden">
            {docLoading || treeLoading ? (
              <div className="px-6 py-5 space-y-4 animate-pulse" aria-busy="true">
                <div className="h-7 w-2/5 rounded bg-paper-2" />
                <div className="h-3 w-3/4 rounded bg-paper-2" />
                <div className="space-y-2">
                  {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="h-3.5 rounded bg-paper-2" style={{ width: `${60 + ((i * 17) % 38)}%` }} />
                  ))}
                </div>
              </div>
            ) : docError ? (
              <EmptyCard
                icon={<AlertCircle className="w-8 h-8 text-seal-2" />}
                title="文档加载失败"
                description={docError}
                action={
                  <Button size="sm" variant="secondary" onClick={() => { void refreshPublished().then(() => setDocReload((value) => value + 1)); }}>
                    重试
                  </Button>
                }
              />
            ) : doc ? (
              <>
                <header className="shrink-0 px-6 pt-5 pb-3 border-b border-line/60">
                  <h2 className="text-lg font-kai font-medium text-ink leading-snug">{doc.title}</h2>
                  {doc.summary ? <p className="mt-1.5 text-xs text-ink-soft leading-relaxed">{doc.summary}</p> : null}
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {doc.tags.map((tag) => (
                      <span
                        key={tag}
                        className="px-1.5 py-0.5 rounded-sm text-[10px] bg-jade/10 text-jade border border-jade/20"
                      >
                        {tag}
                      </span>
                    ))}
                    <span className="ml-auto text-[10px] text-ink-faint font-mono" title={`构建 ${doc.updatedInBuild}`}>
                      {doc.path}
                    </span>
                  </div>
                </header>
                <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
                  <MarkdownView
                    content={doc.markdown}
                    baseDir={doc.path.split('/').slice(0, -1).join('/')}
                    remoteImages="confirm"
                  />
                </div>
              </>
            ) : (
              <EmptyCard
                icon={<BookOpen className="w-8 h-8 text-ink-faint" />}
                title="选择左侧文档开始阅读"
                description="标准库文档由 AI 依据原始来源生成，右侧可追溯每一篇来源。"
              />
            )}
          </div>

          {/* 来源右栏 */}
          <div className="min-h-0 w-[288px] rounded-md border border-line bg-card-bg shadow-sm overflow-hidden">
            {doc ? (
              <KbSourcePanel docTitle={doc.title} sources={doc.sources} onOpenSource={setSource} />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-ink-faint px-6 text-center">
                选择文档后在此查看其原始来源与版本状态
              </div>
            )}
          </div>
        </div>
      )}

      {/* 构建进行中提醒条（面板收起时可见） */}
      {running && !buildPanelOpen && build ? (
        <button
          type="button"
          onClick={() => setBuildPanelOpen(true)}
          className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-md border border-seal/30 bg-[rgba(158,43,37,0.05)] text-xs text-seal hover:bg-[rgba(158,43,37,0.09)] transition-colors"
        >
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
          构建进行中 · {KB_BUILD_STATUS_LABEL[build.status] ?? build.status}
          {build.progress.batchTotal > 0
            ? ` · 批次 ${Math.min(build.progress.batchIndex + 1, build.progress.batchTotal)}/${build.progress.batchTotal}`
            : ''}
          <span className="text-ink-faint">点击展开</span>
        </button>
      ) : null}

      <KbBuildPanel
        open={buildPanelOpen}
        build={build}
        issues={buildIssues}
        logs={buildLogs}
        onCollapse={() => setBuildPanelOpen(false)}
        onCancel={cancelBuild}
        cancelling={cancelling}
      />

      <RawSourceDrawer source={source} onClose={() => setSource(null)} />

      {/* 构建确认弹窗 */}
      <Modal
        open={confirming !== null}
        title={confirming === 'full' ? '确认全量构建' : '确认增量构建'}
        onClose={() => setConfirming(null)}
      >
        {confirming === 'full' ? (
          <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
            <p>
              全量构建将<b className="text-ink">重新生成标准库的全部文档</b>
              {kbStatus?.current ? `（当前 ${kbStatus.current.docCount} 篇将被新发布替换）` : ''}。
              增量与全量都会消耗已配置模型的额度；全量通常耗时与费用更高。
            </p>
            <p className="text-xs text-ink-faint">
              发布前旧版本保持可用；任何失败都不会改变当前已发布的版本。
            </p>
            <ConfirmActions
              confirmLabel="开始全量构建"
              busy={starting}
              onConfirm={() => startBuild('full')}
              onCancel={() => setConfirming(null)}
            />
          </div>
        ) : (
          <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
            <p>将基于当前原始库的变更生成新版本：</p>
            {pending && kbStatus?.current ? (
              <div className="flex items-center gap-3 text-xs">
                <span className="text-jade">新增 {pending.added}</span>
                <span className="text-seal">变更 {pending.changed}</span>
                <span className="text-ink-faint">移除 {pending.removed}</span>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">
                尚无已发布版本：本次将执行全量构建（增量构建在无发布时自动按全量执行）。
              </p>
            )}
            <p className="text-xs text-ink-faint">构建会消耗模型额度；失败不会改变当前发布版本。</p>
            <ConfirmActions
              confirmLabel="开始增量构建"
              busy={starting}
              onConfirm={() => startBuild('incremental')}
              onCancel={() => setConfirming(null)}
            />
          </div>
        )}
      </Modal>
    </div>
  );
}

function ConfirmActions({
  confirmLabel,
  busy,
  onConfirm,
  onCancel,
}: {
  confirmLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex justify-end gap-2 pt-1">
      <Button size="sm" variant="secondary" onClick={onCancel} disabled={busy}>
        取消
      </Button>
      <Button size="sm" variant="primary" onClick={onConfirm} loading={busy}>
        {confirmLabel}
      </Button>
    </div>
  );
}

function EmptyCard({
  icon,
  title,
  description,
  action,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex-1 min-h-0 rounded-md border border-line bg-card-bg shadow-sm flex flex-col items-center justify-center gap-3 px-8 py-10 text-center animate-fade-in">
      <div className="p-4 rounded-full bg-paper border border-line text-ink-faint">{icon}</div>
      <h3 className="text-base font-kai font-medium text-ink">{title}</h3>
      {description ? <p className="max-w-md text-xs text-ink-soft leading-relaxed">{description}</p> : null}
      {action ?? null}
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
