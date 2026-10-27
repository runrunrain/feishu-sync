/**
 * kb-search — 标准库搜索纯函数（无 SQLite、无 IO）
 *
 * 设计 §10：搜索实现与 kb_search 工具共用同一纯函数模块，保证 UI、
 * Agent、MCP 结果一致。本模块只做内存匹配，输入由调用方装载。
 */

export interface SearchableDoc {
  docId: string;
  path: string;
  title: string;
  summary: string;
  headings: string[];
}

export interface SearchHit {
  docId: string;
  path: string;
  title: string;
  summary: string;
  snippet: string;
}

/** 大小写不敏感子串搜索；标题/章节标题命中加权。 */
export function searchDocs(
  docs: SearchableDoc[],
  query: string,
  limit = 20,
  bodyFetcher?: (doc: SearchableDoc) => string | null,
): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: Array<{ hit: SearchHit; score: number }> = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const path = doc.path.toLowerCase();
    const headings = doc.headings.map((heading) => heading.toLowerCase());
    let score = 0;
    let snippet = '';

    if (title.includes(q)) score += 100;
    if (title.startsWith(q)) score += 50;
    if (path.includes(q)) score += 30;
    if (headings.some((heading) => heading.includes(q))) score += 40;
    if (doc.summary.toLowerCase().includes(q)) score += 20;

    if (bodyFetcher) {
      const body = bodyFetcher(doc);
      if (body) {
        const lowerBody = body.toLowerCase();
        const index = lowerBody.indexOf(q);
        if (index >= 0) {
          score += 60;
          const start = Math.max(0, index - 60);
          const end = Math.min(body.length, index + q.length + 120);
          snippet = `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\n+/g, ' ')}${end < body.length ? '…' : ''}`;
        }
      }
    }

    if (score <= 0) continue;
    if (!snippet) {
      snippet = doc.summary.slice(0, 160) || doc.title;
    }
    hits.push({ hit: { docId: doc.docId, path: doc.path, title: doc.title, summary: doc.summary, snippet }, score });
  }
  hits.sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path));
  return hits.slice(0, Math.max(1, Math.min(limit, 50))).map((hit) => hit.hit);
}

/** glob 简易匹配（支持 * 与 ?，用于 ws_search 的文件名过滤）。 */
export function matchGlob(name: string, pattern: string): boolean {
  const regex = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`,
    'i',
  );
  return regex.test(name);
}
