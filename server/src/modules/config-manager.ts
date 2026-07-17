/**
 * ConfigManager - Manages application configuration
 *
 * Follows the revised config schema from 飞书认证架构专项设计:
 * - REMOVED: app_id, app_secret, feishuAuthRef, feishuSpaceId
 * - ADDED: larkCliPath (optional), requiredScopes
 *
 * v0.2.0 P3: LLM config migrated to channel-agnostic shape
 * (LlmConfig). Both channels (ClaudeCliChannel + DirectChannel) share
 * ONE provider config (default: bigmodel GLM). Legacy flat
 * `{ baseUrl, apiKey, model, temperature }` is auto-migrated on first
 * load. Sensible bigmodel defaults are derived from the local
 * ANTHROPIC_* env vars when present (open-box-usable on a machine that
 * already runs claude CLI), or fall back to bigmodel's public docs.
 *
 * Storage: ~/.feishu-sync/config.json (or userData path in desktop mode)
 *
 * SECURITY (decision 3 / B3 plan B): the bigmodel apiKey is stored in
 * PLAINTEXT. A prominent warning is written to the top of config.json
 * (as a JSON comment-style `_warning` field) to remind users not to
 * commit the file to a public repo. Encryption (keytar) is deferred to
 * a later iteration per architecture decision §5.4.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  Config,
  LayoutProfile,
  LegacyLLMConfig,
  LlmConfig,
  WatchedRootConfig,
} from '../types/index.js';
import { getEnabledWatchedRootUrls, isLegacyLlmConfig } from '../types/index.js';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.feishu-sync', 'config.json');
const DEFAULT_REQUIRED_SCOPES = [
  'wiki:node:retrieve',
  'wiki:space:retrieve',
  'docs:document:read',
  'sheets:spreadsheet:read',
  'docx:document:readonly',
  'drive:drive.metadata:readonly',
];

/**
 * Default bigmodel endpoints (decision 3 cognitive correction):
 *   - OpenAI-protocol: https://open.bigmodel.cn/api/paas/v4
 *   - Anthropic-protocol: https://open.bigmodel.cn/api/anthropic
 *
 * Default model is `glm-4-flash` (free tier) for the OpenAI-compat
 * endpoint; the Anthropic-compat endpoint accepts it too via claude
 * CLI's tier alias mapping (the env overrides set by ClaudeCliChannel
 * pin all tiers to LlmConfig.model).
 */
const DEFAULT_OPENAI_COMPAT_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
const DEFAULT_CLAUDE_COMPAT_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
/**
 * bigmodel dual-alias (P3 实测):
 *   - paas/v4 (OpenAI) accepts `glm-4-flash` (free tier)
 *   - /api/anthropic accepts `glm-5.2[1m]` (the alias claude code
 *     CLI uses on this machine)
 * The two aliases share ONE apiKey; only the model name differs across
 * the two protocol adapters. `DEFAULT_DIRECT_MODEL` is used as
 * `directModel` override when the user-provided `model` (or env) only
 * works on one endpoint.
 */
const DEFAULT_DIRECT_MODEL = 'glm-4-flash';
const DEFAULT_CLAUDE_CLI_MODEL = 'glm-5.2[1m]';
/**
 * Per-call LLM adaptation timeout, in milliseconds.
 *
 * 10 minutes gives bigmodel glm-5.2[1m] (the Anthropic-compat alias
 * used by the claude-cli primary channel) enough headroom to finish
 * under transient 529 over-load retries without making the user wait
 * unbounded. The previous hard-coded 60s value aborted the primary
 * channel too aggressively and forced a fall-back to DirectChannel.
 */
const DEFAULT_LLM_TIMEOUT_MS = 600_000;

/**
 * Set of known non-bigmodel OpenAI-compat base URLs whose providers do
 * NOT accept a bigmodel apiKey. When the persisted config still points
 * at one of these (a known P3 migration side-effect: legacy deepseek
 * `baseUrl` was carried over as `openAiCompatBaseUrl`) but the apiKey
 * has since been replaced with a bigmodel `<id>.<secret>` key, the
 * bigmodel paas/v4 endpoint MUST be substituted — otherwise DirectChannel
 * sends a bigmodel Bearer key to deepseek and gets 401.
 *
 * This list is intentionally narrow (exact host match on the known
 * legacy providers). Custom OpenAI-compat gateways are left untouched.
 */
const KNOWN_NON_BIGMODEL_OPENAI_HOSTS = new Set<string>([
  'api.deepseek.com',
  'api.openai.com',
]);

/**
 * Detect a bigmodel (zhipu) API key by its `<id>.<secret>` shape.
 *
 * Both segments are base62-ish (alphanumeric, no `sk-` prefix, no
 * underscores). bigmodel does not contract a stable segment length, so
 * the regex is intentionally permissive but anchored — the id segment
 * matches `[A-Za-z0-9]{6,64}` and the secret segment matches
 * `[A-Za-z0-9]{6,80}`. This keeps the detector from breaking on minor
 * future format tweaks while still rejecting OpenAI/Anthropic keys
 * (which typically start with `sk-` / `sk-ant-` and contain dashes).
 *
 * Reference: https://open.bigmodel.cn/dev/api#nosdk
 *
 * Exported for unit tests (config-manager.test.ts).
 */
export function looksLikeBigmodelKey(apiKey: string | undefined | null): boolean {
  if (!apiKey || typeof apiKey !== 'string') return false;
  // bigmodel keys are `<id>.<secret>` where both halves are alphanumeric
  // (no `sk-` prefix, no underscores); id matches {6,64}, secret {6,80}.
  return /^[A-Za-z0-9]{6,64}\.[A-Za-z0-9]{6,80}$/.test(apiKey);
}

/**
 * Returns true when host(u) is one of the known non-bigmodel OpenAI-compat
 * hosts (deepseek / openai.com) that must be replaced when paired with a
 * bigmodel apiKey. Unknown custom gateways are left as-is.
 */
function isKnownNonBigmodelOpenAiHost(url: string | undefined | null): boolean {
  if (!url || typeof url !== 'string') return false;
  try {
    const host = new URL(url).host.toLowerCase();
    return KNOWN_NON_BIGMODEL_OPENAI_HOSTS.has(host);
  } catch {
    return false;
  }
}

/**
 * Normalize the OpenAI-compat base URL for DirectChannel when the apiKey
 * is a bigmodel key but the URL still points at a non-bigmodel host
 * (deepseek / openai.com). This is the root-cause fix for the direct
 * channel 401 reported in the 2026-06-19 e2e-sync report: P3 migration
 * preserved the legacy deepseek `baseUrl` as `openAiCompatBaseUrl`, but
 * the persisted `apiKey` had already been swapped to a bigmodel key.
 *
 * Behavior:
 *   - bigmodel key + non-bigmodel host -> DEFAULT_OPENAI_COMPAT_BASE_URL
 *   - bigmodel key + (already) bigmodel host -> unchanged
 *   - non-bigmodel key -> unchanged (respect user's custom gateway)
 *
 * Exported for unit tests (config-manager.test.ts).
 */
export function reconcileOpenAiCompatBaseUrl(
  url: string | undefined | null,
  apiKey: string | undefined | null,
): string {
  if (looksLikeBigmodelKey(apiKey) && isKnownNonBigmodelOpenAiHost(url)) {
    return DEFAULT_OPENAI_COMPAT_BASE_URL;
  }
  return url || DEFAULT_OPENAI_COMPAT_BASE_URL;
}

/**
 * bigmodel keys do NOT support `deepseek-chat` / `deepseek-reasoner` /
 * generic OpenAI aliases on paas/v4. When the persisted `model` field
 * still carries a deepseek alias but the apiKey is bigmodel, reset it
 * to the Anthropic-adapter alias (the primary-channel default).
 *
 * Exported for unit tests (config-manager.test.ts).
 */
export function reconcileModelAlias(
  model: string | undefined | null,
  apiKey: string | undefined | null,
): string {
  if (!model) return DEFAULT_CLAUDE_CLI_MODEL;
  const deepseekAliases = ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'];
  if (
    looksLikeBigmodelKey(apiKey) &&
    deepseekAliases.includes(model.toLowerCase())
  ) {
    return DEFAULT_CLAUDE_CLI_MODEL;
  }
  return model;
}

/**
 * Build the default LLM config. Prefers local ANTHROPIC_* env vars
 * (open-box: if the machine already runs claude CLI, feishu-sync can
 * reuse the same credentials without re-prompting). Falls back to
 * empty apiKey (user must fill in via UI).
 *
 * When ANTHROPIC_BASE_URL is set, we infer the OpenAI-compat sibling
 * by replacing `/api/anthropic` with `/api/paas/v4`; this matches
 * bigmodel's published URL structure and keeps the dual endpoints
 * consistent if the user is on a non-bigmodel provider that exposes
 * the same dual-protocol pattern.
 */
function buildDefaultLlmConfig(): LlmConfig {
  const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_COMPAT_BASE_URL;
  const openAiBaseUrl = deriveOpenAiCompatBaseUrl(anthropicBaseUrl);
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const claudeModel = process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CLI_MODEL;

  return {
    openAiCompatBaseUrl: openAiBaseUrl,
    claudeCompatBaseUrl: anthropicBaseUrl,
    apiKey,
    // Default `model` is the Anthropic-adapter alias (since claude CLI
    // is the primary channel and this is what most users set first).
    // `directModel` overrides the OpenAI endpoint to the alias that
    // paas/v4 actually accepts.
    model: claudeModel,
    directModel: DEFAULT_DIRECT_MODEL,
    temperature: 0.2,
    // 10-minute default. See LlmConfig.timeoutMs rationale in
    // types/index.ts — the previous 60s ceiling was too tight for
    // bigmodel glm-5.2[1m] under load.
    timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
    claudeCli: {
      claudePath: undefined,
      extraArgs: [],
    },
    primaryChannel: 'claude-cli',
    fallbackOnFailure: true,
  };
}

/**
 * Derive the OpenAI-compat base URL from an Anthropic-compat base URL.
 *   https://open.bigmodel.cn/api/anthropic -> https://open.bigmodel.cn/api/paas/v4
 * For unknown providers, fall back to the input unchanged (the user
 * will fix it in the UI).
 */
function deriveOpenAiCompatBaseUrl(anthropicBaseUrl: string): string {
  if (!anthropicBaseUrl) return DEFAULT_OPENAI_COMPAT_BASE_URL;
  if (/\/api\/anthropic\/?$/i.test(anthropicBaseUrl)) {
    return anthropicBaseUrl.replace(/\/api\/anthropic\/?$/i, '/api/paas/v4');
  }
  return DEFAULT_OPENAI_COMPAT_BASE_URL;
}

const DEFAULT_CONFIG: Config = {
  llm: buildDefaultLlmConfig(),
  pollIntervalMinutes: 30,
  knowledgeBaseRoot: '',
  watchedRoots: [],
  watchedRootUrls: [],
  larkCliPath: undefined,
  requiredScopes: DEFAULT_REQUIRED_SCOPES,
  enableAutoStart: true,
  enableNotifications: true,
};

/**
 * One-time compatibility presets for the four roots already present in the
 * checked-in knowledge-base corpus. Runtime mapping must consume the saved
 * `watchedRoots` objects rather than this table. Unknown legacy URLs are
 * intentionally disabled and placed under a non-existent safe directory so
 * path planning cannot guess where to write.
 */
const LEGACY_ROOT_PRESETS: Record<string, Pick<WatchedRootConfig, 'localDir' | 'layoutProfile'>> = {
  Wramw1XxRihIgnkCrhqcdEbRnHb: {
    localDir: '策划 - Designer',
    layoutProfile: 'mirror-title-file',
  },
  QdZpwOmgBi25JVkAUmYcBiMinIf: {
    localDir: '技术 - Dev',
    layoutProfile: 'directory-readme',
  },
  NudewPkE9inlGhkEDA1c9FSsnkb: {
    localDir: '[必读] 研发规范',
    layoutProfile: 'directory-readme',
  },
  FEaww3vUHieIumk6FdIc92WHnyh: {
    localDir: '开发环境指引',
    layoutProfile: 'directory-readme',
  },
};

const VALID_LAYOUT_PROFILES = new Set<LayoutProfile>([
  'directory-readme',
  'mirror-title-file',
]);
const WINDOWS_RESERVED_SEGMENTS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const UNSAFE_PATH_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*]/;

interface CanonicalWatchedRootUrl {
  id: string;
  url: string;
}

/** Parse and canonicalize an HTTPS Feishu wiki root URL. */
export function canonicalizeWatchedRootUrl(value: unknown): CanonicalWatchedRootUrl | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (
      parsed.protocol !== 'https:'
      || !/\.feishu\.cn$/i.test(parsed.hostname)
      || parsed.port
      || parsed.username
      || parsed.password
    ) return null;
    const match = parsed.pathname.match(/^\/wiki\/([A-Za-z0-9]+)\/?$/);
    if (!match) return null;
    return {
      id: match[1],
      url: `${parsed.origin}/wiki/${match[1]}`,
    };
  } catch {
    return null;
  }
}

/** Validate a portable root-relative POSIX directory. */
export function normalizeWatchedRootLocalDir(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => (
    !segment
    || segment !== segment.trim()
    || segment === '.'
    || segment === '..'
    || segment.endsWith('.')
    || UNSAFE_PATH_SEGMENT_CHARS.test(segment)
    || WINDOWS_RESERVED_SEGMENTS.test(segment)
  ))) {
    return null;
  }
  return normalized;
}

/** Strictly normalize user-supplied structured root configuration. */
export function normalizeWatchedRootConfig(value: unknown): WatchedRootConfig {
  if (!value || typeof value !== 'object') {
    throw new Error('watchedRoot 必须是对象');
  }
  const candidate = value as Partial<WatchedRootConfig>;
  const canonical = canonicalizeWatchedRootUrl(candidate.url);
  if (!canonical) {
    throw new Error('watchedRoot.url 必须是规范的 https://<tenant>.feishu.cn/wiki/<token> 地址');
  }
  if (candidate.id !== canonical.id) {
    throw new Error('watchedRoot.id 必须等于 URL 中的 wiki 根 token');
  }
  const localDir = normalizeWatchedRootLocalDir(candidate.localDir);
  if (!localDir) {
    throw new Error('watchedRoot.localDir 必须是非空、不可越界的根相对 POSIX 路径');
  }
  if (!VALID_LAYOUT_PROFILES.has(candidate.layoutProfile as LayoutProfile)) {
    throw new Error('watchedRoot.layoutProfile 必须是 directory-readme 或 mirror-title-file');
  }
  if (typeof candidate.enabled !== 'boolean') {
    throw new Error('watchedRoot.enabled 必须是布尔值');
  }
  return {
    id: canonical.id,
    url: canonical.url,
    localDir,
    layoutProfile: candidate.layoutProfile as LayoutProfile,
    enabled: candidate.enabled,
  };
}

function normalizeWatchedRootList(value: unknown): WatchedRootConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('watchedRoots 必须是数组');
  }
  const roots = value.map((root) => normalizeWatchedRootConfig(root));
  const ids = new Set<string>();
  const urls = new Set<string>();
  for (const root of roots) {
    if (ids.has(root.id) || urls.has(root.url)) {
      throw new Error(`watchedRoots 存在重复根：${root.id}`);
    }
    ids.add(root.id);
    urls.add(root.url);
  }
  return roots;
}

function legacyWatchedRoot(url: unknown): WatchedRootConfig | null {
  const canonical = canonicalizeWatchedRootUrl(url);
  if (!canonical) return null;
  const preset = LEGACY_ROOT_PRESETS[canonical.id];
  if (preset) {
    return { ...canonical, ...preset, enabled: true };
  }
  return {
    ...canonical,
    localDir: `__unmapped__/${canonical.id}`,
    layoutProfile: 'directory-readme',
    enabled: false,
  };
}

function migrateLegacyWatchedRootUrls(value: unknown): WatchedRootConfig[] {
  if (!Array.isArray(value)) return [];
  const roots: WatchedRootConfig[] = [];
  const ids = new Set<string>();
  for (const url of value) {
    const root = legacyWatchedRoot(url);
    if (root && !ids.has(root.id)) {
      roots.push(root);
      ids.add(root.id);
    }
  }
  return roots;
}

/**
 * Visible-at-top-of-file security warning. Written into config.json
 * as a `_warning` field so any human opening the file sees it.
 */
const API_KEY_PLAINTEXT_WARNING =
  'SECURITY WARNING: this file contains a plaintext LLM API key under ' +
  '`llm.apiKey`. Do NOT commit this file to a public repository. ' +
  'Encryption (keytar) is on the roadmap; until then, treat the key ' +
  'with the same care as a password.';

export class ConfigManager {
  private configPath: string;
  private config: Config | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath || DEFAULT_CONFIG_PATH;
  }

  /**
   * Load configuration from file, or return defaults if file doesn't exist.
   * On load, runs the v0.2.0 migration that lifts legacy flat LLM
   * config into the new channel-aware shape and writes back the
   * upgraded config (plus the security warning).
   */
  async load(): Promise<Config> {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        const raw = JSON.parse(content) as Partial<Config> & { llm?: unknown };

        // Migration step 1: legacy flat LLM config -> LlmConfig.
        const migrated = this.migrateConfig(raw);
        this.config = migrated;

        // Migration step 2: if migration changed the shape, persist the
        // upgraded config (one-time write-back).
        if (migrated._migrated) {
          const { _migrated, ...persisted } = migrated;
          await this.save(persisted);
          console.info(
            '[ConfigManager] v0.2.0 LLM config migration applied and persisted.'
          );
        } else {
          console.info(`[ConfigManager] Loaded config from ${this.configPath}`);
        }
      } else {
        // Fresh install: derive defaults from env and persist.
        this.config = { ...DEFAULT_CONFIG };
        await this.save(this.config);
        console.info('[ConfigManager] Created default config');
      }
    } catch (error) {
      console.error('[ConfigManager] Failed to load config:', error);
      this.config = { ...DEFAULT_CONFIG };
    }

    return this.config!;
  }

  /**
   * Save configuration to file. Always writes the security warning as
   * a `_warning` field at the top of the JSON so users see it when
   * opening the file.
   */
  async save(config: Config): Promise<void> {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const watchedRoots = normalizeWatchedRootList(config.watchedRoots);
      // `watchedRootUrls` remains available to old in-memory callers for one
      // release, but new config files carry only the structured authority.
      const runtimeConfig: Config = {
        ...config,
        watchedRoots,
        watchedRootUrls: getEnabledWatchedRootUrls({ watchedRoots }),
      };
      const { watchedRootUrls: _legacyWatchedRootUrls, ...persistentConfig } = runtimeConfig;

      // SECURITY (decision 3 / B3 plan B): plaintext key + prominent
      // warning. The warning is a JSON field (not a real JSON comment,
      // which JSON does not support). Tools reading the file MUST
      // ignore unknown keys, per JSON spec.
      const withWarning = {
        _warning: API_KEY_PLAINTEXT_WARNING,
        ...persistentConfig,
      };

      fs.writeFileSync(this.configPath, JSON.stringify(withWarning, null, 2), 'utf-8');
      this.config = runtimeConfig;
      console.info(`[ConfigManager] Saved config to ${this.configPath}`);
    } catch (error) {
      console.error('[ConfigManager] Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Update LLM configuration. Accepts partial fields and merges with
   * the existing config.
   */
  async updateLLMConfig(llm: Partial<LlmConfig>): Promise<void> {
    const currentConfig = await this.load();
    const updatedLlm: LlmConfig = {
      ...currentConfig.llm,
      ...llm,
      // Nested merge for claudeCli sub-object.
      claudeCli: {
        ...(currentConfig.llm.claudeCli ?? {}),
        ...(llm.claudeCli ?? {}),
      },
    };
    const updatedConfig: Config = {
      ...currentConfig,
      llm: updatedLlm,
    };
    await this.save(updatedConfig);
  }

  /**
   * Apply a partial configuration update through the same normalization path
   * as load/save. This prevents HTTP callers from bypassing v5 root
   * validation with a shallow object merge.
   */
  async updateConfig(partial: Partial<Config>): Promise<Config> {
    const currentConfig = await this.load();
    const hasStructuredRoots = Object.prototype.hasOwnProperty.call(partial, 'watchedRoots');
    const hasLegacyUrls = Object.prototype.hasOwnProperty.call(partial, 'watchedRootUrls');

    let watchedRoots = currentConfig.watchedRoots;
    if (hasStructuredRoots) {
      watchedRoots = normalizeWatchedRootList(partial.watchedRoots);
    } else if (hasLegacyUrls) {
      watchedRoots = this.mergeLegacyWatchedRootUrls(
        currentConfig.watchedRoots,
        partial.watchedRootUrls,
      );
    }

    const updatedConfig: Config = {
      ...currentConfig,
      ...partial,
      watchedRoots,
      watchedRootUrls: getEnabledWatchedRootUrls({ watchedRoots }),
      llm: partial.llm
        ? {
            ...currentConfig.llm,
            ...partial.llm,
            claudeCli: {
              ...(currentConfig.llm.claudeCli ?? {}),
              ...(partial.llm.claudeCli ?? {}),
            },
          }
        : currentConfig.llm,
    };
    await this.save(updatedConfig);
    return this.config!;
  }

  /**
   * Update polling interval.
   */
  async updatePollInterval(minutes: number): Promise<void> {
    const currentConfig = await this.load();
    const updatedConfig = {
      ...currentConfig,
      pollIntervalMinutes: minutes,
    };
    await this.save(updatedConfig);
  }

  /**
   * Add a watched URL.
   */
  async addWatchedUrl(url: string): Promise<void> {
    const currentConfig = await this.load();
    const canonical = canonicalizeWatchedRootUrl(url);
    if (!canonical) {
      throw new Error('watchedRoot URL 无效');
    }
    if (!currentConfig.watchedRoots.some((root) => root.id === canonical.id)) {
      await this.updateConfig({
        watchedRootUrls: [...currentConfig.watchedRootUrls, canonical.url],
      });
    }
  }

  /**
   * Remove a watched URL.
   */
  async removeWatchedUrl(url: string): Promise<void> {
    const currentConfig = await this.load();
    const canonical = canonicalizeWatchedRootUrl(url);
    if (!canonical) return;
    await this.updateConfig({
      watchedRootUrls: currentConfig.watchedRootUrls.filter((item) => item !== canonical.url),
    });
  }

  /**
   * Get current config (cached).
   */
  getConfig(): Config | null {
    return this.config;
  }

  /**
   * Migrate a raw parsed config object into the v0.2.0 shape. Detects
   * the legacy flat LLM config (`{ baseUrl, apiKey, model, temperature }`)
   * and lifts it into `LlmConfig` with channel-control defaults.
   *
   * Returns the migrated config with a `_migrated: true` marker if a
   * write-back is required. Callers strip `_migrated` before saving.
   *
   * Self-independence (decision 3): when the legacy config has an
   * empty apiKey, we read ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL/
   * ANTHROPIC_MODEL from env to give open-box defaults (so the app
   * works immediately on a machine that already runs claude CLI).
   * If env is also empty, we leave apiKey blank and the user fills it
   * in via the UI later.
   */
  private migrateConfig(raw: Partial<Config> & { llm?: unknown }):
    Config & { _migrated?: boolean } {
    const llmRaw = raw.llm;
    let migrated = false;

    let llm: LlmConfig;
    if (isLegacyLlmConfig(llmRaw)) {
      llm = this.migrateLegacyLlmConfig(llmRaw);
      migrated = true;
    } else if (this.isPartialLlmConfig(llmRaw)) {
      // Already new shape but possibly missing fields; normalize.
      llm = this.normalizeLlmConfig(llmRaw as Partial<LlmConfig>);
      // Avoid rewriting config.json on every load once the normalized shape
      // has already been persisted. JSON property order is stable because
      // save() writes this normalized object verbatim.
      migrated = JSON.stringify(llm) !== JSON.stringify(llmRaw);
    } else {
      // No llm field at all (shouldn't happen in practice); use defaults.
      llm = buildDefaultLlmConfig();
      migrated = true;
    }

    let watchedRoots: WatchedRootConfig[];
    if (Array.isArray(raw.watchedRoots)) {
      const normalized = this.normalizeStoredWatchedRoots(raw.watchedRoots);
      watchedRoots = normalized.roots;
      // A short-lived transition build may have written an empty structured
      // array alongside an older URL list. Preserve URL-only roots that do
      // not already have a structured owner; otherwise a config upgrade
      // could silently drop an existing sync root. Structured entries win on
      // id collisions, and unknown legacy roots stay explicitly disabled.
      const legacyRoots = migrateLegacyWatchedRootUrls(raw.watchedRootUrls);
      const knownIds = new Set(watchedRoots.map((root) => root.id));
      for (const legacyRoot of legacyRoots) {
        if (!knownIds.has(legacyRoot.id)) {
          watchedRoots.push(legacyRoot);
          knownIds.add(legacyRoot.id);
        }
      }
      // A file containing both shapes is rewritten to the canonical P2
      // shape. Invalid stored entries are retained only as disabled,
      // explicitly-unmapped roots so no path is guessed on the user's behalf.
      migrated = migrated
        || normalized.hadInvalid
        || Object.prototype.hasOwnProperty.call(raw, 'watchedRootUrls');
    } else {
      watchedRoots = migrateLegacyWatchedRootUrls(raw.watchedRootUrls);
      migrated = migrated || Array.isArray(raw.watchedRootUrls);
    }

    const config: Config = {
      llm,
      pollIntervalMinutes: typeof raw.pollIntervalMinutes === 'number'
        ? raw.pollIntervalMinutes
        : DEFAULT_CONFIG.pollIntervalMinutes,
      knowledgeBaseRoot: typeof raw.knowledgeBaseRoot === 'string'
        ? raw.knowledgeBaseRoot
        : '',
      watchedRoots,
      // In-memory compatibility projection only; save() deliberately omits
      // this legacy field from the on-disk schema.
      watchedRootUrls: getEnabledWatchedRootUrls({ watchedRoots }),
      larkCliPath: typeof raw.larkCliPath === 'string' ? raw.larkCliPath : undefined,
      requiredScopes: Array.isArray(raw.requiredScopes) && raw.requiredScopes.length > 0
        ? raw.requiredScopes
        : DEFAULT_REQUIRED_SCOPES,
      enableAutoStart: typeof raw.enableAutoStart === 'boolean'
        ? raw.enableAutoStart
        : true,
      enableNotifications: typeof raw.enableNotifications === 'boolean'
        ? raw.enableNotifications
        : true,
    };

    return migrated ? { ...config, _migrated: true } : config;
  }

  /**
   * Load-time normalization is deliberately tolerant: corrupt or incomplete
   * stored roots become disabled `__unmapped__` records instead of causing
   * ConfigManager to discard the entire configuration file.
   */
  private normalizeStoredWatchedRoots(value: unknown[]): {
    roots: WatchedRootConfig[];
    hadInvalid: boolean;
  } {
    const roots: WatchedRootConfig[] = [];
    const ids = new Set<string>();
    let hadInvalid = false;
    for (const candidate of value) {
      try {
        const root = normalizeWatchedRootConfig(candidate);
        if (ids.has(root.id)) {
          hadInvalid = true;
          continue;
        }
        roots.push(root);
        ids.add(root.id);
      } catch {
        hadInvalid = true;
        const rawUrl = candidate && typeof candidate === 'object'
          ? (candidate as { url?: unknown }).url
          : undefined;
        const fallback = legacyWatchedRoot(rawUrl);
        if (fallback && !ids.has(fallback.id)) {
          roots.push({ ...fallback, enabled: false });
          ids.add(fallback.id);
        }
      }
    }
    return { roots, hadInvalid };
  }

  /** Convert legacy URL-only edits while preserving existing root layouts. */
  private mergeLegacyWatchedRootUrls(
    currentRoots: WatchedRootConfig[],
    value: unknown,
  ): WatchedRootConfig[] {
    if (!Array.isArray(value)) {
      throw new Error('watchedRootUrls 必须是数组');
    }
    const existingById = new Map(currentRoots.map((root) => [root.id, root]));
    const roots: WatchedRootConfig[] = [];
    const ids = new Set<string>();
    for (const rawUrl of value) {
      const canonical = canonicalizeWatchedRootUrl(rawUrl);
      if (!canonical) {
        throw new Error('watchedRootUrls 包含无效的飞书 wiki URL');
      }
      if (ids.has(canonical.id)) continue;
      const existing = existingById.get(canonical.id);
      roots.push(existing ? { ...existing, url: canonical.url } : legacyWatchedRoot(canonical.url)!);
      ids.add(canonical.id);
    }
    return roots;
  }

  /**
   * Lift a legacy flat `{ baseUrl, apiKey, model, temperature }` config
   * into the new `LlmConfig` shape with channel-control defaults.
   *
   * The legacy `baseUrl` was always an OpenAI-protocol URL (deepseek's
   * `https://api.deepseek.com`). We map it to `openAiCompatBaseUrl`.
   * `claudeCompatBaseUrl` defaults to the local ANTHROPIC_BASE_URL env
   * or bigmodel's default; the deepseek provider historically did not
   * expose an Anthropic adapter, so we do NOT try to infer one from
   * the legacy baseUrl.
   */
  private migrateLegacyLlmConfig(legacy: LegacyLLMConfig): LlmConfig {
    const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || DEFAULT_CLAUDE_COMPAT_BASE_URL;
    const apiKey = legacy.apiKey || process.env.ANTHROPIC_API_KEY || '';
    // Root-cause fix for 2026-06-19 e2e-sync direct 401: when the legacy
    // deepseek `baseUrl` is carried over but the apiKey is a bigmodel
    // key, force the OpenAI-compat endpoint to bigmodel paas/v4.
    // Otherwise deepseek receives a bigmodel Bearer key and returns 401.
    const legacyOpenAiBaseUrl = legacy.baseUrl || deriveOpenAiCompatBaseUrl(anthropicBaseUrl);
    const openAiBaseUrl = reconcileOpenAiCompatBaseUrl(legacyOpenAiBaseUrl, apiKey);
    // Same correction for the model alias: bigmodel paas/v4 does not
    // accept `deepseek-chat`; reset to the Anthropic-adapter alias.
    const legacyModel = legacy.model || process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CLI_MODEL;
    const claudeModel = reconcileModelAlias(legacyModel, apiKey);

    return {
      openAiCompatBaseUrl: openAiBaseUrl,
      claudeCompatBaseUrl: anthropicBaseUrl,
      apiKey,
      model: claudeModel,
      // Default the DirectChannel alias to bigmodel's free OpenAI
      // endpoint model. Users on a different provider can override via UI.
      directModel: DEFAULT_DIRECT_MODEL,
      temperature: typeof legacy.temperature === 'number' ? legacy.temperature : 0.2,
      // Legacy flat configs had no timeout field; surface the new 10-min
      // default so the timeout config knob is usable immediately after
      // migration.
      timeoutMs: DEFAULT_LLM_TIMEOUT_MS,
      claudeCli: {
        claudePath: undefined,
        extraArgs: [],
      },
      primaryChannel: 'claude-cli',
      fallbackOnFailure: true,
    };
  }

  /**
   * Normalize a partially-populated LlmConfig into a complete one,
   * filling missing fields with sensible defaults.
   */
  private normalizeLlmConfig(partial: Partial<LlmConfig>): LlmConfig {
    const base = buildDefaultLlmConfig();
    const apiKey = partial.apiKey ?? base.apiKey;
    // Root-cause fix for 2026-06-19 e2e-sync direct 401: persisted new-shape
    // configs may still carry the legacy deepseek `openAiCompatBaseUrl`
    // (P3 migration preserved it verbatim). When the apiKey is a bigmodel
    // key but the host is deepseek/openai, substitute bigmodel paas/v4.
    const rawOpenAiBaseUrl = partial.openAiCompatBaseUrl ?? base.openAiCompatBaseUrl;
    const rawModel = partial.model ?? base.model;
    return {
      openAiCompatBaseUrl: reconcileOpenAiCompatBaseUrl(rawOpenAiBaseUrl, apiKey),
      claudeCompatBaseUrl: partial.claudeCompatBaseUrl ?? base.claudeCompatBaseUrl,
      apiKey,
      model: reconcileModelAlias(rawModel, apiKey),
      directModel: partial.directModel ?? base.directModel,
      claudeCliModel: partial.claudeCliModel ?? base.claudeCliModel,
      temperature: typeof partial.temperature === 'number' ? partial.temperature : 0.2,
      // Persisted configs written before v0.2.0 sync-state-timeout-fix lack
      // this field. Fall back to the explicit default; preserve user-provided
      // values verbatim (including 0 / small numbers — the user set them on
      // purpose and the channel will clamp to a sane minimum at call time).
      timeoutMs: typeof partial.timeoutMs === 'number'
        ? partial.timeoutMs
        : DEFAULT_LLM_TIMEOUT_MS,
      claudeCli: {
        claudePath: partial.claudeCli?.claudePath ?? base.claudeCli?.claudePath,
        extraArgs: partial.claudeCli?.extraArgs ?? base.claudeCli?.extraArgs,
      },
      primaryChannel: partial.primaryChannel ?? 'claude-cli',
      fallbackOnFailure: typeof partial.fallbackOnFailure === 'boolean'
        ? partial.fallbackOnFailure
        : true,
    };
  }

  /**
   * Quick shape check: returns true if `value` looks like a (possibly
   * partial) new-shape LlmConfig. Used to decide whether to call
   * `normalizeLlmConfig`.
   */
  private isPartialLlmConfig(value: unknown): value is Partial<LlmConfig> {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return (
      typeof v.openAiCompatBaseUrl === 'string' ||
      typeof v.claudeCompatBaseUrl === 'string' ||
      typeof v.primaryChannel === 'string'
    );
  }
}
