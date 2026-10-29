import type { DocumentRecord } from '../types/index.js';
import type { KbSourceChoice, KbSourceTreeNode } from '../types/kb-version.js';

/** 优先真实wiki父链；无父链时按本地目录分组，未同步父文档作为层级节点保留。 */
export function buildSourceTree(documents: DocumentRecord[], choices: KbSourceChoice[]): KbSourceTreeNode[] {
  const records = new Map(documents.map((doc) => [doc.objToken, doc]));
  const aliases = new Map<string, string>();
  for (const doc of documents) { aliases.set(doc.objToken, doc.objToken); if (doc.wikiNodeToken) aliases.set(doc.wikiNodeToken, doc.objToken); }
  const nodes = new Map<string, KbSourceTreeNode>();
  const parents = new Map<string, string>();
  const make = (token: string) => {
    if (!nodes.has(token)) nodes.set(token, { id: `doc:${token}`, title: records.get(token)?.title || token, children: [] });
    return nodes.get(token)!;
  };
  for (const choice of choices) {
    Object.assign(make(choice.objToken), { source: choice, title: choice.title });
    let token = choice.objToken;
    const seen = new Set<string>([token]);
    while (true) {
      const parent = aliases.get(records.get(token)?.parentNodeToken ?? '');
      if (!parent || seen.has(parent)) break;
      make(parent); parents.set(token, parent); seen.add(parent); token = parent;
    }
  }
  const roots: KbSourceTreeNode[] = [];
  const folders = new Map<string, KbSourceTreeNode>();
  for (const [token, node] of nodes) {
    // 没有可构建本地正文的真实云节点仍作为层级显示，但不算入已选数量。
    if (!node.source && records.has(token)) node.sourceUnavailable = true;
    const parent = parents.get(token);
    let cycle = false; const seen = new Set([token]); let ancestor = parent;
    while (ancestor) { if (seen.has(ancestor)) { cycle = true; break; } seen.add(ancestor); ancestor = parents.get(ancestor); }
    if (parent && !cycle) { nodes.get(parent)!.children.push(node); continue; }
    const relPath = node.source?.relPath ?? records.get(token)?.localRelPath ?? '';
    const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean).slice(0, -1);
    let children = roots; let prefix = '';
    for (const part of parts) {
      prefix += '/' + part;
      if (!folders.has(prefix)) { const folder = { id: `folder:${prefix}`, title: part, children: [] }; folders.set(prefix, folder); children.push(folder); }
      children = folders.get(prefix)!.children;
    }
    children.push(node);
  }
  const queue = [roots];
  while (queue.length) { const children = queue.pop()!; children.sort((a, b) => a.title.localeCompare(b.title)); for (const child of children) if (child.children.length) queue.push(child.children); }
  return roots;
}
