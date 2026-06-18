/**
 * Dashboard - 总览主区（T2/T12，04 §4.1）
 *
 * 结构：
 *   - 顶部 GlobalStatusBar（认证/上次/下次/立即检测/刷新索引）
 *   - 左 240px：NodeTreeView（节点树）
 *   - 右 flex：RecentChanges + NodeDetailCard（点击联动）
 *
 * GlobalStatusBar 内部已处理 B4 修复（立即检测取 watchedRootUrls[0]）。
 */

import { useEffect, useMemo, useState } from 'react';
import { GlobalStatusBar } from '../components/GlobalStatusBar';
import { NodeTreeView } from '../components/NodeTreeView';
import { RecentChanges } from '../components/RecentChanges';
import { NodeDetailCard } from '../components/NodeDetailCard';
import { useConfig } from '../hooks/useConfig';
import { useToast } from '../components/common/Toast';
import { getMappingTree, getMappingDiff } from '../api/client';
import { appLogger } from '../utils/appLogger';
import { pickFirstValidWikiUrl } from '../utils/wikiUrl';
import type { MappingNode, ChangedDocument, DiffReport } from '../types';

interface DashboardProps {
  onJumpToSync: () => void;
}

export function Dashboard({ onJumpToSync }: DashboardProps) {
  const { config } = useConfig();
  const [nodes, setNodes] = useState<MappingNode[]>([]);
  const [changes, setChanges] = useState<ChangedDocument[]>([]);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const toast = useToast();

  // Load tree + diff once root URL is ready.
  const rootUrl = pickFirstValidWikiUrl(config?.watchedRootUrls);
  useEffect(() => {
    let cancelled = false;
    if (!rootUrl) return;
    (async () => {
      try {
        const tree = await getMappingTree();
        if (cancelled) return;
        setNodes(tree);
      } catch (err) {
        appLogger.error('dashboard', 'getMappingTree failed', err);
      }
      try {
        const diff: DiffReport = await getMappingDiff(rootUrl);
        if (cancelled) return;
        setChanges([...diff.added, ...diff.modified, ...diff.deleted]);
      } catch (err) {
        // diff may legitimately 400 if rootUrl is invalid; log + soft warning.
        appLogger.warn('dashboard', 'getMappingDiff failed (non-fatal)', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rootUrl]);

  const selectedNode = useMemo(
    () => nodes.find((n) => n.obj_token === selectedToken) ?? null,
    [nodes, selectedToken],
  );

  // Best-effort business marks: parse from title using (X) pattern at end.
  const businessMarksByToken = useMemo(() => {
    const map: Record<string, string[]> = {};
    const re = /(?:[（(]([TDRTDRTDR]+)[）)])\s*$/;
    for (const n of nodes) {
      const m = n.title.match(re);
      if (m) {
        map[n.obj_token] = m[1].toUpperCase().split('');
      }
    }
    return map;
  }, [nodes]);

  return (
    <div className="space-y-3">
      <GlobalStatusBar />

      <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-3">
        {/* Left: node tree */}
        <div className="lg:h-[calc(100vh-180px)] min-h-[320px]">
          <NodeTreeView
            nodes={nodes}
            selectedToken={selectedToken}
            onSelect={setSelectedToken}
            businessMarksByToken={businessMarksByToken}
            className="h-full"
          />
        </div>

        {/* Right: recent + detail */}
        <div className="space-y-3">
          <RecentChanges changes={changes} onJumpToSync={onJumpToSync} />
          <NodeDetailCard
            node={selectedNode}
            businessMarks={selectedNode ? businessMarksByToken[selectedNode.obj_token] : undefined}
            onSyncNode={() => {
              toast.push({
                type: 'info',
                message: '请前往「贰 同步」主区同步该节点',
              });
              onJumpToSync();
            }}
            onOpenFolder={() => {
              if (typeof window !== 'undefined' && window.desktop) {
                window.desktop.openDataDirectory().catch((err) => {
                  appLogger.error('dashboard', 'openDataDirectory failed', err);
                });
              }
            }}
          />
        </div>
      </div>
    </div>
  );
}
