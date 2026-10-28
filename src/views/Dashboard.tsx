/**
 * Dashboard - 总览主区（T2/T11/T12，04 §4.1）
 *
 * 结构：
 *   - 顶部 GlobalStatusBar（认证/上次/下次/立即检测/刷新索引）
 *   - 左 ~320px：NodeTreeView（固定飞书视图，支持拖拽调整 280-560px）
 *   - 中 flex：DocPreviewPanel（本地文档内容预览 Markdown/CSV）
 *   - 右 320-340px：可收起详情栏（OrphanFileAlert + NodeDetailCard + RecentChanges）
 *
 * 视图与同步：
 *   - 固定飞书视图：GET /api/mapping/tree?view=feishu → watchedRoots 分组 + filter
 *   - NodeDetailCard.allNodes 传入完整 nodes 数组以解析父节点/子节点
 *
 * P1-1 修复：孤儿数据从 _index.json.orphan_files 拉取，同时驱动：
 *   (a) OrphanFileAlert（T11，主孤儿 UI 入口）
 *   (b) NodeTreeView.orphanPaths（节点树"仅孤儿"过滤器，不再用 local_path 字符串匹配）
 *
 * GlobalStatusBar 内部已处理 B4 修复（立即检测取 watchedRootUrls[0]）。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { SourceBatchDialog } from '../components/SourceBatchDialog';
import { Modal } from '../components/common/Modal';
import { Button } from '../components/common/Button';
import { GlobalStatusBar } from '../components/GlobalStatusBar';
import { VersionUpdateAlert } from '../components/VersionUpdateAlert';
import { NodeTreeView } from '../components/NodeTreeView';
import { RecentChanges } from '../components/RecentChanges';
import { NodeDetailCard } from '../components/NodeDetailCard';
import { DocPreviewPanel } from '../components/DocPreviewPanel';
import { ColumnResizer } from '../components/ColumnResizer';
import { OrphanFileAlert } from '../components/OrphanFileAlert';
import { QuickAddDocDialog } from '../components/QuickAddDocDialog';
import { MoveOutModal } from '../components/move-out/MoveOutModal';
import { useConfig } from '../hooks/useConfig';
import { useToast } from '../components/common/Toast';
import {
  getStoredMappingDiff,
  getMappingIndex,
  getMappingTreeDetailed,
  listCustomFolders,
  listCloudMoves,
  manualDeleteDoc,
  previewSourceBatch,
} from '../api/client';
import { appLogger } from '../utils/appLogger';
import { onDiffChanged } from '../utils/syncEvents';
import { isUsableWikiUrl, pickFirstValidWikiUrl } from '../utils/wikiUrl';
import type {
  CloudMoveRecord,
  MappingNode,
  ChangedDocument,
  CustomFolder,
  DiffReport,
  OrphanFile,
  TreeResponse,
  TreeNavTarget,
  WatchedRoot,
} from '../types';

interface DashboardProps {
  onJumpToSync: () => void;
  onJumpToSettings?: (tab?: 'application') => void;
}

// v0.2.9 布局偏好：左栏拖拽宽度 / 右栏收起状态，localStorage 持久化。
// 需求 1：左侧树默认宽度加宽为 320px。
const DEFAULT_LEFT_WIDTH = 320;
const LEFT_WIDTH_KEY = 'feishu.layout.leftWidth';
const RIGHT_COLLAPSED_KEY = 'feishu.layout.rightCollapsed';

function readLeftWidth(): number {
  try {
    const raw = localStorage.getItem(LEFT_WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 280 && value <= 560
      ? value
      : DEFAULT_LEFT_WIDTH;
  } catch {
    return DEFAULT_LEFT_WIDTH;
  }
}

export function Dashboard({ onJumpToSync, onJumpToSettings }: DashboardProps) {
  const { config } = useConfig();
  // 始终固定飞书视图（移除本地视图切换）
  const [feishuEnv, setFeishuEnv] = useState<TreeResponse | null>(null);
  const [changes, setChanges] = useState<ChangedDocument[]>([]);
  const [orphans, setOrphans] = useState<OrphanFile[]>([]);
  const [snapshot, setSnapshot] = useState<
    | (Pick<TreeResponse, 'orphan_files'> & {
        watched_roots?: WatchedRoot[];
      })
    | null
  >(null);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  // 自定义归档文件夹（GET /api/custom-folders）；快捷添加对话框的显隐。
  const [customFolders, setCustomFolders] = useState<CustomFolder[]>([]);
  const [customFoldersLoading, setCustomFoldersLoading] = useState(true);
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  // 跳转导航请求（快捷添加/归档管理的「跳转查看」）：nonce 变化触发 NodeTreeView 定位。
  const [focusRequest, setFocusRequest] = useState<
    (TreeNavTarget & { nonce: number }) | null
  >(null);
  const navigateTree = (target: TreeNavTarget) => {
    setFocusRequest({ ...target, nonce: Date.now() });
  };
  const toast = useToast();

  // v0.2.9 布局偏好：左栏可拖拽宽度 + 右栏可收起（localStorage 持久化）。
  const [leftWidth, setLeftWidth] = useState<number>(readLeftWidth);
  const [rightCollapsed, setRightCollapsed] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(RIGHT_COLLAPSED_KEY);
      // 默认收起（2026-08 需求）：未表达过偏好时收起右栏，把空间让给预览主区；
      // 一旦用户手动展开/收起，仍以 localStorage 偏好为准。
      return raw === null ? true : raw === '1';
    } catch {
      return true;
    }
  });

  // 右栏展开时左/中栏等比例压缩（2026-08 需求）：左栏保持其在「右栏之外
  // 可用宽度」中的占比，而不是右栏宽度全由中部 flex-1 独自吸收。
  // 以行容器实测宽度换算；仅 lg+ 横向布局生效。
  const rowRef = useRef<HTMLDivElement>(null);
  const [rowWidth, setRowWidth] = useState(0);
  useEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      setRowWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // 右栏展开宽度与 xl 断点联动（lg:w-[320px] xl:w-[340px]），用 matchMedia 保持一致。
  const [isXl, setIsXl] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1280px)').matches
      : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const onChange = () => setIsXl(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // 布局常量与下方 JSX 类名保持一致：resizer w-3(12) + 中部 ml-1(4) + 右栏 ml-4(16)。
  const RESIZER_AND_GAP = 16;
  const RIGHT_MARGIN = 16;
  const RIGHT_STRIP_W = 36; // 收起态竖条 w-9
  const rightOpenW = isXl ? 340 : 320;
  let effectiveLeftWidth = leftWidth;
  if (!rightCollapsed && rowWidth >= 1024) {
    const closedAvail = rowWidth - RIGHT_STRIP_W - RIGHT_MARGIN - RESIZER_AND_GAP;
    const openAvail = rowWidth - rightOpenW - RIGHT_MARGIN - RESIZER_AND_GAP;
    if (closedAvail > 0 && openAvail > 0) {
      effectiveLeftWidth = Math.max(
        280,
        Math.min(560, Math.round((leftWidth / closedAvail) * openAvail)),
      );
    }
  }

  useEffect(() => {
    try {
      localStorage.setItem(LEFT_WIDTH_KEY, String(leftWidth));
    } catch {
      /* localStorage 不可用时静默降级 */
    }
  }, [leftWidth]);

  useEffect(() => {
    try {
      localStorage.setItem(RIGHT_COLLAPSED_KEY, rightCollapsed ? '1' : '0');
    } catch {
      /* 同上 */
    }
  }, [rightCollapsed]);

  // Load diff + snapshot once root URL is ready.
  const rootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);

  const loadFeishu = useCallback(async () => {
    try {
      const env = await getMappingTreeDetailed('feishu', { includeOrphans: false });
      setFeishuEnv(env);
    } catch (err) {
      appLogger.error('dashboard', 'getMappingTreeDetailed(feishu) failed', err);
      toast.push({
        type: 'error',
        message: '飞书视图加载失败',
        hint: err instanceof Error ? err.message : '',
      });
    }
  }, [toast]);

  const [batchTarget, setBatchTarget] = useState<{ tokens: string[]; action: 'delete' | 'block' } | null>(null);
  const [selectionVersion, setSelectionVersion] = useState(0);
  // P2-S7 移出到云空间：目标文档（右键菜单入口）+ 移出记录（展示层 join）。
  const [moveOutTarget, setMoveOutTarget] = useState<{ objToken: string; title: string } | null>(null);
  const [cloudMoves, setCloudMoves] = useState<CloudMoveRecord[]>([]);
  const loadCloudMoves = useCallback(async () => {
    try {
      const { moves } = await listCloudMoves({ limit: 200 });
      setCloudMoves(moves);
    } catch (err) {
      // 旧 server（P2-S6 前）混跑兼容：端点 404 不阻断总览，只记日志。
      appLogger.warn('dashboard', 'listCloudMoves failed', err);
    }
  }, []);
  useEffect(() => { void loadCloudMoves(); }, [loadCloudMoves]);
  /** objToken → 最新一条移出记录（树徽标覆盖源，U48 展示层 join）。 */
  const latestMoveByToken = useMemo(() => {
    const map = new Map<string, CloudMoveRecord>();
    for (let i = cloudMoves.length - 1; i >= 0; i -= 1) {
      map.set(cloudMoves[i].objToken, cloudMoves[i]);
    }
    return map;
  }, [cloudMoves]);
  /** objToken → 该文档全部移出记录（详情卡列表，最新在前）。 */
  const movesByToken = useMemo(() => {
    const map = new Map<string, CloudMoveRecord[]>();
    for (const move of cloudMoves) {
      const arr = map.get(move.objToken) ?? [];
      arr.push(move);
      map.set(move.objToken, arr);
    }
    return map;
  }, [cloudMoves]);
  const [deleteTarget, setDeleteTarget] = useState<{ objToken: string; title: string } | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(true); const [blockDeleted, setBlockDeleted] = useState(false);
  const [deleting, setDeleting] = useState(false); const [deleteError, setDeleteError] = useState('');
  /** P1-S4：删除确认的引用悬空风险（预览接口返回；null=未加载/无风险）。 */
  const [deleteRefRisk, setDeleteRefRisk] = useState<{ title: string; count: number; sources: string[] } | null>(null);
  const handleManualDeleteDoc = useCallback((doc: { objToken: string; title: string }) => {
    setDeleteTarget(doc); setDeleteFiles(true); setBlockDeleted(false); setDeleteError(''); setDeleteRefRisk(null);
  }, []);
  const confirmDeleteDoc = async () => {
    if (!deleteTarget || deleting) return;
    setDeleting(true); setDeleteError('');
    try {
      const result = await manualDeleteDoc(deleteTarget.objToken, { deleteFiles, block: blockDeleted });
      toast.push({ type: 'success', message: result.blocked ? `已删除并屏蔽「${deleteTarget.title}」` : result.pending_sync ? `「${deleteTarget.title}」已转为待同步` : `已删除「${deleteTarget.title}」`, hint: result.trash_dir ? `本地文件已回收至 ${result.trash_dir}` : undefined });
      setSelectedToken((prev) => prev === deleteTarget.objToken ? null : prev); setDeleteTarget(null); await loadFeishu();
    } catch (err) { setDeleteError(err instanceof Error ? err.message : '删除失败'); }
    finally { setDeleting(false); }
  };

  // P1-S4：删除确认前拉取引用悬空风险（复用源批量预览 API 的单文档形态；
  // 拉取失败不阻断删除——风险提示是增强信息，不是删除门槛）。
  useEffect(() => {
    if (!deleteTarget || !config?.knowledgeBaseRoot) { setDeleteRefRisk(null); return; }
    let cancelled = false;
    previewSourceBatch({ root: config.knowledgeBaseRoot, tokens: [deleteTarget.objToken], action: 'delete', includeDescendants: false, deleteFiles: true, block: false })
      .then((preview) => {
        if (cancelled) return;
        const risk = preview.referenceLossRisk?.[0];
        setDeleteRefRisk(risk ? { title: risk.title, count: risk.referencedByCount, sources: risk.sources.map((source) => source.title ?? source.objToken) } : null);
      })
      .catch(() => { if (!cancelled) setDeleteRefRisk(null); });
    return () => { cancelled = true; };
  }, [deleteTarget, config?.knowledgeBaseRoot]);

  // Load feishu view by default.
  useEffect(() => {
    if (!rootUrl) return;
    void loadFeishu();
  }, [rootUrl, loadFeishu]);

  // 自定义归档文件夹列表：挂载即加载（与 watchedRoot 配置无关，
  // 归档文档 watched_root_url 为 NULL，天然不在结构检测范围内）。
  const loadCustomFolders = useCallback(async () => {
    setCustomFoldersLoading(true);
    try {
      const folders = await listCustomFolders();
      setCustomFolders(folders);
    } catch (err) {
      // 首次配置前 knowledgeBaseRoot 为空是正常前置态，静默降级为空列表
      // （2026-10 修复：此前 error toast 固定右下角，存活期内遮挡设置页
      // 右下角的「保存设置」按钮，用户首次填本地根目录时无法保存）。
      // 服务端已同步改为未配置返回空列表，这里兼底旧 server 混跑。
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('knowledge_base_root_not_configured')) {
        appLogger.info('dashboard', 'custom folders skipped: knowledge base root not configured');
        setCustomFolders([]);
        return;
      }
      appLogger.error('dashboard', 'listCustomFolders failed', err);
      toast.push({
        type: 'error',
        message: '自定义归档加载失败',
        hint: msg,
      });
    } finally {
      setCustomFoldersLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void loadCustomFolders();
  }, [loadCustomFolders]);

  // diff + snapshot always loaded (shared across views).
  // 跨视图实时刷新（2026-06 修复）：抽出为可重入 loader，除挂载时外，
  // 还在全局 diff-changed 事件（同步/检测/回收站等写路径完成）时重拉，
  // 让总览的「最近变更」与待同步状态不再停留在旧快照。
  // 多 root 聚合（2026-11 修复）：此前只拉 pickFirstValidWikiUrl 的
  // 第一个子树，多 watchedRoot 配置下其他子树的变更不出现在「最近
  // 变更」，总览与同步页变更列表内容长期对不齐。与
  // ChangeListPanel.fetchMultiRootDiff / useSyncStatus 同款去重：
  // 归档文档会被服务端合并进每个 root 的 stored diff，朴素 concat
  // 会按 watchedRoot 数重复；单 root 失败降级为跳过（不阻塞其余子树）。
  const loadDiffAndSnapshot = useCallback(async (signal?: { cancelled: boolean }) => {
    const validUrls = (config?.watchedRootUrls ?? []).filter(isUsableWikiUrl);
    if (validUrls.length === 0) return;
    try {
      const seen = new Set<string>();
      const merged: ChangedDocument[] = [];
      for (const url of validUrls) {
        try {
          const diff: DiffReport = await getStoredMappingDiff(url);
          for (const doc of [...diff.added, ...diff.modified, ...diff.deleted]) {
            const key = doc.objToken ?? `${doc.title}:${doc.localMdPath ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            merged.push(doc);
          }
        } catch (err) {
          // diff may legitimately 400 if rootUrl is invalid; log + soft warning.
          appLogger.warn('dashboard', 'getStoredMappingDiff failed (non-fatal)', { url, err });
        }
      }
      if (signal?.cancelled) return;
      setChanges(merged);
    } catch (err) {
      appLogger.warn('dashboard', 'aggregate stored diffs failed (non-fatal)', err);
    }
    try {
      const snap = await getMappingIndex();
      if (signal?.cancelled) return;
      setOrphans(snap?.orphan_files ?? []);
      setSnapshot(snap ?? null);
    } catch (err) {
      // 404 when snapshot not generated yet; soft-log only.
      appLogger.warn('dashboard', 'getMappingIndex failed (non-fatal)', err);
    }
  }, [config]);

  useEffect(() => {
    const signal = { cancelled: false };
    void loadDiffAndSnapshot(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [loadDiffAndSnapshot]);

  useEffect(() => {
    return onDiffChanged(() => {
      void loadFeishu();
      void loadDiffAndSnapshot();
    });
  }, [loadFeishu, loadDiffAndSnapshot]);

  // The active node list (feishu view only).
  const activeNodes: MappingNode[] = useMemo(() => {
    return feishuEnv?.nodes ?? [];
  }, [feishuEnv]);

  const watchedRoots: WatchedRoot[] = useMemo(
    () => feishuEnv?.watched_roots ?? snapshot?.watched_roots ?? [],
    [feishuEnv, snapshot],
  );

  // 自定义归档文档 → 伪 MappingNode，用于点击归档文档时联动详情卡。
  // 归档文档不在飞书结构树内（watched_root_url 为 NULL），不进 NodeTreeView
  // 的 nodes 数组，仅作详情卡解析用；字段按 documents 表约定填充
  // （sync_state/cloud_match/status 均为 synced）。
  const customDocNodes: MappingNode[] = useMemo(
    () =>
      customFolders.flatMap((f) =>
        f.docs.map((d) => ({
          obj_token: d.objToken,
          wiki_node_token: null,
          space_id: null,
          obj_type: (d.objType as MappingNode['obj_type']) || 'unknown',
          title: d.title,
          local_path: d.localRelPath,
          parent_node_token: null,
          has_child: false,
          obj_edit_time: null,
          last_synced_modify_time: '',
          last_synced_at: '',
          last_seen_at: null,
          status: 'synced' as const,
          cloud_deleted: 0,
          sortOrder: null,
          original_link: d.originalLink,
          cloud_match: 'synced' as const,
          watched_root_url: null,
        })),
      ),
    [customFolders],
  );

  const selectedNode = useMemo(
    () =>
      activeNodes.find((n) => n.obj_token === selectedToken) ??
      customDocNodes.find((n) => n.obj_token === selectedToken) ??
      null,
    [activeNodes, customDocNodes, selectedToken],
  );

  // Build a set of orphan local paths to drive NodeTreeView's "仅孤儿" filter.
  const orphanPaths = useMemo(() => new Set(orphans.map((o) => o.path)), [orphans]);

  // Best-effort business marks: parse from title using (X) pattern at end.
  const businessMarksByToken = useMemo(() => {
    const map: Record<string, string[]> = {};
    const re = /(?:[（(]([TDRTDRTDR]+)[）)])\s*$/;
    for (const n of activeNodes) {
      const m = n.title.match(re);
      if (m) {
        map[n.obj_token] = m[1].toUpperCase().split('');
      }
    }
    return map;
  }, [activeNodes]);

  const handleOpenFolder = async (localPath: string) => {
    // 2026-09 修复：此前误调 openDataDirectory（打开数据目录而非文档所在
    // 目录）。现在把相对 local_path 拼上 knowledgeBaseRoot 得绝对路径，
    // 走 reveal-in-folder（Win 资源管理器 / mac Finder 定位选中）。
    // 二次修复：local_path 存在 legacy 绝对路径形态（snapshot P2-05 前的
    // 旧库），绝对时直接用不再拼前缀；后端返回错误时明确 toast，不再
    // 静默无反馈。
    if (typeof window !== 'undefined' && window.desktop?.revealInFolder) {
      const isAbsolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(localPath);
      const abs = isAbsolute
        ? localPath
        : `${(config?.knowledgeBaseRoot ?? '').replace(/[\\/]+$/, '')}/${localPath.replace(/^[\\/]+/, '')}`;
      if (!isAbsolute && !config?.knowledgeBaseRoot) {
        toast.push({ type: 'warning', message: '本地根目录未配置' });
        return;
      }
      try {
        const res = await window.desktop.revealInFolder(abs);
        if (!res.ok) {
          appLogger.error('dashboard', 'revealInFolder rejected', res);
          toast.push({ type: 'error', message: '打开文件夹失败', hint: res.error });
        }
      } catch (err) {
        appLogger.error('dashboard', 'revealInFolder failed', err);
        toast.push({ type: 'error', message: '打开文件夹失败' });
      }
      return;
    }
    // 非 desktop 环境（浏览器 dev）退化为提示。
    toast.push({ type: 'warning', message: '仅桌面端支持打开本地文件夹' });
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2.5">
      <VersionUpdateAlert onJumpToSettings={onJumpToSettings} />
      <GlobalStatusBar />
      {batchTarget ? <SourceBatchDialog root={config?.knowledgeBaseRoot ?? ''} tokens={batchTarget.tokens} action={batchTarget.action} onClose={() => setBatchTarget(null)} onComplete={(count, processedTokens) => {
        toast.push({ type: 'success', message: `已${batchTarget.action === 'block' ? '屏蔽' : '处理'} ${count} 篇文档` });
        setSelectedToken((old) => old && processedTokens.includes(old) ? null : old);
        setBatchTarget(null); setSelectionVersion((version) => version + 1); void loadFeishu(); void loadCustomFolders();
      }} /> : null}
      <Modal open={deleteTarget !== null} title={`删除文档「${deleteTarget?.title ?? ''}」`} onClose={() => { if (!deleting) setDeleteTarget(null); }} contentClassName="max-w-xl">
        <p className="text-sm text-ink-soft leading-relaxed mb-4">删除当前文档的本地版本，子文档继续保留。所属上级仍受有效同步根管理时，当前文档会立即转为待同步。</p>
        {deleteRefRisk && deleteRefRisk.count > 0 ? (
          <div role="alert" className="mb-4 rounded border border-seal/40 bg-seal/5 px-3 py-2 text-xs leading-relaxed">
            <p className="text-seal font-medium mb-1">引用悬空风险：该文档被 {deleteRefRisk.count} 篇文档引用，删除后这些引用将指向不存在的文档。</p>
            <p className="text-ink-soft">引用方：{deleteRefRisk.sources.slice(0, 5).join('、')}{deleteRefRisk.sources.length > 5 ? ' 等' : ''}</p>
          </div>
        ) : null}
        <label className="flex items-start gap-2 text-sm text-ink mb-3"><input type="checkbox" aria-label="同时删除本地源文件" checked={deleteFiles} disabled={deleting} onChange={(e) => setDeleteFiles(e.target.checked)} />同时删除本地源文件（移入可恢复的回收目录）</label>
        {!deleteFiles ? <p className="text-xs text-ink-faint mb-3">保留磁盘文件，只清除索引基线；重建索引后文件可再次出现。</p> : null}
        <label className="flex items-start gap-2 text-sm text-ink mb-2"><input type="checkbox" aria-label="移入屏蔽名单" checked={blockDeleted} disabled={deleting} onChange={(e) => setBlockDeleted(e.target.checked)} />移入屏蔽名单</label>
        <p className="text-xs text-ink-faint mb-4">屏蔽后不会再进入待同步列表，可在「设置 → 知识库与同步 → 同步屏蔽名单」中多选移出。</p>
        {deleteError ? <p role="alert" className="text-sm text-seal-2 mb-3">{deleteError}</p> : null}
        <div className="flex justify-end gap-3"><Button size="sm" variant="secondary" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</Button><Button size="sm" variant="danger" disabled={deleting} onClick={() => void confirmDeleteDoc()}>{deleting ? '正在删除…' : blockDeleted ? '删除并屏蔽' : '确认删除'}</Button></div>
      </Modal>

      {/*
        三栏布局（总览主区）：
        - 左栏宽度可拖拽调整（ColumnResizer，280-560px，双击复位，localStorage 持久化）；
          通过 CSS 变量 --tree-w 驱动，仅 lg 及以上生效，窄屏仍纵向堆叠
        - 右栏可点击收起为 36px 竖条（PanelRightClose/Open，localStorage 持久化），
          把空间让给中部预览主区域
        - flex-1 min-h-0 吃满视口剩余高度，底部无多余空隙
      */}
      <div ref={rowRef} className="flex min-w-0 flex-1 min-h-0 flex-col gap-3 lg:flex-row lg:gap-0">
        {/* Left: node tree (feishu view only) — width adjustable via resizer；
            右栏展开时按等比例压缩后的 effectiveLeftWidth 渲染 */}
        <div
          className="min-w-0 min-h-[240px] lg:min-h-0 lg:h-full lg:shrink-0 lg:w-[var(--tree-w)]"
          style={{ '--tree-w': `${effectiveLeftWidth}px` } as CSSProperties}
        >
          <NodeTreeView
            nodes={feishuEnv?.nodes}
            selectedToken={selectedToken}
            onSelect={setSelectedToken}
            businessMarksByToken={businessMarksByToken}
            orphanPaths={orphanPaths}
            watchedRoots={watchedRoots}
            customFolders={customFolders}
            onQuickAdd={() => setQuickAddOpen(true)}
            focusRequest={focusRequest}
            onRefreshed={loadFeishu}
            onDeleteDoc={handleManualDeleteDoc}
            onBatchAction={(tokens, action) => setBatchTarget({ tokens, action })}
            onMoveOutDoc={setMoveOutTarget}
            latestMoveByToken={latestMoveByToken}
            selectionVersion={selectionVersion}
            className="h-full"
          />
        </div>

        {/* Divider: drag to adjust left/center width ratio */}
        <ColumnResizer
          width={leftWidth}
          min={280}
          defaultWidth={DEFAULT_LEFT_WIDTH}
          onResize={setLeftWidth}
        />

        {/* Center: document preview (primary content area) */}
        <div className="min-w-0 min-h-[260px] lg:min-h-0 lg:h-full lg:ml-1 flex-1">
          <DocPreviewPanel
            node={selectedNode}
            onOpenFolder={handleOpenFolder}
            className="h-full"
          />
        </div>

        {/* Right: collapsible detail sidebar */}
        {rightCollapsed ? (
          <div className="hidden lg:flex lg:ml-3 lg:w-9 lg:shrink-0 flex-col items-center gap-2 rounded-md border border-line bg-card-bg py-2 shadow-sm">
            <button
              type="button"
              onClick={() => setRightCollapsed(false)}
              title="展开详情栏"
              aria-label="展开详情栏"
              className="rounded-sm p-1.5 text-ink-faint transition-colors hover:bg-paper-2 hover:text-seal"
            >
              <PanelRightOpen className="w-4 h-4" />
            </button>
            <span className="text-[10px] text-ink-faint font-sans-ui [writing-mode:vertical-lr] select-none">
              详情
            </span>
          </div>
        ) : (
          <div className="min-w-0 space-y-3 lg:ml-3 lg:min-h-0 lg:h-full lg:w-[320px] lg:shrink-0 lg:overflow-y-auto lg:scrollbar-thin lg:pr-1 xl:w-[340px] flex flex-col">
            <div className="hidden lg:flex justify-end shrink-0">
              <button
                type="button"
                onClick={() => setRightCollapsed(true)}
                title="收起详情栏"
                aria-label="收起详情栏"
                className="rounded-sm p-1 text-ink-faint transition-colors hover:bg-paper-2 hover:text-seal"
              >
                <PanelRightClose className="w-4 h-4" />
              </button>
            </div>
            <OrphanFileAlert orphans={orphans} />
            <NodeDetailCard
              node={selectedNode}
              businessMarks={selectedNode ? businessMarksByToken[selectedNode.obj_token] : undefined}
              allNodes={activeNodes}
              watchedRoots={watchedRoots}
              onSelectNode={setSelectedToken}
              cloudMoves={selectedNode ? movesByToken.get(selectedNode.obj_token) : undefined}
              onSyncNode={() => {
                toast.push({
                  type: 'info',
                  message: '请前往「贰 同步」主区同步该节点',
                });
                onJumpToSync();
              }}
              onOpenFolder={handleOpenFolder}
            />
            <RecentChanges changes={changes} onJumpToSync={onJumpToSync} className="flex-1 min-h-[180px]" />
          </div>
        )}
      </div>

      <QuickAddDocDialog
        open={quickAddOpen}
        onClose={() => setQuickAddOpen(false)}
        onNavigate={(target) => {
          setQuickAddOpen(false);
          navigateTree(target);
        }}
        folders={customFolders}
        foldersLoading={customFoldersLoading}
        onChanged={() => {
          void loadCustomFolders();
          void loadFeishu();
        }}
      />

      {/* P2-S7 移出到云空间：两段确认弹窗（preview → 确认值门控 → 执行 →
          异步轮询收敛）；收敛后刷新树与移出记录。 */}
      <MoveOutModal
        open={moveOutTarget !== null}
        objToken={moveOutTarget?.objToken ?? null}
        target={moveOutTarget}
        onClose={() => setMoveOutTarget(null)}
        onMoved={() => {
          void loadCloudMoves();
          void loadFeishu();
        }}
      />
    </div>
  );
}
