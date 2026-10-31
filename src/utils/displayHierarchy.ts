import type { MappingNode } from '../types';

export const displayNodeKey = (node: MappingNode): string => node.wiki_node_token || `local:${node.obj_token}`;

/** Recover a display-only parent when cloud traversal cannot supply one. */
export function recoverDisplayHierarchy(nodes: MappingNode[]): { nodes: MappingNode[]; inferred: Set<string> } {
  const byPath = new Map<string, MappingNode>();
  const normalized = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
  for (const node of nodes) {
    if (node.local_path && node.watched_root_url) {
      byPath.set(`${node.watched_root_url}\0${normalized(node.local_path)}`, node);
    }
  }
  const inferred = new Set<string>();
  const projected = nodes.map((node) => {
    if (node.parent_node_token || !node.local_path || !node.watched_root_url) return node;
    const file = normalized(node.local_path);
    let dir = file.slice(0, file.lastIndexOf('/'));
    while (dir.includes('/')) {
      const name = dir.slice(dir.lastIndexOf('/') + 1);
      const candidates = [`${dir}.md`, `${dir}/${name}.md`, `${dir}/README.md`];
      const parent = candidates.map((candidate) => byPath.get(`${node.watched_root_url}\0${candidate}`))
        .find((candidate) => candidate && candidate.obj_token !== node.obj_token);
      if (parent) {
        inferred.add(node.obj_token);
        return { ...node, parent_node_token: displayNodeKey(parent) };
      }
      dir = dir.slice(0, dir.lastIndexOf('/'));
    }
    return node;
  });
  return { nodes: projected, inferred };
}
