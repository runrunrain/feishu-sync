/**
 * KnowledgeView —— 标准知识库主区（F2，设计 §11.2）
 *
 * 布局：左侧常驻目录，右侧按需展开来源、发布、构建和进度。
 *
 * 状态覆盖：加载骨架 / 未发布（Agent 就绪→引导构建；未就绪→原因+跳转）/
 * 服务不可达 / 文档加载失败 / 构建运行中（按钮禁用+取消）/ 构建失败
 * （issues + 「当前发布版本未变」）。不渲染任何假数据。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Activity, AlertCircle, BookOpen, ChevronLeft, ChevronRight, CloudUpload, Hammer, Link2, ListTree, Loader2, Settings2, ShieldCheck, Sparkles } from 'lucide-react';
import { KbReadingControls } from '../components/kb/KbReadingControls';
import { useKbReadingPreferences } from '../hooks/useKbReadingPreferences';
import { KbTreePanel } from '../components/kb/KbTreePanel';
import { KbSourcePanel } from '../components/kb/KbSourcePanel';
import { KbChangesPanel, type KbChangeTab } from '../components/kb/KbChangesPanel';
import { KbBuildPanel, type BuildLogLine } from '../components/kb/KbBuildPanel';
import { KbPublishPanel } from '../components/kb/KbPublishPanel';
import { KbPublishModal, type KbPublishModalTab } from '../components/kb/KbPublishModal';
import { KbPublishStateBadge } from '../components/kb/KbPublishStateBadge';
import { KbGovernancePanel } from '../components/kb/KbGovernancePanel';
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
  getKbBuildLogs,
  getKbDoc,
  getKbStatus,
  getKbTree,
  getSseAuth,
  listKbBuilds,
  listKbPublications,
  resumeKbBuild,
} from '../api/client';
import type { KbBuildDto, KbBuildIssue, KbDocDto, KbDocSourceRef, KbStatusDto, KbTreeNode } from '../types/agent';
import type { KbPublicationRowDto } from '../types/kb-publish';
import { SseConnection } from '../utils/sseStream';
import { describeReadinessCode as describeReadiness } from '../utils/agentReadiness';
import { flattenDocPaths } from '../utils/kbPublish';

interface KnowledgeViewProps {
  active?: boolean;
  onJumpToSettings?: () => void;
  /** P1-S9：发布门控/发布根设置的直达入口（设置 → 飞书认证 → 飞书发布）。 */
  onJumpToPublishSettings?: () => void;
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

export function KnowledgeView({ active = true, onJumpToSettings, onJumpToPublishSettings }: KnowledgeViewProps) {
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
  // 连接只随构建身份切换；启动时读取最新状态快照中的续传游标。
  const latestBuild = useRef(build); latestBuild.current = build;
  const [buildIssues, setBuildIssues] = useState<KbBuildIssue[]>([]);
  const [buildLogs, setBuildLogs] = useState<BuildLogLine[]>([]);
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [sidebar, setSidebar] = useState<'sources' | 'build' | 'publish' | 'progress' | 'governance' | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState<'incremental' | 'selected' | null>(null);
  const [selectedBuildCount, setSelectedBuildCount] = useState(0);
  const [refreshImages, setRefreshImages] = useState(false);
  const [starting, setStarting] = useState(false);
  const [resumeConfirm, setResumeConfirm] = useState(false);
  const [resuming, setResuming] = useState(false);

  const [changeTab, setChangeTab] = useState<KbChangeTab>('sources');
  const [source, setSource] = useState<KbDocSourceRef | null>(null);
  const [publications, setPublications] = useState<KbPublicationRowDto[]>([]);
  const [publicationsLoading, setPublicationsLoading] = useState(false);
  const [publishModal, setPublishModal] = useState<{ open: boolean; tab: KbPublishModalTab }>({ open: false, tab: 'publish' });
  const docReqSeq = useRef(0);
  const buildConnRef = useRef<SseConnection | null>(null);
  const logSeq = useRef(0);

  const appendLog = useCallback((kind: BuildLogLine['kind'], text: string, at?: string, seq?: number) => {
    setBuildLogs((prev) => seq !== undefined && prev.some((line) => line.seq === seq) ? prev : [
      ...prev.slice(-399),
      { id: (logSeq.current += 1), kind, text, at, seq },
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

  // ---- 反向发布记录（P1-S9：树/详情徽标 + 发布历史数据面） ---------------
  const loadPublications = useCallback(async () => {
    setPublicationsLoading(true);
    try {
      const data = await listKbPublications();
      setPublications(data.publications ?? []);
    } catch {
      // 旧版本服务端无该端点时静默降级：无徽标，不阻断阅读主链路。
      setPublications([]);
    } finally {
      setPublicationsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void loadStatus().then((status) => {
      if (status?.current) void loadTree();
    });
    void loadPublications();
  }, [active, loadStatus, loadTree, loadPublications]);

  const publicationsByPath = useMemo(
    () => new Map(publications.map((row) => [row.kbPath, { state: row.state, cloudUrl: row.cloudUrl }])),
    [publications],
  );

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
      initialLastEventId: latestBuild.current?.eventSeq !== undefined ? String(latestBuild.current.eventSeq) : undefined,
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
            appendLog(payload?.level ?? 'info', String(payload?.message ?? ''), payload?.at, m.id ? Number(m.id) : undefined);
            break;
          case 'tool':
            appendLog(
              payload?.phase === 'end' ? 'tool-end' : 'tool-start',
              `${payload?.isError ? '✕ ' : ''}${payload?.toolName ?? ''} ${payload?.summary ?? ''}`,
              undefined, m.id ? Number(m.id) : undefined,
            );
            break;
          case 'assistant_delta':
            appendLog('assistant', String(payload?.delta ?? ''), undefined, m.id ? Number(m.id) : undefined);
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
    async (mode: 'incremental' | 'selected', refresh = false) => {
      setStarting(true);
      try {
        const dto = mode === 'selected'
          ? await createKbBuild('incremental', { rebuildSelected: true, ...(refresh ? { refreshImages: true } : {}) })
          : await createKbBuild('incremental');
        setBuild(dto);
        setBuildIssues([]);
        setBuildLogs([]);
        if (dto.status === 'published') {
          // 立即终态（如 no_changes 直接 published）。
          if (dto.noChanges) {
            toast.push({ type: 'info', message: '原始库无变更，未生成新发布' });
          }
          void refreshPublished();
        }
        setConfirming(null);
        setRefreshImages(false);
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
    [agent, loadStatus, refreshPublished, toast],
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

  const continueBuild = async () => {
    if (!build) return;
    setResuming(true);
    try {
      const dto = await resumeKbBuild(build.id);
      setBuild(dto); setBuildIssues([]); setResumeConfirm(false);
      appendLog('info', '已请求从检查点继续构建');
    } catch (error) {
      toast.push({ type: 'error', message: error instanceof Error ? error.message : '继续构建失败' });
      const code = error instanceof APIError ? (error.response as { error?: string } | undefined)?.error : null;
      if (code && ['source_changed_during_build', 'kb_resume_stale', 'kb_resume_unavailable'].includes(code)) {
        setResumeConfirm(false);
        setBuild((previous) => previous?.recovery ? { ...previous, recovery: { ...previous.recovery, canResume: false, reason: error instanceof Error ? error.message : '检查点不可用，请重新构建' } } : previous);
      } else {
        void getKbBuild(build.id).then(setBuild).catch(() => undefined);
      }
    } finally { setResuming(false); }
  };

  // 重启应用后恢复落盘日志；已有实时日志时保持当前流，避免重复插入。
  const trackedBuildId = build?.id;
  useEffect(() => {
    if (!trackedBuildId) return;
    let disposed = false;
    void getKbBuildLogs(trackedBuildId).then(({ events }) => {
      if (disposed) return;
      const restored: BuildLogLine[] = events.flatMap(({ seq, event, data }) => {
        const line = event === 'build_log' ? { kind: data.level ?? 'info', text: data.message ?? '', at: data.at }
          : event === 'tool' ? { kind: data.phase === 'end' ? 'tool-end' as const : 'tool-start' as const, text: `${data.isError ? '✕ ' : ''}${data.toolName ?? ''} ${data.summary ?? ''}` }
          : event === 'assistant_delta' ? { kind: 'assistant' as const, text: data.delta ?? '' } : null;
        return line ? [{ ...line, seq, id: (logSeq.current += 1) }] : [];
      }).slice(-400);
      setBuildLogs((previous) => [...restored.filter((line) => !previous.some((current) => current.seq === line.seq)), ...previous].slice(-400));
    }).catch(() => undefined);
    return () => { disposed = true; };
  }, [trackedBuildId]);

  useEffect(() => { if (!active) setSidebar(null); }, [active]);
  useEffect(() => {
    if (sidebar !== 'progress' || build) return;
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

  const openBuild = (tab: KbChangeTab) => {
    setChangeTab(tab);
    setSidebar('build');
  };

  const sidebarItems = [
    { id: 'sources' as const, label: '来源', name: '来源与文档信息', icon: Link2 },
    { id: 'publish' as const, label: '发布', name: '发布到飞书', icon: CloudUpload },
    { id: 'build' as const, label: '构建', name: '构建标准库', icon: Hammer },
    { id: 'progress' as const, label: '进度', name: '构建进度', icon: Activity },
    { id: 'governance' as const, label: '治理', name: '人工复核与业务决定', icon: ShieldCheck },
  ];

  const docPublication = doc ? publicationsByPath.get(doc.path) ?? null : null;
  const publishConflictCount = publications.filter((row) => row.state === 'conflict' || row.state === 'unknown').length;

  return (
    <div className="relative flex h-full min-h-0 min-w-0 gap-2" data-view="knowledge">
      {directoryOpen ? <aside className="absolute left-0 inset-y-0 z-20 md:static shrink-0 h-full min-h-0 rounded-md border border-line bg-card-bg shadow-lg md:shadow-sm flex flex-col overflow-hidden"
        style={{ width: 'min(256px, calc(100vw - 104px))' }} aria-label="标准库目录" data-testid="kb-directory-panel">
        <header className="shrink-0 h-11 px-3 border-b border-line/60 flex items-center justify-between">
          <h3 className="text-sm font-kai text-ink">目录与搜索</h3>
          <button type="button" onClick={() => setDirectoryOpen(false)} aria-label="收起目录" title="收起目录" className="p-1 text-ink-faint hover:text-ink"><ChevronLeft className="w-4 h-4" /></button>
        </header>
        {tree ? <KbTreePanel nodes={tree.nodes} selectedDocId={selectedDocId} onSelectDoc={setSelectedDocId}
          releaseId={tree.releaseId} publicationsByPath={publicationsByPath} />
          : <p className="p-4 text-xs text-ink-faint">发布后在此浏览目录和搜索。</p>}
      </aside> : <div className="shrink-0 w-9 rounded-md border border-line bg-card-bg shadow-sm flex justify-center pt-2">
        <button type="button" onClick={() => setDirectoryOpen(true)} aria-label="打开目录" title="打开目录" className="self-start p-2 rounded text-ink-faint hover:bg-paper hover:text-ink"><ListTree className="w-4 h-4" /></button>
      </div>}
      <article className="flex-1 min-w-0 min-h-0 rounded-md border border-line bg-card-bg shadow-sm flex flex-col overflow-hidden"
        aria-label="标准知识库正文" data-testid="kb-reader-panel">
        <header className="shrink-0 min-h-[44px] px-5 py-2 border-b border-line/60 flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-seal shrink-0" />
          <h2 className="text-sm font-kai text-ink truncate flex-1">{doc?.title ?? '标准知识库'}</h2>
          {doc ? <KbReadingControls preferences={preferences} onChange={updatePreferences} storageUnavailable={storageUnavailable} active={active} /> : null}
          {running ? <button type="button" onClick={() => setSidebar('progress')} className="shrink-0 flex items-center gap-1 text-xs text-seal">
            <Loader2 className="w-3 h-3 animate-spin" /> 更新中
          </button> : pendingTotal > 0 ? <button type="button" onClick={() => openBuild('pending')} className="shrink-0 text-xs text-seal">{pendingTotal} 处待更新</button> : null}
        </header>
        {doc?.sources.some((source) => source.state === 'deleted') ? <div role="status" className="shrink-0 px-5 py-2 border-b border-seal-2/20 bg-seal-2/5 text-xs text-seal-2 flex flex-wrap items-center gap-2">
          <span>本文引用的原始文档已删除，当前内容可能过时。</span>
          <button type="button" className="underline" onClick={() => openBuild('pending')}>查看差异并更新构建</button>
        </div> : null}
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
              action={<Button size="sm" onClick={() => openBuild('sources')}>选择源文档</Button>} />
          : docLoading || treeLoading ? <div className="p-8 animate-pulse space-y-4" aria-busy="true">
            {Array.from({ length: 10 }).map((_, i) => <div key={i} className="h-3 bg-paper-2 rounded" />)}
          </div> : docError ? <EmptyCard icon={<AlertCircle className="w-8 h-8 text-seal-2" />} title="文档加载失败" description={docError}
            action={<Button size="sm" variant="secondary" onClick={() => { void refreshPublished().then(() => setDocReload((n) => n + 1)); }}>重试</Button>} />
          : doc ? <div className="flex-1 min-h-0 overflow-auto scrollbar-thin" data-testid="kb-reading-body">
            <div className="kb-reading-page" style={{ '--kb-font-size': `${preferences.fontSize}px`, '--kb-line-height': preferences.lineHeight } as CSSProperties}>
              <MarkdownView variant="reading" content={doc.markdown} baseDir={doc.path.split('/').slice(0, -1).join('/')} remoteImages="confirm" />
            </div>
          </div> : <EmptyCard icon={<BookOpen className="w-8 h-8 text-ink-faint" />} title="选择文档开始阅读"
            description="通过左侧目录和搜索选择文档。"
            action={!directoryOpen ? <Button size="sm" variant="secondary" onClick={() => setDirectoryOpen(true)}>打开目录</Button> : undefined} />}
      </article>

      {sidebar ? <aside className="absolute right-14 inset-y-0 z-30 xl:static shrink-0 h-full min-h-0 rounded-md border border-line bg-card-bg shadow-lg xl:shadow-sm flex flex-col overflow-hidden"
        style={{ width: sidebar === 'build' ? 'min(440px, calc(100vw - 104px))' : 'min(320px, calc(100vw - 104px))' }} aria-label="标准库侧栏" data-testid="kb-sidebar">
        <header className="shrink-0 h-11 px-3 border-b border-line/60 flex items-center justify-between">
          <h3 className="text-sm font-kai text-ink">{sidebarItems.find((item) => item.id === sidebar)?.name}</h3>
          <button type="button" onClick={() => setSidebar(null)} aria-label="收起标准库侧栏" title="收起侧栏" className="p-1 text-ink-faint hover:text-ink"><ChevronRight className="w-4 h-4" /></button>
        </header>
        {sidebar === 'sources' ? doc ? <div className="flex-1 min-h-0 overflow-auto scrollbar-thin">
            <div className="px-4 py-3 space-y-2 border-b border-line/60 text-xs text-ink-soft">
              {doc.summary ? <p className="leading-relaxed">{doc.summary}</p> : null}
              <p className="text-ink-faint break-all">{doc.path}</p>
              {doc.tags.length ? <p className="text-jade">{doc.tags.join(' · ')}</p> : null}
              <p className="font-mono text-[10px] break-all text-ink-faint">{doc.releaseId}</p>
              <div className="flex items-center gap-2 pt-1" data-testid="kb-doc-publish-state">
                <span className="text-ink-faint">飞书发布</span>
                {docPublication ? <KbPublishStateBadge state={docPublication.state} showAllStates cloudUrl={docPublication.cloudUrl} /> : <span className="text-ink-faint">未发布</span>}
              </div>
            </div>
            <div className="min-h-[200px]"><KbSourcePanel docTitle={doc.title} sources={doc.sources} onOpenSource={setSource} /></div>
          </div> : <p className="p-4 text-xs text-ink-faint">选择文档后查看来源与文档信息。</p>
          : sidebar === 'progress' ? build ? <KbBuildPanel open build={build} issues={buildIssues} logs={buildLogs}
            onCollapse={() => setSidebar(null)} onCancel={cancelBuild} cancelling={cancelling} layout="sidebar"
            onResume={() => setResumeConfirm(true)} onRestart={() => openBuild('sources')} resuming={resuming}
            onBuildUpdated={setBuild} />
            : <p className="p-4 text-xs text-ink-faint">尚无构建记录。可在构建侧栏选择文档并发起构建。</p>
          : sidebar === 'governance' ? <KbGovernancePanel />
          : sidebar === 'publish' ? <KbPublishPanel
            publications={publications}
            loading={publicationsLoading}
            docCount={tree ? flattenDocPaths(tree.nodes).length : 0}
            onOpenPublish={() => setPublishModal({ open: true, tab: 'publish' })}
            onOpenHistory={() => setPublishModal({ open: true, tab: 'history' })}
            onRefresh={() => void loadPublications()} />
          : <>
            {!agentReady ? <div className="shrink-0 px-4 py-2 border-b border-line/60 text-xs text-ink-soft space-y-1">
              {agent.loading ? <StatusBadge status="loading">检测中</StatusBadge> : <StatusBadge status="warning">{readiness?.reason ?? 'Agent 未就绪'}</StatusBadge>}
              {readiness?.action ? <p className="leading-relaxed">{readiness.action}</p> : null}
              <div className="flex gap-3">
                <button type="button" className="text-seal underline" onClick={() => void agent.recheck()}>重新检测</button>
                {onJumpToSettings ? <button type="button" className="text-seal underline" onClick={onJumpToSettings}>前往设置</button> : null}
              </div>
            </div> : null}
            <KbChangesPanel tab={changeTab} onTab={setChangeTab} releaseId={kbStatus?.current?.releaseId}
              running={running} canUpdate={agentReady && !starting}
              onChanged={() => { void loadStatus(); setDocReload((n) => n + 1); }}
              onUpdate={() => setConfirming('incremental')}
              onBuildSelected={(count) => { setSelectedBuildCount(count); setRefreshImages(false); setConfirming('selected'); }}
              onOpenSource={(choice) => setSource({ objToken: choice.objToken, title: choice.title, relPath: choice.relPath, state: choice.excluded ? 'excluded' : 'current' })} />
          </>}
      </aside> : null}

      <nav className="shrink-0 w-12 rounded-md border border-line bg-card-bg shadow-sm flex flex-col items-center gap-1 py-2" aria-label="标准库工具">
        {sidebarItems.map(({ id, label, name, icon: Icon }) => <button key={id} type="button" data-sidebar-trigger={id}
          onClick={() => setSidebar((value) => value === id ? null : id)} aria-label={`${sidebar === id ? '收起' : '打开'}${name}`}
          aria-expanded={sidebar === id} title={name}
          className={`relative w-10 min-h-[44px] flex flex-col items-center justify-center gap-1 rounded text-[10px] transition-colors ${sidebar === id ? 'bg-seal/10 text-seal' : 'text-ink-faint hover:bg-paper hover:text-ink'}`}>
          {id === 'progress' && running ? <Loader2 className="w-4 h-4 animate-spin text-seal" /> : <Icon className="w-4 h-4" />}<span>{label}</span>
          {id === 'build' && pendingTotal > 0 ? <span className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-seal" /> : null}
          {id === 'publish' && publishConflictCount > 0 ? <span className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-seal-2" aria-label={`${publishConflictCount} 篇文档发布异常`} /> : null}
        </button>)}
      </nav>

      <RawSourceDrawer source={source} onClose={() => setSource(null)} />

      {/* 反向发布弹窗（P1-S9）：发布流四步 + 发布历史 */}
      <KbPublishModal
        open={publishModal.open}
        initialTab={publishModal.tab}
        onClose={() => setPublishModal((value) => ({ ...value, open: false }))}
        nodes={tree?.nodes ?? []}
        publications={publications}
        publicationsLoading={publicationsLoading}
        onPublicationsChanged={() => void loadPublications()}
        onJumpToSettings={onJumpToPublishSettings}
      />

      <Modal open={resumeConfirm} title="确认从断点继续" onClose={() => { if (!resuming) setResumeConfirm(false); }}>
        <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
          <p>已保存 {build?.recovery?.draftCount ?? 0} 篇草稿，完成 {build?.recovery?.completedBatches ?? 0}/{build?.recovery?.totalBatches ?? 0} 批。</p>
          <p>将跳过已完成批次，保留已写入的完整草稿，继续未完成内容，并复用已完成的图片转化结果。</p>
          <p className="text-xs text-ink-faint">使用当前配置的构建模型继续并消耗模型额度。源文档或标准库版本已变化时需重新构建；失败不会改变当前发布版本。</p>
          <ConfirmActions confirmLabel="继续构建" busy={resuming} onConfirm={continueBuild} onCancel={() => setResumeConfirm(false)} />
        </div>
      </Modal>

      {/* 构建确认弹窗 */}
      <Modal
        open={confirming !== null}
        title={confirming === 'selected' ? '确认构建所选文档' : '确认按变更更新'}
        onClose={() => { setConfirming(null); setRefreshImages(false); }}
      >
        {confirming === 'selected' ? (
          <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
            <p>
              将构建当前已选的 <b className="text-ink">{selectedBuildCount} 篇源文档</b>。
              {kbStatus?.current ? `在现有 ${kbStatus.current.docCount} 篇标准文档的基础上继续构建，合并更新相关内容，保留未受影响的文档。` : '本次将创建标准知识库。'}
              构建会消耗已配置模型的额度。
            </p>
            {kbStatus?.current && pending && (pending.changed > 0 || pending.removed > 0) ? <p className="text-xs text-ink-faint">已有来源的待更新内容也会一并处理。</p> : null}
            <p className="text-xs text-ink-faint">
              发布前旧版本保持可用；任何失败都不会改变当前已发布的版本。
            </p>
            <label className="flex items-start gap-2 rounded-md border border-line px-3 py-2 cursor-pointer">
              <input type="checkbox" className="mt-1 accent-[#9e2b25]" checked={refreshImages} disabled={starting}
                onChange={(event) => setRefreshImages(event.target.checked)} />
              <span>
                <span className="block text-ink">重新生成本次处理文档的图片描述</span>
                <span className="block mt-1 text-xs text-ink-faint">会重新调用识图模型并计入识图上限；相同图片共用缓存，失败时保留原有缓存。</span>
              </span>
            </label>
            <ConfirmActions
              confirmLabel="开始构建"
              busy={starting}
              onConfirm={() => startBuild('selected', refreshImages)}
              onCancel={() => { setConfirming(null); setRefreshImages(false); }}
            />
          </div>
        ) : (
          <div className="space-y-3 text-sm text-ink-soft leading-relaxed">
            <p>比较当前参与构建的原始源与上次发布快照，只更新受影响的标准文档：</p>
            <button type="button" className="text-xs text-seal underline" onClick={() => { setConfirming(null); openBuild('pending'); }}>查看源文档差异与影响范围</button>
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
