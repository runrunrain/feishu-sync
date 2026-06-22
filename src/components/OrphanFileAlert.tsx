/**
 * OrphanFileAlert - 孤儿文件提醒（T11，04 §4.1 / §7.2 #7）
 *
 * 数据源：`_index.json.orphan_files`，通过父组件（Dashboard）拉取
 * GET /api/mapping/index 后注入。仅当 orphans.length > 0 时渲染。
 *
 * 视觉：warning 色（seal），可展开查看完整列表（路径 + reason）。
 * 与节点树的"仅孤儿"过滤器独立——节点树通常不含孤儿（孤儿无
 * obj_token，被 /api/mapping/tree 排除），此卡片是孤儿 UI 的主入口。
 *
 * v0.2.0 cloud-link-coverage: orphan_files 现在携带 cloud_match='local_only'
 * 标记，UI 明示"本地独有 / 无飞书对应"（而非笼统的"未映射"），
 * 让用户知道这些文件不是损坏的同步产物，而是知识库内本来就只在
 * 本地存在的补充材料（如 INDEX.md / README.md / 手写笔记）。
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, FileQuestion } from 'lucide-react';
import { Card, CardBody } from './common/Card';
import type { OrphanFile } from '../types';

interface OrphanFileAlertProps {
  orphans: OrphanFile[];
}

export function OrphanFileAlert({ orphans }: OrphanFileAlertProps) {
  const [expanded, setExpanded] = useState(false);
  if (orphans.length === 0) return null;

  return (
    <Card variant="default" className="border-seal/30">
      <CardBody>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-2.5 text-left"
          aria-expanded={expanded}
        >
          <AlertTriangle className="w-4 h-4 text-seal shrink-0" />
          <span className="text-sm text-ink font-medium">
            发现 {orphans.length} 个本地独有文件
          </span>
          <span className="text-xs text-ink-faint flex-1 truncate">
            无飞书云文档对应（如 INDEX / README / 手写笔记）
          </span>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-ink-faint" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-ink-faint" />
          )}
        </button>

        {expanded && (
          <ul className="mt-3 space-y-2 border-t border-line pt-3">
            {orphans.map((o, idx) => (
              <li key={`${o.path}-${idx}`} className="text-xs">
                <div className="flex items-start gap-1.5">
                  <FileQuestion className="w-3.5 h-3.5 text-ink-faint shrink-0 mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-ink-soft break-all">{o.path}</p>
                    <p className="text-ink-faint mt-0.5">
                      <span className="inline-flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-ink-faint" />
                        本地独有（cloud_match: local_only）
                      </span>
                      {o.reason && (
                        <span className="ml-2 text-ink-faint/70">· {o.reason}</span>
                      )}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
