import type { DocumentRecord } from '../types/index.js';
import type { KbSourceChoice, KbSourceTreeNode } from '../types/kb-version.js';

/** 本地父文档既可能位于「目录/目录.md」，也可能位于「目录.md」。 */
function documentFolderKeys(relPath: string): string[] {
  const parts = relPath.replace(/\\/g, '/').split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return [];
  const file = parts.pop()!;
  if (!/\.md$/i.test(file)) return [];
  const name = file.slice(0, -3);
  if (!name) return [];
  const keys = [[...parts, name].join('/')];
  const parent = parts.at(-1);
  if (parent && (process.platform === 'win32' ? parent.toLowerCase() === name.toLowerCase() : parent === name)) {
    keys.push(parts.join('/'));
  }
  return keys.map((key) => process.platform === 'win32' ? key.toLowerCase() : key);
}

/**
 * 无父链的本地源会创建目录节点，真实云文档也可能代表同一目录。
 * 只在路径唯一且两者位于同一层（或文档直接位于该目录内）时合并，
 * 不凭名称猜测身份，也不改变有明确父链的不同分支。
 */
function mergeMirroredFolders(
  roots: KbSourceTreeNode[],
  folders: Map<string, KbSourceTreeNode>,
  nodes: Map<string, KbSourceTreeNode>,
): void {
  const folderKeys = new Map<KbSourceTreeNode, string>();
  for (const [prefix, folder] of folders) {
    const key = prefix.slice(1);
    folderKeys.set(folder, process.platform === 'win32' ? key.toLowerCase() : key);
  }
  const owners = new Map<string, Set<KbSourceTreeNode>>();
  for (const node of nodes.values()) {
    if (!node.source) continue;
    for (const key of documentFolderKeys(node.source.relPath)) {
      const matches = owners.get(key) ?? new Set<KbSourceTreeNode>();
      matches.add(node);
      owners.set(key, matches);
    }
  }

  const queue = [roots];
  while (queue.length) {
    const siblings = queue.pop()!;
    const siblingSet = new Set(siblings);
    for (let i = 0; i < siblings.length;) {
      const folder = siblings[i];
      const folderKey = folderKeys.get(folder);
      const matches = folderKey ? owners.get(folderKey) : undefined;
      if (!matches || matches.size !== 1) { i += 1; continue; }
      const owner = matches.values().next().value!;
      const ownerInsideFolder = folder.children.includes(owner);
      if (!ownerInsideFolder && !siblingSet.has(owner)) { i += 1; continue; }
      owner.children.push(...folder.children.filter((child) => child !== owner));
      siblingSet.delete(folder);
      if (ownerInsideFolder) {
        siblings[i] = owner;
        siblingSet.add(owner);
        i += 1;
      } else {
        siblings.splice(i, 1);
      }
    }
    for (const node of siblings) if (node.children.length) queue.push(node.children);
  }
}

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
  mergeMirroredFolders(roots, folders, nodes);
  const queue = [roots];
  while (queue.length) { const children = queue.pop()!; children.sort((a, b) => a.title.localeCompare(b.title)); for (const child of children) if (child.children.length) queue.push(child.children); }
  return roots;
}
