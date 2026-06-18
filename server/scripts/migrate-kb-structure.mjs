/**
 * migrate-kb-structure.mjs — feishu-sync knowledge-base header migration.
 *
 * Implements 03-迭代架构设计.md §2.5.2 (MigrateOptions / MigrateReport),
 * P1-T3 phase: only `header` is implemented in this round. `rename` is
 * deferred (P1-T1 → moved to P2-T9 per execution plan).
 *
 * Behavior:
 *   - Walk rootDir recursively for .md files (skipping .trash-bin/, .assets/,
 *     .csv-data/, images/, attachments/, node_modules/)
 *   - For each .md, run IndexScanner.parseMetadata on its content
 *   - Classify the header format: yaml_html (already new spec, skip),
 *     legacy_html_zh / blockquote (need rewrite), none (skip)
 *   - For files that need rewriting, extract known fields; if any required
 *     field is missing (wiki_node_token / space_id / obj_type / etc.), and
 *     the file has an original_link, call larkCliClient.getNode(link) to
 *     enrich. If no link and missing fields, log to failed[] but do not
 *     block other files.
 *   - Backup original to <path>.md.bak (single, overwrites prior .bak),
 *     then write the new YAML-in-comment header followed by the rest of
 *     the body (post-header, with the original legacy header stripped).
 *   - Dry-run prints a report (file counts, format distribution, getNode
 *     call estimate, total expected lark-cli invocations) and writes no
 *     files.
 *   - updateSqlite: when true, after rewriting each .md, refresh the
 *     matching documents row via the Python helper (the project's
 *     better-sqlite3 native binding is Electron-only, so we delegate to
 *     CPython sqlite3 to keep this script runnable from `node`).
 *
 * Usage:
 *   node server/scripts/migrate-kb-structure.mjs \
 *       --root "D:/WorkPace/公司知识库/飞书同步知识库" \
 *       --phases header \
 *       --backup-suffix .md.bak \
 *       [--dry-run] \
 *       [--update-sqlite] \
 *       [--db ~/.feishu-sync/feishu-sync.db]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SKIP_DIR_NAMES = new Set([
  '.trash-bin',
  'node_modules',
  '.git',
  'images',
  'attachments',
  // csv-data and .assets are feishu-sheet artifacts that don't carry a
  // feishu_sync header; skip their interiors but we still process the
  // .md siblings at the same level.
]);

// File-level skip list (we never touch these even if they sit at the root).
const SKIP_FILE_NAMES = new Set(['_index.json', 'README-meta.json']);

function parseArgs(argv) {
  const out = {
    root: null,
    phases: ['header'],
    // .md.bak is the task-spec suffix. Because mdPath already ends in .md,
    // appending ".md.bak" would yield "<name>.md.md.bak"; we interpret the
    // suffix as appended to the full path. Callers who pass --backup-suffix
    // .bak get "<name>.md.bak" (matches the spec wording "原 .md 备份为 .md.bak").
    // The default below matches the spec literally (".md.bak") so the
    // backup file is "<name>.md.md.bak"; to get the canonical "<name>.md.bak"
    // pass --backup-suffix .bak. Either way the script is consistent.
    backupSuffix: '.bak',
    dryRun: false,
    updateSqlite: false,
    db: path.join(os.homedir(), '.feishu-sync', 'feishu-sync.db'),
    larkCliPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--root':
        out.root = argv[++i];
        break;
      case '--phases':
        out.phases = argv[++i].split(',').map((s) => s.trim());
        break;
      case '--backup-suffix':
        out.backupSuffix = argv[++i];
        break;
      case '--dry-run':
        out.dryRun = true;
        break;
      case '--update-sqlite':
        out.updateSqlite = true;
        break;
      case '--db':
        out.db = argv[++i];
        break;
      case '--lark-cli-path':
        out.larkCliPath = argv[++i];
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith('--root=')) out.root = a.slice(7);
        else if (a.startsWith('--db=')) out.db = a.slice(5);
        else if (a.startsWith('--phases=')) out.phases = a.slice(9).split(',');
        else if (a.startsWith('--backup-suffix=')) out.backupSuffix = a.slice(16);
        else if (a.startsWith('--lark-cli-path=')) out.larkCliPath = a.slice(16);
        break;
    }
  }
  return out;
}

function printHelp() {
  console.log(`Usage: migrate-kb-structure.mjs --root <dir> [options]

Options:
  --root <dir>            Knowledge base root (required)
  --phases header         Comma-separated phases (only 'header' supported this round)
  --backup-suffix .md.bak Suffix used for original-file backups
  --dry-run               Print report without writing files
  --update-sqlite         After rewriting, refresh documents.local_md_path via Python helper
  --db <path>             SQLite DB path (default ~/.feishu-sync/feishu-sync.db)
  --lark-cli-path <path>  Override lark CLI executable path`);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.root) {
    console.error('Error: --root is required');
    printHelp();
    process.exit(2);
  }
  if (!fs.existsSync(opts.root)) {
    console.error(`Error: root does not exist: ${opts.root}`);
    process.exit(2);
  }
  if (!opts.phases.includes('header')) {
    console.error(
      `Error: this round only implements 'header' phase. Received: ${opts.phases.join(', ')}`,
    );
    process.exit(2);
  }

  const report = {
    scanned: 0,
    headerRewritten: 0,
    renamed: 0,
    moved: 0,
    failed: [],
    orphanFiles: [],
    dryRun: opts.dryRun,
    formatDistribution: { yaml_html: 0, legacy_html_zh: 0, blockquote: 0, none: 0 },
    getNodeEstimate: 0,
    getNodeInvoked: 0,
  };

  const larkCli = makeLarkCliStub(opts.larkCliPath);

  // Lazy-load the IndexScanner compiled output so we don't need tsx at run
  // time. The script is meant to run from a built server (server/dist) or
  // via tsx; if neither is available, fall back to a tiny embedded parser
  // that mirrors the TS implementation. To keep this single-file and
  // dependency-free, we embed the parser inline.
  const parseMetadata = makeMetadataParser();

  const mdFiles = walkMarkdown(opts.root);
  report.scanned = mdFiles.length;
  console.log(`[migrate] scanned ${mdFiles.length} .md files under ${opts.root}`);

  for (const mdPath of mdFiles) {
    try {
      const outcome = await processFile(mdPath, opts, parseMetadata, larkCli, report);
      if (outcome === 'rewritten') report.headerRewritten++;
    } catch (err) {
      report.failed.push({
        file: mdPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Risk evaluation for the operator.
  const qpsLimit = 10; // lark wiki namespace throttle
  const estSeconds = Math.ceil(report.getNodeEstimate / qpsLimit);
  const riskLevel =
    report.getNodeEstimate === 0
      ? 'none'
      : report.getNodeEstimate <= 20
        ? 'low'
        : report.getNodeEstimate <= 100
          ? 'medium'
          : 'high';

  console.log('');
  console.log('=== Migration report ===');
  console.log(`  scanned           : ${report.scanned}`);
  console.log(`  format yaml_html  : ${report.formatDistribution.yaml_html}`);
  console.log(`  format legacy_html: ${report.formatDistribution.legacy_html_zh}`);
  console.log(`  format blockquote : ${report.formatDistribution.blockquote}`);
  console.log(`  format none       : ${report.formatDistribution.none}`);
  console.log(`  headerRewritten   : ${report.headerRewritten}`);
  console.log(`  orphanFiles       : ${report.orphanFiles.length}`);
  console.log(`  failed            : ${report.failed.length}`);
  console.log(`  getNode estimate  : ${report.getNodeEstimate} (risk: ${riskLevel}, ~${estSeconds}s at ${qpsLimit} QPS)`);
  console.log(`  mode              : ${opts.dryRun ? 'DRY-RUN' : 'APPLY'}`);

  if (report.failed.length > 0) {
    console.log('');
    console.log('Failed files (non-blocking):');
    for (const f of report.failed.slice(0, 20)) {
      console.log(`  ${f.file}  --  ${f.error}`);
    }
    if (report.failed.length > 20) {
      console.log(`  ... and ${report.failed.length - 20} more`);
    }
  }

  if (opts.dryRun) {
    console.log('');
    console.log(
      '[migrate] Dry-run complete. Re-run without --dry-run to apply. Re-run with --update-sqlite to also refresh documents.local_md_path.',
    );
  } else if (report.headerRewritten > 0) {
    console.log('');
    console.log(`[migrate] Applied. Backups written with suffix ${opts.backupSuffix}.`);
  }

  // Write JSON report next to the script for audit.
  const reportPath = path.join(
    os.homedir(),
    '.feishu-sync',
    `migrate-kb-header-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  try {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    // Normalize Windows backslashes in path fields so the report is
    // valid JSON (raw backslashes are illegal \escape). Affects only
    // local_md_path / csv_path / failed[].file — fields that may
    // contain OS-native paths. (diting P1 review M1.)
    const sanitized = JSON.parse(
      JSON.stringify(report).replace(/\\\\/g, '/').replace(/\\\//g, '/')
    );
    fs.writeFileSync(reportPath, JSON.stringify(sanitized, null, 2));
    console.log(`[migrate] Report JSON written: ${reportPath}`);
  } catch (err) {
    console.warn(`[migrate] Could not write report JSON: ${err.message}`);
  }
}

/**
 * Process one .md file.
 *
 * Returns:
 *   'rewritten' — file was migrated from legacy format to YAML
 *   'skipped'   — already YAML or no header at all
 */
async function processFile(mdPath, opts, parseMetadata, larkCli, report) {
  const original = fs.readFileSync(mdPath, 'utf-8');
  const meta = parseMetadata(original);

  if (!meta) {
    report.formatDistribution.none++;
    report.orphanFiles.push(mdPath);
    return 'skipped';
  }

  report.formatDistribution[meta.header_format]++;

  if (meta.header_format === 'yaml_html') {
    // Already on new spec — nothing to do.
    return 'skipped';
  }

  // Legacy or blockquote: rewrite to YAML.
  let enriched = { ...meta };
  const missing = [];
  if (!enriched.wiki_node_token) missing.push('wiki_node_token');
  if (!enriched.space_id) missing.push('space_id');
  if (!enriched.obj_type) missing.push('obj_type');

  if (missing.length > 0 && enriched.original_link) {
    report.getNodeEstimate++;
    if (!opts.dryRun) {
      try {
        const node = await larkCli.getNode(enriched.original_link);
        report.getNodeInvoked++;
        if (!enriched.wiki_node_token && node.node_token) {
          enriched.wiki_node_token = node.node_token;
        }
        if (!enriched.space_id && node.space_id) {
          enriched.space_id = node.space_id;
        }
        if (!enriched.obj_type && node.obj_type) {
          enriched.obj_type = normalizeObjType(node.obj_type);
        }
        if (!enriched.obj_token && node.obj_token) {
          enriched.obj_token = node.obj_token;
        }
        // parent_node_token is not part of the new header spec (§2.2.1) —
        // it lives only in SQLite. Stash it on the enriched object so the
        // SQLite helper can pick it up via --parent-node-token.
        if (node.parent_node_token) {
          enriched.parent_node_token = node.parent_node_token;
        }
        // obj_edit_time is also SQLite-only (not in the YAML header). Stash
        // for the helper.
        if (node.obj_edit_time != null) {
          enriched.obj_edit_time = node.obj_edit_time;
        }
      } catch (err) {
        report.failed.push({
          file: mdPath,
          error: `getNode enrichment failed: ${err.message}`,
        });
        // Continue with what we have; the file still gets rewritten.
      }
    }
  } else if (missing.length > 0 && !enriched.original_link) {
    // Cannot enrich without a link. Log but don't block.
    report.failed.push({
      file: mdPath,
      error: `missing fields (${missing.join(', ')}) and no original_link to enrich from`,
    });
  }

  if (opts.dryRun) {
    // Dry-run: don't write anything.
    return 'rewritten';
  }

  // Locate the end of the legacy header so we can strip it from the body.
  const { body } = splitHeaderAndBody(original, meta.header_format);

  // Backup original (single, overwrites prior .bak).
  const backupPath = mdPath + opts.backupSuffix;
  fs.writeFileSync(backupPath, original);

  // Compose new YAML-in-comment header.
  const newHeader = renderYamlHeader(enriched);
  const newContent = newHeader + '\n\n' + body.replace(/^\n+/, '');
  fs.writeFileSync(mdPath, newContent);

  // Optional: refresh SQLite path mapping (path itself didn't change in
  // header phase, but we still update the wiki_node_token / space_id /
  // obj_edit_time columns so the new metadata lands in the map).
  if (opts.updateSqlite) {
    try {
      await updateSqliteMapping(opts.db, enriched, mdPath);
    } catch (err) {
      report.failed.push({
        file: mdPath,
        error: `sqlite update failed: ${err.message}`,
      });
    }
  }

  return 'rewritten';
}

// ---------------------------------------------------------------------------
// YAML-in-comment header renderer (mirrors the new spec in §2.2.1)
// ---------------------------------------------------------------------------
function renderYamlHeader(meta) {
  const lines = ['<!--', 'feishu_sync:'];
  if (meta.obj_token) lines.push(`  obj_token: ${meta.obj_token}`);
  if (meta.wiki_node_token) lines.push(`  wiki_node_token: ${meta.wiki_node_token}`);
  if (meta.space_id) lines.push(`  space_id: ${meta.space_id}`);
  if (meta.obj_type) lines.push(`  obj_type: ${meta.obj_type}`);
  if (meta.original_link) lines.push(`  original_link: ${meta.original_link}`);
  if (meta.fetch_date) lines.push(`  fetch_date: ${meta.fetch_date}`);
  if (meta.last_synced_modify_time) {
    lines.push(`  last_synced_modify_time: ${meta.last_synced_modify_time}`);
  }
  lines.push('-->');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Header/body splitter — strips the original legacy header so it isn't
// duplicated in the rewritten file.
// ---------------------------------------------------------------------------
function splitHeaderAndBody(content, headerFormat) {
  if (headerFormat === 'legacy_html_zh' || headerFormat === 'yaml_html') {
    const m = content.match(/^<!--\s*\n?[\s\S]*?\n?-->\s*\n?/);
    if (m) return { body: content.slice(m[0].length) };
    return { body: content };
  }
  if (headerFormat === 'blockquote') {
    // Drop the leading H1 + blockquote run.
    // Anchor on the first blockquote run (same logic as the parser).
    const m = content.match(/^[^\n]*\n*((?:>[^\n]*\n?){2,})/);
    if (m) {
      // Strip everything from the start of the file through the end of the
      // blockquote run. If there's an H1 before it, preserve it.
      const blockquoteEnd = m[0].length;
      const head = content.slice(0, content.length - m[1].length - (m[0].length - m[1].length));
      const after = content.slice(blockquoteEnd);
      // Simpler approach: split on the blockquote run boundary directly.
      const bqOnly = content.match(/((?:^[ \t]*>[^\n]*\n?){2,})/m);
      if (bqOnly) {
        const idx = content.indexOf(bqOnly[0]);
        const before = content.slice(0, idx);
        const after2 = content.slice(idx + bqOnly[0].length);
        return { body: before.replace(/\n+$/, '') + '\n\n' + after2.replace(/^\n+/, '') };
      }
      return { body: content };
    }
  }
  return { body: content };
}

// ---------------------------------------------------------------------------
// Markdown walker
// ---------------------------------------------------------------------------
function walkMarkdown(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) {
        // Skip artifact dirs by name or suffix.
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        if (e.name.endsWith('.csv-data')) continue;
        if (e.name.endsWith('.assets')) continue;
        stack.push(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        if (SKIP_FILE_NAMES.has(e.name)) continue;
        out.push(p);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Lark CLI client (thin wrapper; intentionally minimal — only getNode)
// ---------------------------------------------------------------------------
function makeLarkCliStub(larkCliPath) {
  // The published npm package is `lark-cli` (shim: lark-cli / lark-cli.cmd /
  // lark-cli.ps1 on Windows). The bare `lark` name is the desktop client
  // and does not implement the wiki subcommand used here.
  const exe = larkCliPath || 'lark-cli';
  return {
    async getNode(nodeTokenOrUrl) {
      const args = [
        'wiki',
        '+node-get',
        '--node-token',
        nodeTokenOrUrl,
        '--format',
        'json',
      ];
      const { stdout } = await execFileAsync(exe, args, {
        encoding: 'utf-8',
        shell: process.platform === 'win32',
        timeout: 30_000,
      });
      // lark-cli prints a human "Fetching wiki node ..." progress line to
      // stdout before the JSON object. Locate the first '{' and parse from
      // there; if nothing looks like JSON, surface a parse error.
      const jsonStart = stdout.indexOf('{');
      if (jsonStart < 0) {
        throw new Error(`lark-cli produced no JSON output (first 200 bytes: ${stdout.slice(0, 200)})`);
      }
      const parsed = JSON.parse(stdout.slice(jsonStart));
      const data = parsed.data || parsed;
      return {
        node_token: data.node_token,
        obj_token: data.obj_token,
        obj_type: normalizeObjType(data.obj_type),
        title: data.title,
        space_id: data.space_id,
        // lark-cli may also return parent_node_token — surface it so the
        // migration can store it (mirrors §3.6 mapping model).
        parent_node_token: data.parent_node_token,
        obj_edit_time: parseInt(data.obj_edit_time, 10) || null,
        has_child: data.has_child,
      };
    },
  };
}

function normalizeObjType(t) {
  if (!t) return undefined;
  const s = String(t).toLowerCase();
  if (s === 'docx' || s === 'sheet' || s === 'slides') return s;
  return undefined;
}

// ---------------------------------------------------------------------------
// SQLite mapping refresh — delegates to Python helper to avoid the
// Electron-only better-sqlite3 native binding under plain node v24.
// ---------------------------------------------------------------------------
async function updateSqliteMapping(dbPath, meta, mdPath) {
  const helper = path.join(__dirname, 'update_doc_mapping.py');
  const args = [
    helper,
    '--db',
    dbPath,
    '--obj-token',
    meta.obj_token || '',
    '--md-path',
    mdPath,
  ];
  if (meta.wiki_node_token) args.push('--wiki-node-token', meta.wiki_node_token);
  if (meta.space_id) args.push('--space-id', meta.space_id);
  if (meta.parent_node_token) args.push('--parent-node-token', meta.parent_node_token);
  if (meta.obj_edit_time != null) args.push('--obj-edit-time', String(meta.obj_edit_time));
  const { stdout, stderr } = await execFileAsync('python3', args, {
    encoding: 'utf-8',
  });
  if (stderr) console.warn(`[migrate] sqlite helper stderr: ${stderr.trim()}`);
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// Inline metadata parser — mirrors IndexScanner.parseMetadata so this
// script can run without the compiled TS bundle. The TS implementation in
// server/src/modules/index-scanner.ts is the source of truth; any change
// there must be reflected here (kept in sync by the index-scanner unit
// tests + this script's dry-run output).
// ---------------------------------------------------------------------------
function makeMetadataParser() {
  return function parseMetadata(content) {
    // 1. YAML-in-comment
    const yaml = parseYamlHtmlHeader(content);
    if (yaml) return yaml;
    // 2. Legacy Chinese HTML
    const legacy = parseLegacyHtmlHeader(content);
    if (legacy && (legacy.obj_token || legacy.original_link)) return legacy;
    // 3. Blockquote
    const bq = parseBlockquoteHeader(content);
    if (bq && (bq.obj_token || bq.original_link)) return bq;
    return null;
  };
}

function parseYamlHtmlHeader(content) {
  const m = content.match(/^<!--\s*\n([\s\S]*?)\n-->/);
  if (!m) return null;
  const body = m[1];
  if (!/feishu_sync\s*:/.test(body)) return null;
  const result = { header_format: 'yaml_html' };
  for (const line of body.split('\n').map((l) => l.replace(/^\s+/, ''))) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const kv = line.match(/^([a-z_]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const [, k, v] = kv;
    const val = v.trim().replace(/^["']|["']$/g, '');
    if (val.length === 0) continue;
    if (k === 'obj_token') result.obj_token = val;
    else if (k === 'wiki_node_token') result.wiki_node_token = val;
    else if (k === 'space_id') result.space_id = val;
    else if (k === 'obj_type' && (val === 'docx' || val === 'sheet' || val === 'slides')) {
      result.obj_type = val;
    } else if (k === 'original_link') result.original_link = val;
    else if (k === 'fetch_date') result.fetch_date = val;
    else if (k === 'last_synced_modify_time') result.last_synced_modify_time = val;
  }
  if (
    !result.obj_token &&
    !result.original_link &&
    !result.wiki_node_token &&
    !result.space_id
  ) {
    return null;
  }
  return result;
}

function parseLegacyHtmlHeader(content) {
  const m = content.match(/^<!--\s*\n?([\s\S]*?)\n?-->/);
  if (!m) return null;
  const body = m[1];
  if (!/来源|节点|原始链接|obj_token|获取日期|document_id/.test(body)) return null;
  const result = { header_format: 'legacy_html_zh' };
  const objM = body.match(/obj_token\s*[:：]\s*([A-Za-z0-9_]+)\s*(?:\(([^)]+)\))?/);
  if (objM) {
    result.obj_token = objM[1];
    const t = objM[2]?.trim().toLowerCase();
    if (t === 'docx' || t === 'sheet' || t === 'slides') result.obj_type = t;
  }
  const docIdM = body.match(/document_id\s*[:：]\s*([A-Za-z0-9_]+)/);
  if (!result.obj_token && docIdM) result.obj_token = docIdM[1];
  const linkM = body.match(/(?:原始链接|文档链接|original_link)\s*[:：]\s*(\S+)/);
  if (linkM) result.original_link = linkM[1];
  const dateM = body.match(/获取日期\s*[:：]\s*(\d{4}-\d{2}-\d{2})/);
  if (dateM) result.fetch_date = dateM[1];
  return result;
}

function parseBlockquoteHeader(content) {
  const window = content.slice(0, 4096);
  const re = /((?:^[ \t]*>[^\n]*\n?){2,15})/gm;
  let m;
  while ((m = re.exec(window)) !== null) {
    const run = m[1];
    if (!/(?:document_id|obj_token|文档链接|原始链接|original_link)/.test(run)) continue;
    const result = { header_format: 'blockquote' };
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
        const t = val.match(/^([A-Za-z0-9_]+)/);
        if (t) result.obj_token = t[1];
      } else if (key === 'document_id') {
        const t = val.match(/([A-Za-z0-9_]+)/);
        if (!result.obj_token && t) result.obj_token = t[1];
      } else if (key === 'original_link' || key === '文档链接' || key === '原始链接') {
        const t = val.match(/(https?:\/\/\S+)/);
        if (t) result.original_link = t[1];
      } else if (key === '获取日期') {
        const t = val.match(/(\d{4}-\d{2}-\d{2})/);
        if (t) result.fetch_date = t[1];
      }
    }
    if (result.obj_token || result.original_link) return result;
  }
  return null;
}

main().catch((err) => {
  console.error('[migrate] Fatal:', err);
  process.exit(1);
});
