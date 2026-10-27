export interface SelectionNode { obj_token: string; wiki_node_token: string | null; parent_node_token: string | null }
/** 收起/搜索不改变子树范围；去重并容忍脏父链循环。 */
export function createSelectionResolver(nodes: SelectionNode[]) {
  const children = new Map<string, SelectionNode[]>(); const records = new Map(nodes.map((node) => [node.obj_token, node]));
  for (const node of nodes) if (node.parent_node_token) { const list = children.get(node.parent_node_token) ?? []; list.push(node); children.set(node.parent_node_token, list); }
  return (tokens: Iterable<string>): string[] => {
  const chosen = new Set([...tokens].filter((token) => records.has(token))); const queue = [...chosen];
  for (let i = 0; i < queue.length; i++) {
    const node = records.get(queue[i])!;
    for (const child of [...(children.get(node.wiki_node_token ?? '') ?? []), ...(children.get(node.obj_token) ?? [])]) if (!chosen.has(child.obj_token)) { chosen.add(child.obj_token); queue.push(child.obj_token); }
  }
  return [...chosen];
  };
}
export function descendantSelection(nodes: SelectionNode[], tokens: Iterable<string>): string[] { return createSelectionResolver(nodes)(tokens); }

export interface SelectionModifiers { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }
/** Range endpoints follow the rendered row order, while scope may include collapsed descendants. */
export function applySelectionGesture(
  previous: ReadonlySet<string>, token: string, anchor: string | null,
  visible: readonly string[], expand: (tokens: Iterable<string>) => string[],
  modifiers: SelectionModifiers, checkbox = false,
): { chosen: Set<string>; anchor: string } {
  const additive = modifiers.metaKey || modifiers.ctrlKey;
  const start = anchor === null ? -1 : visible.indexOf(anchor);
  const end = visible.indexOf(token);
  if (modifiers.shiftKey && start >= 0 && end >= 0) {
    const range = expand(visible.slice(Math.min(start, end), Math.max(start, end) + 1));
    return { chosen: new Set([...(additive ? previous : []), ...range]), anchor: anchor! };
  }
  const scope = expand([token]);
  const chosen = new Set(additive || checkbox ? previous : []);
  const remove = (additive || checkbox) && scope.every((item) => previous.has(item));
  for (const item of scope) { if (remove) chosen.delete(item); else chosen.add(item); }
  return { chosen, anchor: token };
}
