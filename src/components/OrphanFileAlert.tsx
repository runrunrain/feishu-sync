/**
 * OrphanFileAlert - 孤儿文件提醒（T11，04 §4.1 / §7.2 #7）
 *
 * 数据源：`_index.json.orphan_files`，通过父组件（Dashboard）拉取
 * GET /api/mapping/index 后注入。仅当 orphans.length > 0 时渲染。
 *
 * 视觉：warning 色（seal），可展开查看完整列表（路径 + reason）。
 * 与节点树的"仅孤儿"过滤器独立——节点树通常不含孤儿（孤儿无
 * obj_token，被 /api/mapping/tree 排除），此卡片是孤儿 UI 的主入口。
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';
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
            发现 {orphans.length} 个未映射文件
          </span>
          <span className="text-xs text-ink-faint flex-1 truncate">
            这些文件未在飞书知识库中找到对应节点
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
                <p className="font-mono text-ink-soft break-all">{o.path}</p>
                {o.reason && (
                  <p className="text-ink-faint mt-1">原因：{o.reason}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
