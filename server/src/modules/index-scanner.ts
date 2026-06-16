/**
 * IndexScanner - Initial full knowledge base indexing
 *
 * Implements the design from 架构设计文档 §8.1:
 * - Scan local .md files recursively
 * - Parse HTML comment headers (obj_token, original link, fetch date)
 * - Fallback to getNode for sheet files without obj_token
 * - Bulk upsert to SQLite
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

    console.info(`[IndexScanner] Scan completed: ${result.indexed} indexed, ${result.skipped} skipped, ${result.failed} failed`);

    return result;
  }

  /**
   * Index a single markdown file
   * Returns true if indexed, false if skipped (no valid header)
   */
  private async indexFile(mdPath: string): Promise<boolean> {
    const content = fs.readFileSync(mdPath, 'utf-8');

    // Parse HTML comment header
    const header = this.parseHtmlHeader(content);

    if (!header) {
      // No valid header, skip
      return false;
    }

    let objToken = header.obj_token;
    let objType = 'docx';

    // If obj_token is missing but original link exists, try to resolve
    if (!objToken && header.original_link) {
      try {
        console.info(`[IndexScanner] Missing obj_token for ${mdPath}, resolving from link: ${header.original_link}`);
        const nodeInfo = await this.larkCliClient.getNode(header.original_link);
        objToken = nodeInfo.obj_token;
        objType = nodeInfo.obj_type;
      } catch (error) {
        console.warn(`[IndexScanner] Failed to resolve obj_token from link for ${mdPath}:`, error);
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
      wikiNodeToken: null,
      objType: objType as DocumentRecord['objType'],
      title: path.basename(mdPath, '.md'),
      localMdPath: mdPath,
      lastSyncedModifyTime: header.fetch_date || new Date().toISOString().split('T')[0],
      lastSyncedAt: new Date().toISOString(),
      status: 'synced',
    });

    console.info(`[IndexScanner] Indexed ${mdPath} (obj_token: ${objToken})`);

    return true;
  }

  /**
   * Parse HTML comment header from markdown content
   */
  private parseHtmlHeader(content: string): { obj_token?: string; original_link?: string; fetch_date?: string } | null {
    // Regex to match HTML comment block at start of file
    const headerRegex = /<!--\s*\n([\s\S]*?)\n-->/;
    const match = content.match(headerRegex);

    if (!match) {
      return null;
    }

    const headerText = match[1];
    const result: { obj_token?: string; original_link?: string; fetch_date?: string } = {};

    // Extract obj_token
    const objTokenMatch = headerText.match(/obj_token:\s*(\S+)/);
    if (objTokenMatch) {
      result.obj_token = objTokenMatch[1];
    }

    // Extract original link
    const originalLinkMatch = headerText.match(/原始链接:\s*(\S+)/);
    if (originalLinkMatch) {
      result.original_link = originalLinkMatch[1];
    }

    // Extract fetch date
    const fetchDateMatch = headerText.match(/获取日期:\s*(\S+)/);
    if (fetchDateMatch) {
      result.fetch_date = fetchDateMatch[1];
    }

    return result;
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
