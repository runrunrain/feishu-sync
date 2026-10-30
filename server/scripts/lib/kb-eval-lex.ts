/** Offline adapter: the product query facade against an already validated, pinned release.
 * Resolution is injected by subclassing only the release locator, never the ranker or grep.
 * This supports --release <dir> without copying files, creating CURRENT or changing input data.
 */
import fs from 'node:fs';
import { KbQueryService, QueryError, type ResolvedRelease } from '../../src/kb/search/kb-query-service.js';
import type { LoadedRelease } from './kb-eval-io.js';
import type { EvalRanker, GrepMatch } from './kb-eval-rankers.js';

class PinnedEvalService extends KbQueryService {
  constructor(private readonly input: LoadedRelease) { super(input.dir, { prewarm: false }); }
  override resolveRelease(releaseId?: string): ResolvedRelease {
    if ((releaseId !== undefined && releaseId !== this.input.releaseId) || !fs.existsSync(this.input.dir)) {
      throw new QueryError('kb_release_unavailable', '评测锚定版本已不可用');
    }
    return { releaseId: this.input.releaseId, releaseDir: this.input.dir, manifest: this.input.manifest, currentReleaseId: this.input.releaseId };
  }
}
export async function createLexRanker(input: LoadedRelease): Promise<EvalRanker> {
  if (process.env.FEISHU_KB_RANKER === 'l1') throw new Error('ranker_conflict: unset FEISHU_KB_RANKER=l1 to evaluate lex-v1');
  const service = new PinnedEvalService(input);
  await service.prewarmCurrent();
  return {
    name: 'lex-v1', implementation: 'product-KbQueryService/lex-v1', supportsSections: true,
    search: async (query, limit) => {
      // The quality metric must see the full requested top-k, not just one budget page.
      const results = [];
      let cursor: string | undefined;
      do {
        const page = await service.search({ query, limit, releaseId: input.releaseId, cursor, maxSnippets: 3 });
        results.push(...page.results); cursor = page.next ?? undefined;
      } while (cursor && results.length < limit);
      return results.slice(0, limit);
    },
    grep: async (pattern) => {
      const matches: GrepMatch[] = [];
      let cursor: string | undefined;
      do {
        const page = await service.grep({ pattern, releaseId: input.releaseId, cursor, maxMatches: 500 });
        if (!page.complete) throw new Error('incomplete_product_grep: partial results are not evaluation evidence');
        for (const file of page.files) for (const match of file.matches) matches.push({ path: file.path, line: match.line });
        cursor = page.next ?? undefined;
      } while (cursor);
      return matches;
    },
  };
}
