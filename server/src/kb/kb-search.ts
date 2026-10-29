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

/**
 * P0/L1 查询单元：引号内保留短语，其余按空白/标点切分，去重。
 * + - _ . % # 不作分隔符，保留英文 ID、版本号和数值；单字/单数字仍可查。
 * 不含 lex-v1 的规范化、词表回退或单元数量截断。
 */
export function parseSearchQuery(query: string): string[] {
  const units: string[] = [];
  const tokens = /"([^"]*)"|“([^”]*)”|「([^」]*)」|([^\s,，。；;、:：!！?？()（）[\]【】{}<>《》'"“”‘’「」|\\/]+)/g;
  for (const match of query.toLowerCase().matchAll(tokens)) {
    const unit = (match[1] ?? match[2] ?? match[3] ?? match[4]).trim();
    if (unit) units.push(unit);
  }
  return [...new Set(units)];
}

/** L1：沿用字段权重，逐单元子串匹配；覆盖率乘子 = 0.5 + hits/units。 */
export function searchDocs(
  docs: SearchableDoc[],
  query: string,
  limit = 20,
  bodyFetcher?: (doc: SearchableDoc) => string | null,
): SearchHit[] {
  const units = parseSearchQuery(query);
  if (!units.length) return [];
  const hits: Array<{ hit: SearchHit; score: number }> = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    const docPath = doc.path.toLowerCase();
    const headings = doc.headings.map((heading) => heading.toLowerCase());
    const summary = doc.summary.toLowerCase();
    const body = bodyFetcher?.(doc) ?? '';
    const lowerBody = body.toLowerCase();
    let score = 0;
    let matched = 0;
    let firstIndex = -1;
    let firstLength = 0;
    for (const unit of units) {
      let unitScore = 0;
      if (title.includes(unit)) unitScore += 100;
      if (title.startsWith(unit)) unitScore += 50;
      if (docPath.includes(unit)) unitScore += 30;
      if (headings.some((heading) => heading.includes(unit))) unitScore += 40;
      if (summary.includes(unit)) unitScore += 20;
      const index = lowerBody.indexOf(unit);
      if (index >= 0) {
        unitScore += 60;
        if (firstIndex < 0 || index < firstIndex) {
          firstIndex = index;
          firstLength = unit.length;
        }
      }
      if (unitScore > 0) matched += 1;
      score += unitScore;
    }
    if (!matched) continue;
    score *= 0.5 + matched / units.length;
    let snippet = doc.summary.slice(0, 160) || doc.title;
    if (firstIndex >= 0) {
      const start = Math.max(0, firstIndex - 60);
      const end = Math.min(body.length, firstIndex + firstLength + 120);
      snippet = `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\n+/g, ' ')}${end < body.length ? '…' : ''}`;
    }
    hits.push({ hit: { docId: doc.docId, path: doc.path, title: doc.title, summary: doc.summary, snippet }, score });
  }
  // 不依赖宿主 locale，输入顺序不影响并列结果。
  hits.sort((a, b) => b.score - a.score || (a.hit.path < b.hit.path ? -1 : a.hit.path > b.hit.path ? 1 : 0));
  return hits.slice(0, Math.max(1, Math.min(limit, 50))).map((hit) => hit.hit);
}

/** 显式命名 P0 排序器；默认 searchDocs 在后续阶段升级时评测仍可比较 L1。 */
export const l1SearchDocs = searchDocs;

/** L0 原实现：仅供 E0 基线比较，保留整串子串匹配、排序与片段行为。 */
export function legacySearchDocs(
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
