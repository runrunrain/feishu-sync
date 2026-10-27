/**
 * KnowledgeView —— 标准知识库主区（F2，设计 §11.2）
 *
 * 布局：正文优先，目录/来源/构建/管理统一在默认收起的侧栏。
 *
 * 状态覆盖：加载骨架 / 未发布（Agent 就绪→引导构建；未就绪→原因+跳转）/
 * 服务不可达 / 文档加载失败 / 构建运行中（按钮禁用+取消）/ 构建失败
 * （issues + 「当前发布版本未变」）。不渲染任何假数据。
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Activity, AlertCircle, BookOpen, ChevronRight, Link2, ListTree, Loader2, Settings2, Sparkles } from 'lucide-react';
import { KbReadingControls } from '../components/kb/KbReadingControls';
import { useKbReadingPreferences } from '../hooks/useKbReadingPreferences';
import { KbTreePanel } from '../components/kb/KbTreePanel';
import { KbSourcePanel } from '../components/kb/KbSourcePanel';
import { KbChangesPanel, type KbChangeTab } from '../components/kb/KbChangesPanel';
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
  listKbBuilds,
} from '../api/client';
import type { KbBuildDto, KbBuildIssue, KbDocDto, KbDocSourceRef, KbStatusDto, KbTreeNode } from '../types/agent';
import { SseConnection } from '../utils/sseStream';
import { describeReadinessCode as describeReadiness, formatDateTime } from '../utils/agentReadiness';

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
  const { preferences, updatePreferences, storageUnavailable } = useKbReadingPreferences();
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
  const [sidebar, setSidebar] = useState<'directory' | 'sources' | 'build' | 'manage' | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState<'incremental' | 'full' | null>(null);
  const [starting, setStarting] = useState(false);

  const [changeTab, setChangeTab] = useState<KbChangeTab | null>(null);
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
        setBuild((cur) => !cur || TERMINAL_BUILD.has(cur.status) ? data.activeBuild : cur);
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

  useEffect(() => { if (!active) setSidebar(null); }, [active]);
  useEffect(() => {
    if (sidebar !== 'build' || build) return;
    let disposed = false;
    void listKbBuilds(1).then(async ({ builds }) => {
      if (!builds[0]) return;
      const detail = await getKbBuild(builds[0].id);
      if (!disposed) { setBuild(detail); setBuildIssues(detail.report?.issues ?? []); }
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [sidebar, build]);

  // ---- 派生状态 -----------------------------------------------------------
  const agentReady = agent.status?.code === 'ready' && !agent.unreachable;
  const readiness = agent.status ? describeReadiness(agent.status.code, agent.status) : null;
  const running = build != null && !TERMINAL_BUILD.has(build.status);
  const pending = kbStatus?.pending;
  const pendingTotal = pending ? pending.added + pending.changed + pending.removed : 0;

  const sidebarItems = [
    { id: 'directory' as const, label: '目录', name: '目录与搜索', icon: ListTree },
    { id: 'sources' as const, label: '来源', name: '来源与文档信息', icon: Link2 },
    { id: 'build' as const, label: '构建', name: '构建进度', icon: Activity },
    { id: 'manage' as const, label: '管理', name: '更新与版本管理', icon: Settings2 },
  ];

  return (
    <div className="relative flex h-full min-h-0 min-w-0 gap-2" data-view="knowledge">
      <article className="flex-1 min-w-0 min-h-0 rounded-md border border-line bg-card-bg shadow-sm flex flex-col overflow-hidden"
        aria-label="标准知识库正文" data-testid="kb-reader-panel">
        <header className="shrink-0 min-h-[44px] px-5 py-2 border-b border-line/60 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-seal shrink-0" />
          <h2 className="text-sm font-kai text-ink truncate flex-1">{doc?.title ?? '标准知识库'}</h2>
          {doc ? <KbReadingControls preferences={preferences} onChange={updatePreferences} storageUnavailable={storageUnavailable} active={active} /> : null}
          {running ? <button type="button" onClick={() => setSidebar('build')} className="shrink-0 flex items-center gap-1 text-xs text-seal">
            <Loader2 className="w-3 h-3 animate-spin" /> 更新中
          </button> : pendingTotal > 0 ? <button type="button" onClick={() => setChangeTab('pending')} className="shrink-0 text-xs text-seal">{pendingTotal} 处待更新</button> : null}
        </header>
        {statusError && !kbStatus ? <EmptyCard icon={<AlertCircle className="w-8 h-8 text-seal-2" />} title="标准库服务不可用"
          description={statusError} action={<Button size="sm" variant="secondary" onClick={() => { setStatusLoading(true); void loadStatus(); }}>重试</Button>} />
          : treeLoading && !tree || statusLoading ? <div className="flex-1 p-8 animate-pulse space-y-4" aria-busy="true">
            <div className="h-7 w-2/5 bg-paper-2 rounded" />{Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-3 bg-paper-2 rounded" />)}
          </div> : !tree ? !agentReady && agent.status ? <EmptyCard icon={<Settings2 className="w-8 h-8 text-seal" />}
            title={readiness?.reason ?? 'Agent 未就绪'} description={readiness?.action ?? ''}
            actions={<>{readiness?.recheck ? <Button size="sm" variant="secondary" onClick={() => agent.recheck()} loading={agent.rechecking}>重新检测</Button> : null}
              {onJumpToSettings ? <Button size="sm" onClick={onJumpToSettings}>前往设置</Button> : null}</>} />
            : <EmptyCard icon={<Sparkles className="w-8 h-8 text-jade" />} title="尚未发布标准知识库"
              description="选择参与构建的原始文档后，生成可阅读、可追溯的标准知识库。"
              actions={<><Button size="sm" variant="secondary" onClick={() => setChangeTab('sources')}>选择源文档</Button>
                <Button size="sm" disabled={!agentReady || running} onClick={() => setConfirming('full')}>开始全量构建</Button></>} />
          : docLoading || treeLoading ? <div className="p-8 animate-pulse space-y-4" aria-busy="true">
            {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-3 bg-paper-2 rounded" />)}
          </div> : docError ? <EmptyCard icon={<AlertCircle className="w-8 h-8 text-seal-2" />} title="文档加载失败" description={docError}
            action={<Button size="sm" variant="secondary" onClick={() => { void refreshPublished().then(() => setDocReload((n) => n + 1)); }}>重试</Button>} />
          : doc ? <div className="flex-1 min-h-0 overflow-auto scrollbar-thin" data-testid="kb-reading-body">
            <div className="kb-reading-page" style={{ '--kb-font-size': `${preferences.fontSize}px`, '--kb-line-height': preferences.lineHeight } as CSSProperties}>
              <MarkdownView variant="reading" content={doc.markdown} baseDir={doc.path.split('/').slice(0, -1).join('/')} remoteImages="confirm" />
            </div>
          </div> : <EmptyCard icon={<BookOpen className="w-8 h-8 text-ink-faint" />} title="选择文档开始阅读"
            description="目录和搜索位于侧栏，选择文档后侧栏会自动收起。"
            action={<Button size="sm" variant="secondary" onClick={() => setSidebar('directory')}>打开目录</Button>} />}
      </article>

      {sidebar ? <aside className="absolute right-14 inset-y-0 z-20 lg:static shrink-0 h-full min-h-0 rounded-md border border-line bg-card-bg shadow-lg lg:shadow-sm flex flex-col overflow-hidden"
        style={{ width: 'min(320px, calc(100vw - 104px))' }} aria-label="标准库侧栏" data-testid="kb-sidebar">
        <header className="shrink-0 h-11 px-3 border-b border-line/60 flex items-center justify-between">
          <h3 className="text-sm font-kai text-ink">{sidebarItems.find((item) => item.id === sidebar)?.name}</h3>
          <button type="button" onClick={() => setSidebar(null)} aria-label="收起标准库侧栏" title="收起侧栏" className="p-1 text-ink-faint hover:text-ink"><ChevronRight className="w-4 h-4" /></button>
        </header>
        {sidebar === 'directory' ? tree ? <KbTreePanel nodes={tree.nodes} selectedDocId={selectedDocId}
          onSelectDoc={(id) => { setSelectedDocId(id); setSidebar(null); }} releaseId={tree.releaseId} />
          : <p className="p-4 text-xs text-ink-faint">发布后在此浏览目录和搜索。</p>
          : sidebar === 'sources' ? doc ? <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
            <div className="px-4 py-3 space-y-2 border-b border-line/60 text-xs text-ink-soft">
              {doc.summary ? <p className="leading-relaxed">{doc.summary}</p> : null}
              <p className="text-ink-faint break-all">{doc.path}</p>
              {doc.tags.length ? <p className="text-jade">{doc.tags.join(' · ')}</p> : null}
              <p className="font-mono text-[10px] break-all text-ink-faint">{doc.releaseId}</p>
            </div>
            <div className="min-h-[200px]"><KbSourcePanel docTitle={doc.title} sources={doc.sources} onOpenSource={setSource} /></div>
          </div> : <p className="p-4 text-xs text-ink-faint">选择文档后查看来源与文档信息。</p>
          : sidebar === 'build' ? build ? <KbBuildPanel open build={build} issues={buildIssues} logs={buildLogs}
            onCollapse={() => setSidebar(null)} onCancel={cancelBuild} cancelling={cancelling} layout="sidebar" />
            : <p className="p-4 text-xs text-ink-faint">尚无构建记录。可在管理侧栏发起更新。</p>
          : <div className="flex-1 min-h-0 overflow-auto p-4 space-y-4 text-xs text-ink-soft">
            <div className="space-y-2">
              <h4 className="text-ink font-medium">当前标准库</h4>
              <p>{kbStatus?.current ? `${kbStatus.current.docCount} 篇文档 · ${kbStatus.current.sourceCount} 个来源` : '尚未发布'}</p>
              {kbStatus?.current ? <><p>{formatDateTime(kbStatus.current.publishedAt)}</p>
                <p className="font-mono text-[10px] text-ink-faint break-all">{kbStatus.current.releaseId}</p>
                <p className="font-mono text-[10px] text-ink-faint break-all">{kbStatus.current.model}</p></> : null}
            </div>
            <div className="grid grid-cols-1 gap-2 border-t border-line pt-3">
              <Button size="sm" variant="secondary" onClick={() => setChangeTab('sources')}>源文档</Button>
              <Button size="sm" variant="secondary" onClick={() => setChangeTab('pending')}>待更新差异{pendingTotal ? `（${pendingTotal}）` : ''}</Button>
              <Button size="sm" variant="secondary" onClick={() => setChangeTab('history')}>变更记录</Button>
            </div>
            <div className="space-y-3 border-t border-line pt-3">
              {agent.loading ? <StatusBadge status="loading">检测中</StatusBadge> : <StatusBadge status={agentReady ? 'success' : 'warning'}>{agentReady ? 'Agent 就绪' : readiness?.reason ?? 'Agent 未就绪'}</StatusBadge>}
              {!agentReady && readiness?.action ? <p className="text-ink-faint leading-relaxed">{readiness.action}</p> : null}
              <Button size="sm" variant="secondary" className="w-full" disabled={!agentReady || running || starting}
                loading={starting && confirming === 'incremental'} onClick={() => setConfirming('incremental')}>按变更更新</Button>
              <Button size="sm" className="w-full" disabled={!agentReady || running || starting}
                loading={starting && confirming === 'full'} onClick={() => setConfirming('full')}>全量构建</Button>
              <button type="button" className="text-ink-faint underline" onClick={agentReady ? () => void agent.recheck() : onJumpToSettings}>检查运行时与模型</button>
            </div>
          </div>}
      </aside> : null}

      <nav className="shrink-0 w-12 rounded-md border border-line bg-card-bg shadow-sm flex flex-col items-center gap-1 py-2" aria-label="标准库工具">
        {sidebarItems.map(({ id, label, name, icon: Icon }) => <button key={id} type="button" data-sidebar-trigger={id}
          onClick={() => setSidebar((value) => value === id ? null : id)} aria-label={`${sidebar === id ? '收起' : '打开'}${name}`}
          aria-expanded={sidebar === id} title={name}
          className={`relative w-10 min-h-[44px] flex flex-col items-center justify-center gap-1 rounded text-[10px] transition-colors ${sidebar === id ? 'bg-seal/10 text-seal' : 'text-ink-faint hover:bg-paper hover:text-ink'}`}>
          {id === 'build' && running ? <Loader2 className="w-4 h-4 animate-spin text-seal" /> : <Icon className="w-4 h-4" />}<span>{label}</span>
          {id === 'manage' && pendingTotal > 0 ? <span className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-seal" /> : null}
        </button>)}
      </nav>

      <RawSourceDrawer source={source} onClose={() => setSource(null)} />

      <KbChangesPanel tab={changeTab} onTab={setChangeTab} onClose={() => setChangeTab(null)}
        running={running}
        canUpdate={agentReady && !starting}
        onChanged={() => { void loadStatus(); setDocReload((n) => n + 1); }}
        onUpdate={() => { setChangeTab(null); setConfirming('incremental'); }}
        onOpenSource={(choice) => { setChangeTab(null); setSource({ objToken: choice.objToken, title: choice.title, relPath: choice.relPath, state: choice.included ? 'current' : 'excluded' }); }} />

      {/* 构建确认弹窗 */}
      <Modal
        open={confirming !== null}
        title={confirming === 'full' ? '确认全量构建' : '确认按变更更新'}
        onClose={() => setConfirming(null)}
      >
        {confirming === 'full' ? (
          <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
            <p>
              全量构建将<b className="text-ink">重新生成标准库的全部文档</b>
              {kbStatus?.current ? `（当前 ${kbStatus.current.docCount} 篇将被新发布替换）` : ''}。
              按变更更新与全量构建都会消耗已配置模型的额度；全量通常耗时与费用更高。
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
            <p>比较当前参与构建的原始源与上次发布快照，只更新受影响的标准文档：</p>
            <button type="button" className="text-xs text-seal underline" onClick={() => { setConfirming(null); setChangeTab('pending'); }}>查看源文档差异与影响范围</button>
            {pending && kbStatus?.current ? (
              <div className="flex items-center gap-3 text-xs">
                <span className="text-jade">新增 {pending.added}</span>
                <span className="text-seal">变更 {pending.changed}</span>
                <span className="text-ink-faint">移除 {pending.removed}</span>
              </div>
            ) : (
              <p className="text-xs text-ink-faint">
                尚无已发布版本：本次将执行全量构建（按变更更新在无发布时自动按全量执行）。
              </p>
            )}
            <p className="text-xs text-ink-faint">构建会消耗模型额度；失败不会改变当前发布版本。</p>
            <ConfirmActions
              confirmLabel="开始按变更更新"
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
