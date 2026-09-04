/**
 * Production-oriented full sync against the formal knowledge base:
 * index → detect all roots → dry-run → apply (confirmation=APPLY).
 *
 * The user's config file is an authority for their credentials and local
 * preferences. This script therefore has a deliberately narrow configuration
 * boundary:
 *
 * - a missing config is created safely once;
 * - an existing config is read without calling ConfigManager.load(), because
 *   that method may perform an unrelated migration write-back;
 * - the formal KB, its four roots and required scopes are merged in memory for
 *   this invocation only;
 * - --persist-config is the sole opt-in for changing an existing config, and
 *   uses a temp-file + rename write.
 *
 * Usage:
 *   npx tsx scripts/sync-latest.ts                         # dry-run only
 *   npx tsx scripts/sync-latest.ts --apply                 # real write
 *   npx tsx scripts/sync-latest.ts --apply --root designer
 *   npx tsx scripts/sync-latest.ts --persist-config         # explicit config migration
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChangeDetector } from '../src/modules/change-detector.js';
import type { ConfigManager } from '../src/modules/config-manager.js';
import { IndexScanner } from '../src/modules/index-scanner.js';
import { LarkCliClient } from '../src/modules/lark-cli-client.js';
import { LayoutReconstructor } from '../src/modules/layout-reconstructor.js';
import { LocalMapStore } from '../src/modules/local-map-store.js';
import { SnapshotService } from '../src/modules/snapshot-service.js';
import { SyncEngine } from '../src/modules/sync-engine.js';
import type {
  ChangedDocument,
  Config,
  PlannedSyncDocument,
  WatchedRootConfig,
} from '../src/types/index.js';

const DEFAULT_FORMAL_KB =
  '/Users/maorun/maorun-workpace/weixiao-database/飞书同步知识库';

export const REQUIRED_SCOPES = [
  'wiki:node:retrieve',
  'wiki:space:retrieve',
  'docs:document.content:read',
  'sheets:spreadsheet:read',
  'docx:document:readonly',
  'drive:drive.metadata:readonly',
  'docs:document.media:download',
  'slides:presentation:read',
  'offline_access',
] as const;

export const ALL_ROOTS: WatchedRootConfig[] = [
  {
    id: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/Wramw1XxRihIgnkCrhqcdEbRnHb',
    localDir: '策划 - Designer',
    layoutProfile: 'mirror-title-file',
    enabled: true,
  },
  {
    id: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/QdZpwOmgBi25JVkAUmYcBiMinIf',
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'NudewPkE9inlGhkEDA1c9FSsnkb',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/NudewPkE9inlGhkEDA1c9FSsnkb',
    localDir: '[必读] 研发规范',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
  {
    id: 'FEaww3vUHieIumk6FdIc92WHnyh',
    url: 'https://qcnbafdrjx7n.feishu.cn/wiki/FEaww3vUHieIumk6FdIc92WHnyh',
    localDir: '开发环境指引',
    layoutProfile: 'directory-readme',
    enabled: true,
  },
];

const ROOT_ALIASES: Record<string, string> = {
  designer: 'Wramw1XxRihIgnkCrhqcdEbRnHb',
  dev: 'QdZpwOmgBi25JVkAUmYcBiMinIf',
  spec: 'NudewPkE9inlGhkEDA1c9FSsnkb',
  guide: 'FEaww3vUHieIumk6FdIc92WHnyh',
};

const DEFAULT_LLM: Config['llm'] = {
  openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
  apiKey: '',
  model: 'glm-4-flash',
  temperature: 0.2,
  timeoutMs: 600_000,
  primaryChannel: 'claude-cli',
  fallbackOnFailure: true,
  claudeCli: { extraArgs: [] },
};

type JsonRecord = Record<string, unknown>;

export type SyncLatestRuntimeConfig = Config & JsonRecord & {
  operationManifestDir: string;
};

export interface SyncLatestArgs {
  apply: boolean;
  rootFilter: string | null;
  skipIndex: boolean;
  maxDocs: number;
  persistConfig: boolean;
  help: boolean;
}

export interface PrepareSyncLatestConfigOptions {
  configPath: string;
  operationsDir: string;
  formalKb: string;
  persistConfig?: boolean;
}

export interface PreparedSyncLatestConfig {
  config: SyncLatestRuntimeConfig;
  rawConfig: JsonRecord;
  created: boolean;
  persisted: boolean;
}

export interface WritablePlanSelection {
  writable: PlannedSyncDocument[];
  moves: PlannedSyncDocument[];
  blocked: PlannedSyncDocument[];
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : fallback;
}

function asPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function cloneFormalRoots(): WatchedRootConfig[] {
  return ALL_ROOTS.map((root) => ({ ...root }));
}

/**
 * Required scopes are additive. Existing valid entries keep their order and
 * any extra user scopes; missing formal-sync scopes are appended once.
 */
export function mergeRequiredScopes(value: unknown): string[] {
  const scopes = Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === 'string' && scope.trim().length > 0)
    : [];
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const scope of [...scopes, ...REQUIRED_SCOPES]) {
    if (!seen.has(scope)) {
      seen.add(scope);
      merged.push(scope);
    }
  }
  return merged;
}

/**
 * Normalize only the in-memory LLM view needed to satisfy Config's runtime
 * contract. The parsed user object is never mutated or written by this step,
 * and any unknown LLM keys remain on the runtime object as well.
 */
function buildRuntimeLlm(value: unknown): Config['llm'] {
  const raw = isRecord(value) ? value : {};
  const rawClaudeCli = isRecord(raw.claudeCli) ? raw.claudeCli : {};
  const legacyBaseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined;
  const primaryChannel = raw.primaryChannel === 'direct' || raw.primaryChannel === 'claude-cli'
    ? raw.primaryChannel
    : DEFAULT_LLM.primaryChannel;

  return {
    ...DEFAULT_LLM,
    ...raw,
    openAiCompatBaseUrl: asNonEmptyString(
      raw.openAiCompatBaseUrl,
      legacyBaseUrl || DEFAULT_LLM.openAiCompatBaseUrl,
    ),
    claudeCompatBaseUrl: asNonEmptyString(
      raw.claudeCompatBaseUrl,
      legacyBaseUrl || DEFAULT_LLM.claudeCompatBaseUrl,
    ),
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : DEFAULT_LLM.apiKey,
    model: asNonEmptyString(raw.model, DEFAULT_LLM.model),
    temperature: typeof raw.temperature === 'number' ? raw.temperature : DEFAULT_LLM.temperature,
    timeoutMs: asPositiveNumber(raw.timeoutMs, DEFAULT_LLM.timeoutMs ?? 600_000),
    primaryChannel,
    fallbackOnFailure: typeof raw.fallbackOnFailure === 'boolean'
      ? raw.fallbackOnFailure
      : DEFAULT_LLM.fallbackOnFailure,
    claudeCli: {
      ...(DEFAULT_LLM.claudeCli ?? {}),
      ...rawClaudeCli,
      extraArgs: Array.isArray(rawClaudeCli.extraArgs)
        ? rawClaudeCli.extraArgs.filter((arg): arg is string => typeof arg === 'string')
        : [...(DEFAULT_LLM.claudeCli?.extraArgs ?? [])],
    },
  } as Config['llm'];
}

/**
 * Runtime merge policy for this special-purpose formal-KB script:
 *
 * 1. formalKb always wins for this process;
 * 2. ALL_ROOTS is the exact sync authority for this process;
 * 3. required scopes are a stable additive union;
 * 4. LLM, optional settings and unknown user fields are retained in memory.
 *
 * This function intentionally has no filesystem side effect.
 */
export function mergeRuntimeConfig(
  rawConfig: JsonRecord,
  formalKb: string,
  operationsDir: string,
): SyncLatestRuntimeConfig {
  const runtimeRoots = cloneFormalRoots();
  return {
    ...rawConfig,
    llm: buildRuntimeLlm(rawConfig.llm),
    pollIntervalMinutes: asPositiveNumber(rawConfig.pollIntervalMinutes, 30),
    knowledgeBaseRoot: formalKb,
    watchedRoots: runtimeRoots,
    watchedRootUrls: runtimeRoots.map((root) => root.url),
    requiredScopes: mergeRequiredScopes(rawConfig.requiredScopes),
    enableAutoStart: typeof rawConfig.enableAutoStart === 'boolean'
      ? rawConfig.enableAutoStart
      : true,
    enableNotifications: typeof rawConfig.enableNotifications === 'boolean'
      ? rawConfig.enableNotifications
      : true,
    operationManifestDir: operationsDir,
  } as SyncLatestRuntimeConfig;
}

/** The initial on-disk config used only when no file exists yet. */
export function createDefaultConfig(formalKb: string): JsonRecord {
  return {
    _warning:
      'Contains secrets if apiKey filled. Do not commit. FEISHU_SYNC_HOME default ~/.feishu-sync',
    llm: {
      ...DEFAULT_LLM,
      claudeCli: { ...(DEFAULT_LLM.claudeCli ?? {}) },
    },
    pollIntervalMinutes: 30,
    knowledgeBaseRoot: formalKb,
    watchedRoots: cloneFormalRoots(),
    requiredScopes: [...REQUIRED_SCOPES],
    enableAutoStart: true,
    enableNotifications: true,
  };
}

function rootMatchesFormalId(value: unknown, id: string): boolean {
  if (!isRecord(value)) return false;
  if (value.id === id) return true;
  if (typeof value.url !== 'string') return false;
  try {
    const parts = new URL(value.url).pathname.split('/').filter(Boolean);
    return parts.length === 2 && parts[0] === 'wiki' && parts[1] === id;
  } catch {
    return false;
  }
}

/**
 * Persistent migration changes only formal-sync-owned keys. It keeps all
 * top-level unknown fields, the complete LLM object, unrelated roots, and
 * unknown fields on a matching root. Existing malformed/duplicate root items
 * are deliberately retained instead of being silently discarded.
 */
export function mergePersistedConfig(rawConfig: JsonRecord, formalKb: string): JsonRecord {
  const existingRoots = Array.isArray(rawConfig.watchedRoots)
    ? [...rawConfig.watchedRoots]
    : [];

  for (const formalRoot of ALL_ROOTS) {
    const existingIndex = existingRoots.findIndex((root) => rootMatchesFormalId(root, formalRoot.id));
    if (existingIndex >= 0 && isRecord(existingRoots[existingIndex])) {
      existingRoots[existingIndex] = {
        ...existingRoots[existingIndex],
        ...formalRoot,
      };
    } else {
      existingRoots.push({ ...formalRoot });
    }
  }

  return {
    ...rawConfig,
    knowledgeBaseRoot: formalKb,
    watchedRoots: existingRoots,
    requiredScopes: mergeRequiredScopes(rawConfig.requiredScopes),
  };
}

/**
 * Atomic JSON replacement for credentials-bearing configuration. A complete
 * temporary file is fsync'd and renamed into place; a failed write leaves the
 * original config untouched and removes its temporary sibling.
 */
export function writeJsonAtomically(configPath: string, payload: JsonRecord): void {
  const configDir = path.dirname(configPath);
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(
    configDir,
    `.${path.basename(configPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const serialized = `${JSON.stringify(payload, null, 2)}\n`;
  let descriptor: number | null = null;

  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, serialized, 'utf-8');
    fs.fsyncSync(descriptor);
    const completedDescriptor = descriptor;
    descriptor = null;
    fs.closeSync(completedDescriptor);
    fs.renameSync(tempPath, configPath);
  } finally {
    if (descriptor !== null) {
      fs.closeSync(descriptor);
    }
    if (fs.existsSync(tempPath)) {
      fs.unlinkSync(tempPath);
    }
  }
}

function readExistingConfig(configPath: string): JsonRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`无法读取现有配置 ${configPath}: ${detail}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`现有配置 ${configPath} 必须是 JSON 对象，已拒绝覆盖`);
  }
  return parsed;
}

/**
 * Prepare config storage and return an in-memory runtime merge. Existing files
 * are never written unless persistConfig is explicitly true. A missing config
 * is the only implicit creation case.
 */
export function prepareSyncLatestConfig(
  options: PrepareSyncLatestConfigOptions,
): PreparedSyncLatestConfig {
  const formalKb = path.resolve(options.formalKb);
  if (!fs.existsSync(formalKb) || !fs.statSync(formalKb).isDirectory()) {
    throw new Error(`知识库不存在或不是目录: ${formalKb}`);
  }

  fs.mkdirSync(path.dirname(options.configPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(options.operationsDir, { recursive: true, mode: 0o700 });

  let rawConfig: JsonRecord;
  let created = false;
  let persisted = false;
  if (!fs.existsSync(options.configPath)) {
    rawConfig = createDefaultConfig(formalKb);
    writeJsonAtomically(options.configPath, rawConfig);
    created = true;
    persisted = true;
  } else {
    rawConfig = readExistingConfig(options.configPath);
    if (options.persistConfig === true) {
      rawConfig = mergePersistedConfig(rawConfig, formalKb);
      writeJsonAtomically(options.configPath, rawConfig);
      persisted = true;
    }
  }

  return {
    config: mergeRuntimeConfig(rawConfig, formalKb, options.operationsDir),
    rawConfig,
    created,
    persisted,
  };
}

export function parseArgs(argv: string[]): SyncLatestArgs {
  let apply = false;
  let rootFilter: string | null = null;
  let skipIndex = false;
  let maxDocs = 0;
  let persistConfig = false;
  let help = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') apply = true;
    else if (arg === '--skip-index') skipIndex = true;
    else if (arg === '--persist-config') persistConfig = true;
    else if (arg === '--root') {
      const value = argv[++i];
      if (!value) throw new Error('--root 需要 designer|dev|spec|guide 或 root id');
      rootFilter = value;
    } else if (arg === '--max') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error('--max 必须是非负整数');
      }
      maxDocs = value;
    } else if (arg === '--help' || arg === '-h') {
      help = true;
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }
  return { apply, rootFilter, skipIndex, maxDocs, persistConfig, help };
}

function usage(): string {
  return [
    'Usage: sync-latest [--apply] [--root designer|dev|spec|guide|<id>] [--max N] [--skip-index] [--persist-config]',
    '  默认只合并运行时配置，不改写已有 config.json。',
    '  --persist-config 显式将正式 KB、四个 roots 和所需 scopes 原子写入现有 config.json。',
  ].join('\n');
}

export function selectRoots(filter: string | null): WatchedRootConfig[] {
  if (!filter) return cloneFormalRoots();
  const id = ROOT_ALIASES[filter] || filter;
  const found = ALL_ROOTS.filter((root) => root.id === id || root.localDir.includes(filter));
  if (found.length === 0) {
    throw new Error(`未知 root 过滤: ${filter}`);
  }
  return found.map((root) => ({ ...root }));
}

/**
 * A planned move is evidence for a separately reviewed migration, never an
 * ordinary sync write. Only create/replace documents may enter applyTokens.
 */
export function selectWritablePlans(
  plannedDocuments: PlannedSyncDocument[] | undefined,
): WritablePlanSelection {
  const writable: PlannedSyncDocument[] = [];
  const moves: PlannedSyncDocument[] = [];
  const blocked: PlannedSyncDocument[] = [];
  for (const plan of plannedDocuments ?? []) {
    if (plan.action === 'create' || plan.action === 'replace') {
      writable.push(plan);
    } else if (plan.action === 'move') {
      moves.push(plan);
    } else {
      blocked.push(plan);
    }
  }
  return { writable, moves, blocked };
}

function resolveRuntimePaths(): {
  formalKb: string;
  configDir: string;
  configPath: string;
  dbPath: string;
  operationsDir: string;
} {
  const formalKb = process.env.FORMAL_KB || DEFAULT_FORMAL_KB;
  const configDir = process.env.FEISHU_SYNC_HOME || path.join(os.homedir(), '.feishu-sync');
  return {
    formalKb,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    dbPath: path.join(configDir, 'feishu-sync.db'),
    operationsDir: path.join(configDir, 'operations'),
  };
}

/**
 * SnapshotService only consumes ConfigManager#getConfig(). Supplying a narrow
 * read-only view avoids ConfigManager.load(), whose migration behavior is not
 * appropriate for this script's default no-write configuration contract.
 */
function createSnapshotConfigView(config: Config): ConfigManager {
  return {
    getConfig: () => config,
  } as unknown as ConfigManager;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }

  const paths = resolveRuntimePaths();
  const prepared = prepareSyncLatestConfig({
    configPath: paths.configPath,
    operationsDir: paths.operationsDir,
    formalKb: paths.formalKb,
    persistConfig: args.persistConfig,
  });
  const config = prepared.config;

  console.info(`[sync-latest] config=${paths.configPath}`);
  console.info(`[sync-latest] kb=${config.knowledgeBaseRoot}`);
  console.info(`[sync-latest] db=${paths.dbPath}`);
  console.info(`[sync-latest] mode=${args.apply ? 'APPLY' : 'dry-run'}`);
  if (prepared.created) {
    console.info('[sync-latest] config created because it was missing');
  } else if (args.persistConfig) {
    console.info('[sync-latest] config migration persisted atomically by explicit flag');
  } else {
    console.info('[sync-latest] existing config kept on disk; formal settings are runtime-only');
  }

  const store = new LocalMapStore(paths.dbPath);
  store.initialize();

  const lark = new LarkCliClient({
    requiredScopes: config.requiredScopes,
    timeout: 120_000,
  });
  const auth = await lark.checkAuthReady();
  if (!auth.ready) {
    throw new Error(`鉴权未就绪: ${auth.error}`);
  }
  console.info('[sync-latest] auth ready');

  if (!args.skipIndex) {
    console.info('[sync-latest] indexing local knowledge base...');
    const scanner = new IndexScanner({
      localMapStore: store,
      larkCliClient: lark,
      config,
    });
    const indexResult = await scanner.scanKnowledgeBase(config.knowledgeBaseRoot);
    console.info(
      `[sync-latest] index: scanned=${indexResult.scanned} indexed=${indexResult.indexed} skipped=${indexResult.skipped} failed=${indexResult.failed}`,
    );
  }

  const roots = selectRoots(args.rootFilter);
  const detector = new ChangeDetector(lark, store);
  const allChanges: ChangedDocument[] = [];
  const detectSummary: Array<Record<string, unknown>> = [];

  for (const root of roots) {
    console.info(`[sync-latest] detect ${root.localDir} ...`);
    try {
      const result = await detector.detectChanges(root.url);
      const docs = result.changedDocuments.map((document) => ({
        ...document,
        watchedRootId: document.watchedRootId ?? root.id,
      }));
      allChanges.push(...docs);
      detectSummary.push({
        root: root.localDir,
        totalNodes: result.totalNodes,
        changed: docs.length,
        added: docs.filter((document) => document.changeType === 'added').length,
        modified: docs.filter((document) => document.changeType === 'modified').length,
        deleted: docs.filter((document) => document.changeType === 'deleted').length,
        traversalComplete: result.traversalComplete ?? null,
      });
      console.info(
        `[sync-latest]   nodes=${result.totalNodes} changed=${docs.length} complete=${result.traversalComplete}`,
      );
    } catch (error) {
      detectSummary.push({
        root: root.localDir,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`[sync-latest] detect failed for ${root.localDir}:`, error);
    }
  }

  // Deduplicate by objToken (last observation wins).
  const byToken = new Map<string, ChangedDocument>();
  for (const document of allChanges) {
    byToken.set(document.objToken, document);
  }
  let documents = [...byToken.values()].filter((document) => document.changeType !== 'deleted');

  // Enrich with SQLite mappings so PathResolver prefers existing files
  // (avoids "existing-file" blocks for already-indexed bodies).
  documents = documents.map((document) => {
    const record = store.getDocumentByObjToken(document.objToken);
    if (!record) return document;
    return {
      ...document,
      localMdPath: record.localMdPath || document.localMdPath,
      localRelPath: record.localRelPath || document.localRelPath || null,
      title: document.title || record.title,
      wikiNodeToken: document.wikiNodeToken ?? record.wikiNodeToken ?? null,
      watchedRootId: document.watchedRootId || record.watchedRootId || null,
    };
  });

  if (args.maxDocs > 0) {
    documents = documents.slice(0, args.maxDocs);
  }

  console.info(`[sync-latest] unique pending (non-delete)=${documents.length}`);
  for (const document of documents.slice(0, 30)) {
    console.info(
      `  - [${document.changeType}] ${document.objType} ${document.title} path=${document.localRelPath || document.localMdPath || '∅'} (${document.objToken.slice(0, 8)}…)`,
    );
  }
  if (documents.length > 30) console.info(`  … +${documents.length - 30} more`);

  const engine = new SyncEngine({
    larkCliClient: lark,
    localMapStore: store,
    config,
    layoutReconstructor: new LayoutReconstructor(),
  });

  // Always dry-run first for reviewability.
  console.info('[sync-latest] dry-run plan...');
  const dry = await engine.syncDocuments(documents, {
    enableLLM: false,
    fullSync: false,
  });
  const planSelection = selectWritablePlans(dry.plannedDocuments);
  const plannedOk = planSelection.writable;
  const plannedBlocked = planSelection.blocked;
  const plannedMoves = planSelection.moves;
  console.info(
    `[sync-latest] dry-run op=${dry.operationId} writable=${plannedOk.length} move=${plannedMoves.length} blocked=${plannedBlocked.length}`,
  );
  if (plannedMoves.length) {
    console.info('[sync-latest] planned moves are reported only; they are excluded from this apply');
    for (const move of plannedMoves.slice(0, 20)) {
      console.info(`  MOVE ${move.title}: ${move.plannedMoveFrom ?? 'unknown'} → ${move.localRelPath ?? move.localMdPath ?? 'unknown'}`);
    }
  }
  if (plannedBlocked.length) {
    const reasons = new Map<string, number>();
    for (const plan of plannedBlocked) {
      const key = (plan.reason || 'unknown').slice(0, 80);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    console.info('[sync-latest] blocked reasons:');
    for (const [reason, count] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.info(`  ${count}× ${reason}`);
    }
  }

  // P0 safety rule: ONLY create/replace plans may reach a normal apply.
  // A move requires a separate migration workflow and cannot be smuggled
  // through by sharing the same objToken with an otherwise writable plan.
  const applyTokens = new Set(plannedOk.map((plan) => plan.objToken));
  const toApply = documents.filter((document) => applyTokens.has(document.objToken));

  let applyResult = null;
  if (args.apply) {
    if (toApply.length === 0) {
      console.info('[sync-latest] nothing create/replace-safe to apply');
    } else {
      console.info(
        `[sync-latest] APPLY ${toApply.length} create/replace documents (skipped move ${plannedMoves.length}, blocked ${plannedBlocked.length})...`,
      );
      applyResult = await engine.syncDocuments(toApply, {
        enableLLM: false,
        fullSync: false,
        apply: true,
        confirmation: 'APPLY',
      });
      console.info(
        `[sync-latest] apply op=${applyResult.operationId} success=${applyResult.success} ok=${applyResult.syncedDocuments.length} fail=${applyResult.failedDocuments.length} duration=${applyResult.duration}ms`,
      );
      if (applyResult.failedDocuments.length) {
        for (const failed of applyResult.failedDocuments.slice(0, 20)) {
          console.error(`  FAIL ${failed.title}: ${failed.error}`);
        }
      }

      try {
        const scanner = new IndexScanner({
          localMapStore: store,
          larkCliClient: lark,
          config,
        });
        const snapshot = new SnapshotService(
          store,
          createSnapshotConfigView(config),
          scanner,
        );
        snapshot.generate();
        console.info('[sync-latest] _index.json refreshed');
      } catch (error) {
        console.warn('[sync-latest] snapshot refresh failed:', error);
      }
    }
  } else {
    console.info('[sync-latest] dry-run only. Re-run with --apply to write formal KB.');
  }

  const report = {
    at: new Date().toISOString(),
    formalKb: config.knowledgeBaseRoot,
    apply: args.apply,
    config: {
      created: prepared.created,
      persistedByExplicitFlag: args.persistConfig && !prepared.created,
      runtimeOnlyMerge: !prepared.created && !args.persistConfig,
    },
    detectSummary,
    pendingCount: documents.length,
    dryRun: {
      operationId: dry.operationId,
      success: dry.success,
      failed: dry.failedDocuments.length,
      writableCount: plannedOk.length,
      moveCount: plannedMoves.length,
      blockedCount: plannedBlocked.length,
      planned: dry.plannedDocuments?.map((plan) => ({
        title: plan.title,
        action: plan.action,
        path: plan.localRelPath ?? plan.localMdPath,
        reasonCode: plan.reasonCode ?? null,
        reason: plan.reason ?? null,
        watchedRootId: plan.watchedRootId ?? null,
        wikiNodeToken: plan.wikiNodeToken ?? null,
        parentChainTitles: plan.parentChainTitles ?? null,
        candidateLocalRelPath: plan.candidateLocalRelPath ?? null,
        suggestedResolution: plan.suggestedResolution ?? null,
        plannedMoveFrom: plan.plannedMoveFrom,
        pathSource: plan.pathSource ?? null,
      })),
    },
    applyResult: applyResult
      ? {
          operationId: applyResult.operationId,
          success: applyResult.success,
          synced: applyResult.syncedDocuments.map((synced) => ({
            title: synced.title,
            path: synced.localMdPath,
            size: synced.size,
            images: synced.imagesCount,
            sheets: synced.sheetsCount,
          })),
          failed: applyResult.failedDocuments,
          durationMs: applyResult.duration,
        }
      : null,
  };

  const reportPath = path.join(
    paths.operationsDir,
    `sync-latest-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
  );
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`[sync-latest] report ${reportPath}`);
  console.info(JSON.stringify({
    pending: documents.length,
    dryOp: dry.operationId,
    applyOp: applyResult?.operationId ?? null,
    applySuccess: applyResult?.success ?? null,
    synced: applyResult?.syncedDocuments.length ?? 0,
    failed: applyResult?.failedDocuments.length ?? 0,
  }, null, 2));

  if (args.apply && applyResult && !applyResult.success) {
    process.exitCode = 2;
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && path.resolve(entry) === fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error('[sync-latest] fatal:', error);
    process.exitCode = 1;
  });
}
