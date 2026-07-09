#!/usr/bin/env node
/**
 * migrate-headers.cjs — 一次性历史文件头迁移脚本（规范 §5.3 / §10.3）
 *
 * 目标：把 feishu-sync kbRoot 下非 yaml_html 格式的 .md 文件头统一迁移
 *       为 yaml_html（`<!-- feishu_sync: ... -->`），与 SyncEngine 当前的
 *       generateHtmlHeader / resolveHeaderMeta 产物保持一致。
 *
 * 迁移对象（4 种头格式，详见 index-scanner.ts parseMetadata）：
 *   - yaml_html       目标格式，跳过
 *   - legacy_html_zh  迁移
 *   - blockquote      迁移
 *   - bold_kv         迁移
 *
 * 安全保障（对齐规范 §9 红线 1/7 + immutable-baseline §5 不伪造）：
 *   1. 默认 dry-run，不写盘；必须显式 --apply 才修改文件。
 *   2. apply 模式下，每个文件先备份为 `{filename}.pre-migrate`；备份不覆盖
 *      （已存在则保留最早的原始，避免二次迁移丢原始）。
 *   3. 迁移后对产物重新 parseMetadata 并断言 obj_token 严格相等（红线 7），
 *      断言失败则不写盘并报告。
 *   4. 字段不伪造：SQLite 没有的字段（wiki_node_token / space_id / obj_type
 *      / original_link / last_synced_modify_time）一律省略，与
 *      generateHtmlHeader 的省略规则一致。
 *   5. 无 obj_token（orphan）的文件跳过，不迁移。
 *   6. 只改头，正文逐字符保留（仅删除定位到的旧头块，新头插到文件最前）。
 *
 * 用法：
 *   node scripts/migrate-headers.cjs              # 默认 dry-run，只统计
 *   node scripts/migrate-headers.cjs --dry-run    # 显式 dry-run
 *   node scripts/migrate-headers.cjs --apply      # 真实写盘（含备份）
 *
 * 前置条件：
 *   - server/dist 已编译（npm run build --prefix server）；脚本通过动态
 *     import() 加载 ESM 编译产物 IndexScanner + LocalMapStore。
 *   - ~/.feishu-sync/config.json 存在且 knowledgeBaseRoot 指向有效目录。
 *   - ~/.feishu-sync/feishu-sync.db 存在（SQLite 真相源，用于补全 meta）。
 *
 * 注意：执行迁移前应先停止 feishu-sync 同步工具（规范 §10.3 步骤 1），
 *       避免迁移途中触发 modified 覆盖写。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

// ========== Argument Parsing ==========

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (const a of args) {
    if (a === '--apply') params.apply = true;
    else if (a === '--dry-run') params.dryRun = true;
    else if (a === '-h' || a === '--help') params.help = true;
    else {
      console.error(`未知参数: ${a}`);
      console.error('用法: node scripts/migrate-headers.cjs [--dry-run|--apply]');
      process.exit(2);
    }
  }
  return params;
}

const ARGS = parseArgs();

if (ARGS.help) {
  console.log('migrate-headers.cjs — 历史文件头迁移到 yaml_html');
  console.log('');
  console.log('用法:');
  console.log('  node scripts/migrate-headers.cjs --dry-run   # 默认，只统计不写盘');
  console.log('  node scripts/migrate-headers.cjs --apply     # 真实写盘（含 .pre-migrate 备份）');
  process.exit(0);
}

// dry-run 是默认安全模式；只有显式 --apply 才写盘。
const APPLY = ARGS.apply === true;
const DRY_RUN = !APPLY;

// ========== Paths ==========

const HOME = os.homedir();
const CONFIG_PATH = path.join(HOME, '.feishu-sync', 'config.json');
const DB_PATH = path.join(HOME, '.feishu-sync', 'feishu-sync.db');
const SERVER_ROOT = path.join(__dirname, '..', 'server');
const DIST_INDEX_SCANNER = path.join(SERVER_ROOT, 'dist', 'modules', 'index-scanner.js');
const DIST_LOCAL_MAP_STORE = path.join(SERVER_ROOT, 'dist', 'modules', 'local-map-store.js');

// ========== Dynamic ESM import (server/dist is ESM, type=module) ==========

async function loadModules() {
  if (!fs.existsSync(DIST_INDEX_SCANNER)) {
    throw new Error(
      `找不到 server 编译产物: ${DIST_INDEX_SCANNER}\n` +
      `请先运行 \`npm run build --prefix server\` 生成 dist/，再执行本脚本。`,
    );
  }
  if (!fs.existsSync(DIST_LOCAL_MAP_STORE)) {
    throw new Error(`找不到 server 编译产物: ${DIST_LOCAL_MAP_STORE}`);
  }
  const scannerMod = await import(pathToFileURL(DIST_INDEX_SCANNER).href);
  const storeMod = await import(pathToFileURL(DIST_LOCAL_MAP_STORE).href);
  if (!scannerMod.IndexScanner || !storeMod.LocalMapStore) {
    throw new Error('server 编译产物未导出 IndexScanner / LocalMapStore 类');
  }
  return { IndexScanner: scannerMod.IndexScanner, LocalMapStore: storeMod.LocalMapStore };
}

// ========== Config ==========

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      `找不到 config.json: ${CONFIG_PATH}\n` +
      `请先启动 feishu-sync 生成配置，或检查 HOME 环境变量。`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (e) {
    throw new Error(`config.json 解析失败: ${e.message}`);
  }
  const kbRoot = raw.knowledgeBaseRoot;
  if (typeof kbRoot !== 'string' || kbRoot.length === 0) {
    throw new Error('config.json 缺少 knowledgeBaseRoot 字段');
  }
  if (!fs.existsSync(kbRoot)) {
    throw new Error(`knowledgeBaseRoot 目录不存在: ${kbRoot}`);
  }
  const watchedRootUrls = Array.isArray(raw.watchedRootUrls) ? raw.watchedRootUrls : [];
  return { kbRoot, watchedRootUrls };
}

// ========== Collect markdown (skip rules mirror snapshot-service.collectMarkdownFiles) ==========

function collectMarkdownFiles(dir, out) {
  out = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    // 跳过点目录 (.trash-bin / .git / .assets 等)
    if (entry.name.startsWith('.')) continue;
    // 跳过 _reports 目录（agent-outputs / sync reports，本地产物无飞书对应）
    if (entry.isDirectory() && entry.name === '_reports') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdownFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      // 不跳过 README.md / INDEX.md：对齐 snapshot-service.collectMarkdownFiles
      // （snapshot-service.ts:407-433），它只跳点目录和 _reports。
      //
      // scanOrphanFiles 的 README/INDEX 跳过（snapshot-service.ts:336-343）是
      // orphan 扫描专属逻辑（生成式 README 无头，不视为 orphan 噪音），不应
      // 套用到迁移场景。迁移中 README/INDEX 是否处理由 parseMetadata 决定：
      //   - 有 obj_token 的 README（如 watchedRoot 子目录的 legacy 同步产物
      //     技术-Dev/README.md，legacy_html_zh + obj_token）→ 必须迁移
      //   - 无头的 README/INDEX（如开发环境指引/README.md）→ parseMetadata
      //     返回 null，自然判为 orphan 跳过
      out.push(full);
    }
  }
  return out;
}

// ========== Header generation (mirror SyncEngine.generateHtmlHeader, sync-engine.ts:760-799) ==========
//
// 复制该方法逻辑而非直接 import，因为 generateHtmlHeader 是 SyncEngine 的
// 私有实例方法，实例化 SyncEngine 会引入 larkCliClient / contentAdapter 等
// 重依赖。保持字段顺序与省略规则与源码完全一致。

function yamlScalar(value) {
  // 与 sync-engine.ts:810-812 一致：值两端加双引号。
  // IndexScanner.extractYamlFields 用 /^["']|["']$/g 剥一层引号，双引号安全。
  // feishu token / URL / ISO8601 不含双引号，无需转义。
  return '"' + value + '"';
}

function generateYamlHtmlHeader(meta) {
  const lines = ['<!--', 'feishu_sync:'];

  // obj_token 总是输出（SQLite PK，归属核心凭证）
  lines.push('  obj_token: ' + yamlScalar(meta.objToken));

  if (meta.wikiNodeToken) {
    lines.push('  wiki_node_token: ' + yamlScalar(meta.wikiNodeToken));
  }
  if (meta.spaceId) {
    lines.push('  space_id: ' + yamlScalar(meta.spaceId));
  }

  // obj_type: 仅 docx/sheet/slides 输出；unknown 省略，让 IndexScanner
  // 回退到默认 'docx' 分类（sync-engine.ts:778，规范 §5.3 不伪造类型）
  if (meta.objType === 'docx' || meta.objType === 'sheet' || meta.objType === 'slides') {
    lines.push('  obj_type: ' + yamlScalar(meta.objType));
  }

  if (meta.originalLink) {
    lines.push('  original_link: ' + yamlScalar(meta.originalLink));
  }

  lines.push('  fetch_date: ' + yamlScalar(meta.fetchDate));

  if (meta.lastSyncedModifyTime && meta.lastSyncedModifyTime.length > 0) {
    lines.push('  last_synced_modify_time: ' + yamlScalar(meta.lastSyncedModifyTime));
  }

  lines.push('-->');
  // 末尾空行分隔头与正文（与 generateHtmlHeader 一致）
  return lines.join('\n') + '\n\n';
}

// ========== Extract feishu host (mirror SyncEngine.extractFeishuHost, sync-engine.ts:890-900) ==========

function extractFeishuHost(watchedRootUrls) {
  if (!Array.isArray(watchedRootUrls) || watchedRootUrls.length === 0) return null;
  const first = watchedRootUrls[0];
  if (typeof first !== 'string' || first.length === 0) return null;
  try {
    return new URL(first).host;
  } catch {
    return null;
  }
}

// ========== Resolve meta (mirror SyncEngine.resolveHeaderMeta, sync-engine.ts:847-880) ==========
//
// 字段来源（不伪造）：
//   objToken             : parsed.obj_token （来自原头，红线 7 不变）
//   objType              : record.objType ?? 'unknown' （SQLite 真相源）
//   wikiNodeToken        : record.wikiNodeToken ?? null
//   spaceId              : record.spaceId ?? null
//   originalLink 优先级   : parsed.original_link → record.originalLink
//                          → https://{host}/wiki/{wikiNodeToken}
//   fetchDate            : record.lastSyncedAt → parsed.fetch_date → 当前时间
//                          （优先真实同步时间，避免伪造抓取时间）
//   lastSyncedModifyTime : record.lastSyncedModifyTime ?? '' （空则省略）

function resolveMeta(parsed, record, watchedRootUrls) {
  const objToken = parsed.obj_token;
  const objType = (record && record.objType) ? record.objType : 'unknown';
  const wikiNodeToken = (record && record.wikiNodeToken) ? record.wikiNodeToken : null;
  const spaceId = (record && record.spaceId) ? record.spaceId : null;

  // original_link 合法性过滤：候选值必须是以 http(s) 开头的合法 URL。
  // 历史 SQLite 中存在 original_link = "obj_token:" 等非法值（早期版本解析错误
  // 写入），直接继承会污染迁移后的文件头。遇到非 http 值一律跳过，转下一优先级；
  // 若最终无合法候选则省略该字段（generateYamlHtmlHeader 不写 original_link 行），
  // 绝不写 bad 值（与规范 §5.3 "不伪造" 一致）。
  const isValidOriginalLink = (v) =>
    typeof v === 'string' && /^https?:\/\//.test(v.trim());

  let originalLink = null;
  // 候选1: 原头里的 original_link（合法 http 才采用）
  if (isValidOriginalLink(parsed.original_link)) {
    originalLink = parsed.original_link.trim();
  }
  // 候选2: SQLite record.originalLink（合法 http 才采用，过滤 "obj_token:" 等 bad 值）
  if (!originalLink && record && isValidOriginalLink(record.originalLink)) {
    originalLink = record.originalLink.trim();
  }
  // 候选3: 由 wiki_node_token + 飞书 host 构造（与 SyncEngine.extractFeishuHost 一致）
  if (!originalLink && wikiNodeToken) {
    const host = extractFeishuHost(watchedRootUrls);
    if (host) {
      originalLink = 'https://' + host + '/wiki/' + wikiNodeToken;
    }
  }
  // 若三个候选都无合法值，originalLink 保持 null -> generateYamlHtmlHeader 省略该行

  // fetchDate: 优先 SQLite 真实同步时间，回退原头 fetch_date，最后当前时间。
  // 不无脑用当前时间——那是伪造抓取时间。lastSyncedAt 是真实同步时间戳。
  let fetchDate = null;
  if (record && record.lastSyncedAt) {
    fetchDate = record.lastSyncedAt;
  } else if (parsed.fetch_date) {
    fetchDate = parsed.fetch_date;
  } else {
    fetchDate = new Date().toISOString();
  }

  const lastSyncedModifyTime = (record && record.lastSyncedModifyTime) ? record.lastSyncedModifyTime : '';

  return {
    objToken,
    objType,
    wikiNodeToken,
    spaceId,
    originalLink,
    fetchDate,
    lastSyncedModifyTime,
  };
}

// ========== Locate old header range in file content ==========
//
// 返回 [start, end] 字符区间，或 null（定位失败）。
//
// 关键设计：新 yaml_html 头始终插入到文件最前面（parseYamlHtmlHeader 用
// `^<!--` 锚定，要求头在文件首字符）。因此对 blockquote/bold_kv（原头可能
// 在 H1 之后）的处理是：定位原头块边界 → 删除原头 → 新头插到文件最前。
// H1 与正文逐字符保留。

function locateOldHeader(content, format) {
  // yaml_html / legacy_html_zh：都是首个 HTML 注释块，锚定文件首字符。
  // parseYamlHtmlHeader/parseLegacyHtmlHeader 均用 /^<!-- 锚定。
  if (format === 'yaml_html' || format === 'legacy_html_zh') {
    const m = content.match(/^<!--\s*\n?[\s\S]*?\n?-->\s*\n?/);
    return m ? [0, m[0].length] : null;
  }

  // blockquote：沿用 parseBlockquoteHeader 的扫描窗口（前 4KB）+ 多行模式。
  // 头可能在 H1 + 空行之后，因此不锚定 ^。
  if (format === 'blockquote') {
    const windowStr = content.slice(0, 4096);
    const re = /((?:^[ \t]*>[^\n]*\n?){2,15})/m;
    const m = windowStr.match(re);
    if (!m) return null;
    const start = m.index;
    let end = start + m[0].length;
    // 吃一个尾随空行（避免正文首段与头之间出现双空行）
    if (end < content.length && content[end] === '\n') end++;
    return [start, end];
  }

  // bold_kv：首行必须是已知字段（白名单，防误吃正文 bold 强调），然后吃
  // 连续的 `**...**` 行。同样不锚定 ^，头可能在 H1 之后。
  if (format === 'bold_kv') {
    const windowStr = content.slice(0, 4096);
    const re = /\*\*\s*(?:来源|原始链接|文档链接|original_link|Obj\s*Token|obj_token|document_id)[^\n]*\n(?:\*\*[^\n]*\n)*/i;
    const m = windowStr.match(re);
    if (!m) return null;
    const start = m.index;
    let end = start + m[0].length;
    if (end < content.length && content[end] === '\n') end++;
    return [start, end];
  }

  return null;
}

// ========== Migration core ==========

function migrateContent(content, format, newHeader) {
  const range = locateOldHeader(content, format);
  if (!range) return { ok: false, reason: 'locate-old-header-failed' };
  const start = range[0];
  const end = range[1];
  // 删除旧头块，保留其余正文（含 H1）
  const body = content.slice(0, start) + content.slice(end);
  // 新 yaml_html 头插到文件最前面（规范要求 + parseYamlHtmlHeader 锚定要求）
  return { ok: true, newContent: newHeader + body };
}

// ========== Main ==========

async function main() {
  const modeLabel = APPLY ? 'APPLY (写盘)' : 'DRY-RUN (只统计，不写盘)';
  console.log('========================================');
  console.log(' migrate-headers.cjs');
  console.log(' 模式: ' + modeLabel);
  console.log('========================================');

  if (DRY_RUN) {
    console.log('[info] 默认 dry-run 模式，不会修改任何文件。加 --apply 切换到写盘模式。');
  }

  // 加载模块
  let IndexScanner, LocalMapStore;
  try {
    const mods = await loadModules();
    IndexScanner = mods.IndexScanner;
    LocalMapStore = mods.LocalMapStore;
  } catch (e) {
    console.error('[fatal] ' + e.message);
    process.exit(1);
  }

  // 加载配置
  let kbRoot, watchedRootUrls;
  try {
    const cfg = loadConfig();
    kbRoot = cfg.kbRoot;
    watchedRootUrls = cfg.watchedRootUrls;
  } catch (e) {
    console.error('[fatal] ' + e.message);
    process.exit(1);
  }
  console.log('[info] kbRoot         = ' + kbRoot);
  console.log('[info] watchedRootUrls = ' + JSON.stringify(watchedRootUrls));

  if (!fs.existsSync(DB_PATH)) {
    console.error('[fatal] SQLite 数据库不存在: ' + DB_PATH);
    process.exit(1);
  }

  // 实例化 LocalMapStore（只读使用 getDocumentByObjToken）
  let localMapStore;
  try {
    localMapStore = new LocalMapStore(DB_PATH);
  } catch (e) {
    console.error('[fatal] LocalMapStore 初始化失败: ' + e.message);
    process.exit(1);
  }

  // 实例化 IndexScanner 仅为复用 parseMetadata（纯函数，不依赖 this 状态）
  // 依赖传 null —— 我们不会调用 indexFile / scanKnowledgeBase。
  const scanner = new IndexScanner({
    localMapStore: localMapStore,
    larkCliClient: null,
    config: { watchedRootUrls: watchedRootUrls },
  });

  // 收集 .md 文件
  const mdFiles = collectMarkdownFiles(kbRoot);
  console.log('[info] 扫描到 .md 文件: ' + mdFiles.length + ' 个');

  // 统计
  const stats = {
    scanned: mdFiles.length,
    alreadyYamlHtml: 0,
    noObjTokenSkipped: 0,
    backupExistsSkipped: 0,
    toMigrate: 0,
    migrated: 0,
    failed: 0,
  };
  const failures = [];        // { file, reason }
  const noObjTokenFiles = [];  // 用于报告
  const migratedFiles = [];    // 用于报告

  for (const mdPath of mdFiles) {
    let content;
    try {
      content = fs.readFileSync(mdPath, 'utf-8');
    } catch (e) {
      stats.failed++;
      failures.push({ file: mdPath, reason: '读取失败: ' + e.message });
      continue;
    }

    const parsed = scanner.parseMetadata(content);

    // 无可识别头 → 跳过（orphan，规范 §6.2 orphan_files 逻辑）
    if (!parsed) {
      stats.noObjTokenSkipped++;
      noObjTokenFiles.push(mdPath);
      continue;
    }

    // 已是 yaml_html → 跳过
    if (parsed.header_format === 'yaml_html') {
      stats.alreadyYamlHtml++;
      continue;
    }

    // 无 obj_token → 无归属凭证，跳过（orphan，红线 1）
    if (!parsed.obj_token) {
      stats.noObjTokenSkipped++;
      noObjTokenFiles.push(mdPath);
      continue;
    }

    // 到这里：非 yaml_html 且有 obj_token → 迁移候选
    stats.toMigrate++;

    const originalObjToken = parsed.obj_token;

    // 从 SQLite 取完整 meta（真相源）
    let record;
    try {
      record = localMapStore.getDocumentByObjToken(originalObjToken);
    } catch (e) {
      stats.failed++;
      failures.push({ file: mdPath, reason: 'SQLite 查询失败: ' + e.message });
      continue;
    }

    // 构造 meta + 生成新头
    const meta = resolveMeta(parsed, record, watchedRootUrls);
    const newHeader = generateYamlHtmlHeader(meta);

    // 迁移内容
    const migration = migrateContent(content, parsed.header_format, newHeader);
    if (!migration.ok) {
      stats.failed++;
      failures.push({
        file: mdPath,
        reason: '旧头定位失败 (format=' + parsed.header_format + ')',
      });
      continue;
    }
    const newContent = migration.newContent;

    // 断言：对新内容重新解析，确认 yaml_html + obj_token 严格一致（红线 7）
    const verify = scanner.parseMetadata(newContent);
    if (!verify || verify.header_format !== 'yaml_html') {
      stats.failed++;
      failures.push({
        file: mdPath,
        reason: '迁移后重解析非 yaml_html (got ' + (verify && verify.header_format) + ')',
      });
      continue;
    }
    if (verify.obj_token !== originalObjToken) {
      stats.failed++;
      failures.push({
        file: mdPath,
        reason: 'obj_token 断言失败: 原=' + originalObjToken + ' 新=' + verify.obj_token,
      });
      continue;
    }

    // dry-run 到此为止（不写盘）
    if (DRY_RUN) {
      stats.migrated++;
      migratedFiles.push(mdPath);
      continue;
    }

    // apply 模式：备份 + 写盘
    const backupPath = mdPath + '.pre-migrate';
    const backupExists = fs.existsSync(backupPath);
    if (backupExists) {
      // 备份已存在：保留最早的原始，不覆盖；但仍继续迁移当前文件
      stats.backupExistsSkipped++;
    }

    try {
      if (!backupExists) {
        fs.copyFileSync(mdPath, backupPath);
      }
      fs.writeFileSync(mdPath, newContent, 'utf-8');
      stats.migrated++;
      migratedFiles.push(mdPath);
    } catch (e) {
      stats.failed++;
      failures.push({
        file: mdPath,
        reason: '写盘失败: ' + e.message + ' (备份已创建: ' + !backupExists + ')',
      });
    }
  }

  // ========== Report ==========
  console.log('');
  console.log('========================================');
  console.log(' 迁移报告');
  console.log('========================================');
  console.log('  扫描 .md 文件总数      : ' + stats.scanned);
  console.log('  已是 yaml_html (跳过)  : ' + stats.alreadyYamlHtml);
  console.log('  无 obj_token (跳过)    : ' + stats.noObjTokenSkipped);
  console.log('  待迁移 (非 yaml_html)   : ' + stats.toMigrate);
  console.log('  迁移成功                : ' + stats.migrated);
  if (APPLY) {
    console.log('  备份已存在 (跳过备份)   : ' + stats.backupExistsSkipped);
  }
  console.log('  失败                    : ' + stats.failed);
  console.log('');

  if (failures.length > 0) {
    console.log('--- 失败详情 ---');
    for (const f of failures) {
      console.log('  ' + f.file);
      console.log('    原因: ' + f.reason);
    }
    console.log('');
  }

  if (DRY_RUN && stats.toMigrate > 0) {
    console.log('[next] 这是 dry-run 结果，未写盘。确认无误后执行:');
    console.log('         node scripts/migrate-headers.cjs --apply');
  }

  if (DRY_RUN && stats.toMigrate === 0 && stats.failed === 0) {
    console.log('[done] 无需迁移：所有有归属凭证的 .md 已是 yaml_html 格式。');
  }

  if (APPLY && stats.migrated > 0) {
    console.log('[done] 迁移完成。原文件备份为 .pre-migrate 后缀。');
    console.log('       建议随即运行同步工具触发 IndexScanner 重建，确认头识别正常。');
  }

  // 退出码：有失败 → 1；否则 0
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[fatal] 未捕获错误:', e);
  process.exit(1);
});
