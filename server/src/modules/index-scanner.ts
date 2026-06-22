/**
 * IndexScanner - Initial full knowledge base indexing
 *
 * Implements the design from 架构设计文档 §8.1 + 迭代架构设计 §2.2:
 * - Scan local .md files recursively
 * - Parse metadata headers in four formats (priority order):
 *   1) YAML-in-comment new spec (feishu_sync: ...)
 *   2) Legacy Chinese-key HTML comment header (来源/节点/obj_token/原始链接/获取日期)
 *   3) Legacy blockquote header (after optional leading # title, with 文档链接/document_id/obj_token lines)
 *   4) Bold key-value header (`**来源**: ...\n**Obj Token**: ...\n**获取日期**: ...`)
 * - Fallback to lark-cli getNode for files with original_link but no obj_token
 * - Bulk upsert to SQLite
 *
 * Backward compatibility: legacy Chinese HTML headers, blockquote headers,
 * and bold key-value headers all continue to parse correctly so existing
 * local copies remain indexable.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { DocumentRecord } from '../types/index.js';

interface IndexScannerDeps {
  localMapStore: any; // LocalMapStore
  larkCliClient: any; // LarkCliClient
  config: any; // Config
}

interface IndexResult {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
  errors: Array<{ file: string; error: string }>;
}

/**
 * Normalized metadata extracted from any supported header format.
 * All keys are optional; consumers fall back to getNode when needed.
 */
export interface ParsedMetadata {
  obj_token?: string;
  wiki_node_token?: string;
  space_id?: string;
  obj_type?: 'docx' | 'sheet' | 'slides' | 'unknown';
  original_link?: string;
  fetch_date?: string;
  last_synced_modify_time?: string;
  /** Which header format was matched. Exposed for diagnostics + migration. */
  header_format: 'yaml_html' | 'legacy_html_zh' | 'blockquote' | 'bold_kv' | 'none';
}

export class IndexScanner {
  private localMapStore: any;
  private larkCliClient: any;

  constructor(deps: IndexScannerDeps) {
    this.localMapStore = deps.localMapStore;
    this.larkCliClient = deps.larkCliClient;
  }

  /**
   * Scan knowledge base root and index all .md files
   */
  async scanKnowledgeBase(rootDir: string): Promise<IndexResult> {
    const result: IndexResult = {
      scanned: 0,
      indexed: 0,
      skipped: 0,
      failed: 0,
      errors: [],
    };

    if (!fs.existsSync(rootDir)) {
      console.error(`[IndexScanner] Knowledge base root does not exist: ${rootDir}`);
      return result;
    }

    console.info(`[IndexScanner] Starting scan of ${rootDir}`);

    // Recursively find all .md files
    const mdFiles = this.findMarkdownFiles(rootDir);
    result.scanned = mdFiles.length;

    console.info(`[IndexScanner] Found ${mdFiles.length} markdown files`);

    // Process each .md file
    for (const mdPath of mdFiles) {
      try {
        const indexed = await this.indexFile(mdPath);
        if (indexed) {
          result.indexed++;
        } else {
          result.skipped++;
        }
      } catch (error) {
        result.failed++;
        result.errors.push({
          file: mdPath,
          error: error instanceof Error ? error.message : String(error),
        });
        console.warn(`[IndexScanner] Failed to index ${mdPath}:`, error);
      }
    }

    console.info(
      `[IndexScanner] Scan completed: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`,
    );

    return result;
  }

  /**
   * Index a single markdown file.
   * Returns true if indexed, false if skipped (no valid header).
   */
  private async indexFile(mdPath: string): Promise<boolean> {
    const content = fs.readFileSync(mdPath, 'utf-8');

    const header = this.parseMetadata(content);

    if (!header || (!header.obj_token && !header.original_link)) {
      // No usable header, skip
      return false;
    }

    let objToken = header.obj_token;
    let objType = header.obj_type ?? 'docx';

    // If obj_token is missing but original link exists, try to resolve
    if (!objToken && header.original_link) {
      try {
        console.info(
          `[IndexScanner] Missing obj_token for ${mdPath}, resolving from link: ${header.original_link}`,
        );
        const nodeInfo = await this.larkCliClient.getNode(header.original_link);
        objToken = nodeInfo.obj_token;
        objType = nodeInfo.obj_type;
      } catch (error) {
        console.warn(
          `[IndexScanner] Failed to resolve obj_token from link for ${mdPath}:`,
          error,
        );
        // Skip if cannot resolve obj_token
        return false;
      }
    }

    if (!objToken) {
      // Still no obj_token, skip
      return false;
    }

    // Upsert to SQLite
    this.localMapStore.upsertDocument({
      objToken,
      wikiNodeToken: header.wiki_node_token ?? null,
      objType: objType as DocumentRecord['objType'],
      title: path.basename(mdPath, '.md'),
      localMdPath: mdPath,
      lastSyncedModifyTime:
        header.fetch_date || new Date().toISOString().split('T')[0],
      lastSyncedAt: new Date().toISOString(),
      status: 'synced',
    });

    console.info(`[IndexScanner] Indexed ${mdPath} (obj_token: ${objToken})`);

    return true;
  }

  /**
   * Public entry point for metadata parsing (used by migration scripts + unit tests).
   * Tries each supported header format in priority order.
   *
   * Priority:
   *   1. YAML-in-comment new spec (`<!--\nfeishu_sync:\n...\n-->`)
   *   2. Legacy Chinese-key HTML comment (`<!--\n来源/节点/obj_token/原始链接/获取日期\n-->`)
   *   3. Legacy blockquote header (consecutive `> ...` lines with metadata fields)
   *
   * Returns null only when no header is present at all. Otherwise returns a
   * ParsedMetadata with header_format set; downstream code checks for the
   * presence of obj_token / original_link to decide whether the file is
   * indexable.
   */
  parseMetadata(content: string): ParsedMetadata | null {
    // 1. New spec: YAML-in-comment
    const yamlHeader = this.parseYamlHtmlHeader(content);
    if (yamlHeader) return yamlHeader;

    // 2. Legacy Chinese-key HTML comment
    const legacyHtml = this.parseLegacyHtmlHeader(content);
    if (legacyHtml && (legacyHtml.obj_token || legacyHtml.original_link)) {
      return legacyHtml;
    }

    // 3. Legacy blockquote header
    const blockquote = this.parseBlockquoteHeader(content);
    if (blockquote && (blockquote.obj_token || blockquote.original_link)) {
      return blockquote;
    }

    // 4. Bold key-value header (**来源** / **Obj Token** / **获取日期**)
    const boldKv = this.parseBoldKvHeader(content);
    if (boldKv && (boldKv.obj_token || boldKv.original_link)) {
      return boldKv;
    }

    // No recognizable header
    return null;
  }

  /**
   * Format 1: YAML-in-comment new spec
   *
   *   <!--
   *   feishu_sync:
   *     obj_token: <TOKEN>
   *     wiki_node_token: <TOKEN>
   *     space_id: <ID>
   *     obj_type: docx | sheet | slides
   *     original_link: https://xxx.feishu.cn/wiki/<TOKEN>
   *     fetch_date: YYYY-MM-DD
   *     last_synced_modify_time: ISO8601
   *   -->
   *
   * Accepts both the block-form (`feishu_sync:\n  key: val`) and an inline
   * fallback where the YAML body directly starts with `obj_token:` at the
   * top level of the comment (defensive against minor formatting drift).
   */
  private parseYamlHtmlHeader(content: string): ParsedMetadata | null {
    const commentMatch = content.match(/^<!--\s*\n([\s\S]*?)\n-->/);
    if (!commentMatch) return null;
    const body = commentMatch[1];

    // Must contain the feishu_sync marker to qualify as YAML new spec.
    if (!/feishu_sync\s*:/.test(body)) return null;

    const parsed = this.extractYamlFields(body);
    if (!parsed) return null;

    return {
      ...parsed,
      header_format: 'yaml_html',
    };
  }

  /**
   * Format 2: Legacy Chinese-key HTML comment header
   *
   *   <!--
   *   来源: 飞书知识库 策划 - Designer
   *   节点: 500-...
   *   原始链接: https://xxx.feishu.cn/wiki/<TOKEN>
   *   obj_token: <TOKEN> (docx)
   *   获取日期: 2026-06-15
   *   -->
   *
   * Also tolerates the very short `<!-- 来源：飞书电子表格 -->` form (no
   * extractable fields → returns null so the caller can fall through).
   */
  private parseLegacyHtmlHeader(content: string): ParsedMetadata | null {
    const commentMatch = content.match(/^<!--\s*\n?([\s\S]*?)\n?-->/);
    if (!commentMatch) return null;
    const body = commentMatch[1];

    // Skip comments that don't carry any of the known legacy keys.
    if (!/来源|节点|原始链接|obj_token|获取日期|document_id/.test(body)) {
      return null;
    }

    const result: ParsedMetadata = { header_format: 'legacy_html_zh' };

    // obj_token: <TOKEN> (docx)  — strip trailing " (type)" qualifier.
    // Token charset is generous: feishu tokens mix letters + digits, and
    // legacy headers occasionally embed underscores. We stop at the first
    // whitespace or "(" to leave room for the optional type qualifier.
    const objMatch = body.match(
      /obj_token\s*[:：]\s*([A-Za-z0-9_]+)\s*(?:\(([^)]+)\))?/,
    );
    if (objMatch) {
      result.obj_token = objMatch[1];
      const typeHint = objMatch[2]?.trim().toLowerCase();
      if (typeHint === 'docx' || typeHint === 'sheet' || typeHint === 'slides') {
        result.obj_type = typeHint;
      }
    }

    // document_id: <TOKEN> — some legacy headers use this label as obj_token.
    const docIdMatch = body.match(/document_id\s*[:：]\s*([A-Za-z0-9_]+)/);
    if (!result.obj_token && docIdMatch) {
      result.obj_token = docIdMatch[1];
    }

    const linkMatch = body.match(/(?:原始链接|文档链接|original_link)\s*[:：]\s*(\S+)/);
    if (linkMatch) result.original_link = linkMatch[1];

    const dateMatch = body.match(/获取日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) result.fetch_date = dateMatch[1];

    return result;
  }

  /**
   * Format 3: Legacy blockquote header
   *
   * Observed real-world form (see `[必读] 研发规范/README.md`):
   *
   *   # [必读] 研发规范
   *
   *   > 本地副本来源：飞书文档
   *   > - 原始标题：[必读] 研发规范
   *   > - 文档链接：https://xxx.feishu.cn/wiki/<TOKEN>
   *   > - document_id：Du9Fdux8KoRbHZxluLfcMja1nUh
   *   > - revision_id：478
   *   > - 获取日期：2026-06-15
   *
   * Accepts blockquote either at the very start of the file or right after
   * an H1 title + blank line. Each metadata line may be a bare `> key: val`
   * or a `> - key: val` bullet.
   */
  private parseBlockquoteHeader(content: string): ParsedMetadata | null {
    // Anchor on the first blockquote run that contains a recognizable field
    // marker. We scan up to the first 4 KiB to keep the regex bounded.
    const window = content.slice(0, 4096);

    // A "blockquote run" is two or more consecutive `>` lines. We require
    // at least one to carry a known metadata marker to avoid matching
    // ordinary quoted prose.
    const runRegex = /((?:^[ \t]*>[^\n]*\n?){2,15})/gm;
    let m: RegExpExecArray | null;
    while ((m = runRegex.exec(window)) !== null) {
      const run = m[1];
      if (!/(?:document_id|obj_token|文档链接|原始链接|original_link)/.test(run)) {
        continue;
      }

      const result: ParsedMetadata = { header_format: 'blockquote' };

      // Strip leading "> " / "> - " markers from each line, then key/value split.
      const lines = run
        .split('\n')
        .map((l) => l.replace(/^[ \t]*>\s?/, '').replace(/^-\s?/, '').trim())
        .filter(Boolean);

      for (const line of lines) {
        const kv = line.match(/^([A-Za-z_^一-龥]+|[一-龥]+)\s*[:：]\s*(.+)$/);
        if (!kv) continue;
        const key = kv[1].trim();
        const val = kv[2].trim();

        if (key === 'obj_token') {
          const tokenM = val.match(/^([A-Za-z0-9_]+)/);
          if (tokenM) result.obj_token = tokenM[1];
        } else if (key === 'document_id') {
          // blockquote headers commonly use document_id as the obj_token.
          // Strip any surrounding prose; tokens are [A-Za-z0-9_]+.
          const tokenM = val.match(/([A-Za-z0-9_]+)/);
          if (!result.obj_token && tokenM) result.obj_token = tokenM[1];
        } else if (key === 'original_link' || key === '文档链接' || key === '原始链接') {
          const linkM = val.match(/(https?:\/\/\S+)/);
          if (linkM) result.original_link = linkM[1];
        } else if (key === '获取日期') {
          const dateM = val.match(/(\d{4}-\d{2}-\d{2})/);
          if (dateM) result.fetch_date = dateM[1];
        }
      }

      if (result.obj_token || result.original_link) {
        return result;
      }
    }

    return null;
  }

  /**
   * Format 4: Bold key-value header (markdown bold KV)
   *
   * Real-world form (most files under `技术 - Dev/`):
   *
   *   # 1.1.面向数据
   *
   *   **来源**: [飞书 Wiki](https://qcnbafdrjx7n.feishu.cn/wiki/<TOKEN>)
   *   **Obj Token**: <TOKEN>
   *   **获取日期**: 2026-06-16
   *
   *   ---
   *
   * Field labels seen in the wild (case-insensitive):
   *   - 来源 / 原始链接 / 文档链接 / original_link (URL may be wrapped in
   *     `[text](URL)` markdown link syntax, or be bare)
   *   - Obj Token / obj_token / document_id (token, no type qualifier)
   *   - 获取日期 (YYYY-MM-DD)
   *
   * The header is recognized only when at least one of {obj_token,
   * original_link} is present, matching the contract of the other formats.
   *
   * Scan window: first 4 KiB (consistent with parseBlockquoteHeader).
   */
  private parseBoldKvHeader(content: string): ParsedMetadata | null {
    const window = content.slice(0, 4096);

    // Must contain the bold-marker prefix to qualify. We anchor on
    // `**` followed by a known field label to avoid matching ordinary
    // bold prose (e.g. emphasis like "**重要**").
    if (!/\*\*\s*(?:来源|原始链接|文档链接|original_link|Obj\s*Token|obj_token|document_id)/i.test(window)) {
      return null;
    }

    const result: ParsedMetadata = { header_format: 'bold_kv' };

    // Obj Token: <TOKEN>
    // Allow optional whitespace, support both English and Chinese colons.
    // Token charset = [A-Za-z0-9_]+ (matches feishu token format).
    const objMatch = window.match(
      /\*\*\s*Obj\s*Token\s*\*\*\s*[:：]\s*([A-Za-z0-9_]+)/i,
    );
    if (objMatch) {
      result.obj_token = objMatch[1];
    }

    // document_id: <TOKEN> (rare in bold_kv but tolerated for forward compat)
    if (!result.obj_token) {
      const docIdMatch = window.match(
        /\*\*\s*document_id\s*\*\*\s*[:：]\s*([A-Za-z0-9_]+)/i,
      );
      if (docIdMatch) result.obj_token = docIdMatch[1];
    }

    // Source / link: URL may be inside `[text](URL)` or bare.
    const linkMatch = window.match(
      /\*\*\s*(?:来源|原始链接|文档链接|original_link)\s*\*\*\s*[:：]\s*(?:\[[^\]]*\]\(([^)\s]+)\)|([^)\s]+))/i,
    );
    if (linkMatch) {
      const url = linkMatch[1] ?? linkMatch[2];
      if (url) result.original_link = url.trim();
    }

    // Fetch date: YYYY-MM-DD
    const dateMatch = window.match(
      /\*\*\s*获取日期\s*\*\*\s*[:：]\s*(\d{4}-\d{2}-\d{2})/,
    );
    if (dateMatch) {
      result.fetch_date = dateMatch[1];
    }

    return result;
  }

  /**
   * Best-effort YAML field extraction for the new-spec comment body.
   * Avoids pulling in a full YAML parser dependency; the schema is small
   * and under our control. Accepts indented `key: value` lines under an
   * optional `feishu_sync:` parent.
   */
  private extractYamlFields(body: string): Omit<ParsedMetadata, 'header_format'> | null {
    const result: Partial<ParsedMetadata> = {};

    // Drop the `feishu_sync:` parent line if present; the rest are flat k:v.
    const lines = body
      .split('\n')
      .map((l) => l.replace(/^\s+/, '')) // normalize indentation
      .filter((l) => l.length > 0 && !l.startsWith('#'));

    let inFeishuSync = false;
    for (const line of lines) {
      if (/^feishu_sync\s*:/.test(line)) {
        inFeishuSync = true;
        continue;
      }
      const kv = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
      if (!kv) continue;
      const [, rawKey, rawVal] = kv;
      const key = rawKey.trim();
      const val = rawVal.trim().replace(/^["']|["']$/g, ''); // strip quotes
      if (val.length === 0) continue;

      switch (key) {
        case 'obj_token':
          result.obj_token = val;
          break;
        case 'wiki_node_token':
          result.wiki_node_token = val;
          break;
        case 'space_id':
          result.space_id = val;
          break;
        case 'obj_type':
          if (val === 'docx' || val === 'sheet' || val === 'slides') {
            result.obj_type = val;
          }
          break;
        case 'original_link':
          result.original_link = val;
          break;
        case 'fetch_date':
          result.fetch_date = val;
          break;
        case 'last_synced_modify_time':
          result.last_synced_modify_time = val;
          break;
        default:
          // Unknown keys are tolerated for forward compatibility.
          break;
      }
      // Continue collecting fields whether or not feishu_sync: prefix was seen.
      void inFeishuSync;
    }

    if (
      !result.obj_token &&
      !result.original_link &&
      !result.wiki_node_token &&
      !result.space_id
    ) {
      return null;
    }
    return result as Omit<ParsedMetadata, 'header_format'>;
  }

  /**
   * Recursively find all .md files in a directory
   */
  private findMarkdownFiles(dir: string): string[] {
    const mdFiles: string[] = [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Recursively scan subdirectories
        mdFiles.push(...this.findMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        mdFiles.push(fullPath);
      }
    }

    return mdFiles;
  }
}
