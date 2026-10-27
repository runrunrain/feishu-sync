import type { MappingNode } from '../types';
export const sameOrderGroup = (a: MappingNode, b: MappingNode) =>
  (a.parent_node_token ?? null) === (b.parent_node_token ?? null) && (a.watched_root_url ?? null) === (b.watched_root_url ?? null);
/** 命中展开子树时归到同级祖先；始终只产生前/后插入，绝不产生inside/reparent。 */
export function siblingDropTarget(dragged: MappingNode, hovered: MappingNode, byWiki: Map<string, MappingNode>): MappingNode | null {
  let candidate: MappingNode | undefined = hovered; const seen = new Set<string>();
  while (candidate && !seen.has(candidate.obj_token)) {
    if (candidate.obj_token === dragged.obj_token) return null;
    if (sameOrderGroup(dragged, candidate)) return candidate;
    seen.add(candidate.obj_token); candidate = byWiki.get(candidate.parent_node_token ?? '');
  }
  return null;
}
/** 中线4px滞回，避免轻微抖动来回切换；插入标记不占据布局空间。 */
export function insertionSide(y: number, rect: { top: number; height: number }, previous?: 'before' | 'after'): 'before' | 'after' {
  const center = rect.top + rect.height / 2; const deadband = Math.min(4, rect.height / 8);
  if (previous === 'before' && y <= center + deadband) return 'before';
  if (previous === 'after' && y >= center - deadband) return 'after';
  return y < center ? 'before' : 'after';
}
export function reorderSiblings(siblings: MappingNode[], dragged: MappingNode, target: MappingNode, side: 'before' | 'after'): string[] | null {
  if (!sameOrderGroup(dragged, target) || dragged.obj_token === target.obj_token) return null;
  const scoped = siblings.filter((node) => sameOrderGroup(dragged, node));
  const next = scoped.filter((node) => node.obj_token !== dragged.obj_token);
  const index = next.findIndex((node) => node.obj_token === target.obj_token);
  if (index < 0 || !scoped.some((node) => node.obj_token === dragged.obj_token)) return null;
  next.splice(index + Number(side === 'after'), 0, dragged);
  const tokens = next.map((node) => node.obj_token);
  return tokens.every((token, i) => token === scoped[i].obj_token) ? null : tokens;
}
