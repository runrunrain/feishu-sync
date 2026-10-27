import type { KbSourceTreeNode } from '../types/kb-version';
export function subtreeTokens(nodes: KbSourceTreeNode[]): string[] {
  const tokens = new Set<string>(); const stack = [...nodes];
  while (stack.length) { const node = stack.pop()!; if (node.source) tokens.add(node.source.objToken); stack.push(...node.children); }
  return [...tokens];
}
export function sourceTreeRows(nodes: KbSourceTreeNode[], query: string, collapsed: Set<string>, selected?: Set<string>) {
  const all: { node: KbSourceTreeNode; depth: number; parent?: string; matches: boolean }[] = [];
  const q = query.trim().toLowerCase();
  const stack = nodes.slice().reverse().map((node) => ({ node, depth: 0, parent: undefined as string | undefined, inherited: false }));
  while (stack.length) {
    const item = stack.pop()!; const { node, depth, parent } = item;
    const matches = item.inherited || !q || `${node.title} ${node.source?.relPath ?? ''} ${node.source?.objToken ?? ''}`.toLowerCase().includes(q);
    all.push({ node, depth, parent, matches });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], depth: depth + 1, parent: node.id, inherited: matches });
  }
  const kept = new Set<string>(); const stats = new Map<string, { total: number; included: number }>(); const targets: string[] = [];
  for (const row of all) if (row.matches && row.node.source) targets.push(row.node.source.objToken);
  for (let i = all.length - 1; i >= 0; i--) {
    const { node, parent, matches } = all[i];
    if (matches) kept.add(node.id); if (kept.has(node.id) && parent) kept.add(parent);
    const count = stats.get(node.id) ?? { total: 0, included: 0 };
    if (node.source) { count.total++; if (selected ? selected.has(node.source.objToken) : node.source.included) count.included++; }
    stats.set(node.id, count);
    if (parent) { const up = stats.get(parent) ?? { total: 0, included: 0 }; up.total += count.total; up.included += count.included; stats.set(parent, up); }
  }
  let hiddenDepth = Infinity;
  const rows = all.filter((row) => {
    if (row.depth <= hiddenDepth) hiddenDepth = Infinity;
    if (!kept.has(row.node.id) || row.depth > hiddenDepth) return false;
    if (!q && collapsed.has(row.node.id)) hiddenDepth = row.depth;
    return true;
  });
  return { rows, stats, targets, all };
}
