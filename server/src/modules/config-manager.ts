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
  LegacyLLMConfig,
  LlmConfig,
} from '../types/index.js';
import { isLegacyLlmConfig } from '../types/index.js';

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
  watchedRootUrls: [],
  larkCliPath: undefined,
  requiredScopes: DEFAULT_REQUIRED_SCOPES,
  enableAutoStart: true,
  enableNotifications: true,
};

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

      // SECURITY (decision 3 / B3 plan B): plaintext key + prominent
      // warning. The warning is a JSON field (not a real JSON comment,
      // which JSON does not support). Tools reading the file MUST
      // ignore unknown keys, per JSON spec.
      const withWarning = {
        _warning: API_KEY_PLAINTEXT_WARNING,
        ...config,
      };

      fs.writeFileSync(this.configPath, JSON.stringify(withWarning, null, 2), 'utf-8');
      this.config = config;
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
    if (!currentConfig.watchedRootUrls.includes(url)) {
      const updatedConfig = {
        ...currentConfig,
        watchedRootUrls: [...currentConfig.watchedRootUrls, url],
      };
      await this.save(updatedConfig);
    }
  }

  /**
   * Remove a watched URL.
   */
  async removeWatchedUrl(url: string): Promise<void> {
    const currentConfig = await this.load();
    const updatedConfig = {
      ...currentConfig,
      watchedRootUrls: currentConfig.watchedRootUrls.filter((u) => u !== url),
    };
    await this.save(updatedConfig);
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
      migrated = true;
    } else {
      // No llm field at all (shouldn't happen in practice); use defaults.
      llm = buildDefaultLlmConfig();
      migrated = true;
    }

    const config: Config = {
      llm,
      pollIntervalMinutes: typeof raw.pollIntervalMinutes === 'number'
        ? raw.pollIntervalMinutes
        : DEFAULT_CONFIG.pollIntervalMinutes,
      knowledgeBaseRoot: typeof raw.knowledgeBaseRoot === 'string'
        ? raw.knowledgeBaseRoot
        : '',
      watchedRootUrls: Array.isArray(raw.watchedRootUrls)
        ? raw.watchedRootUrls
        : [],
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
    const openAiBaseUrl = legacy.baseUrl || deriveOpenAiCompatBaseUrl(anthropicBaseUrl);
    const apiKey = legacy.apiKey || process.env.ANTHROPIC_API_KEY || '';
    const claudeModel = legacy.model || process.env.ANTHROPIC_MODEL || DEFAULT_CLAUDE_CLI_MODEL;

    return {
      openAiCompatBaseUrl: openAiBaseUrl,
      claudeCompatBaseUrl: anthropicBaseUrl,
      apiKey,
      model: claudeModel,
      // Default the DirectChannel alias to bigmodel's free OpenAI
      // endpoint model. Users on a different provider can override via UI.
      directModel: DEFAULT_DIRECT_MODEL,
      temperature: typeof legacy.temperature === 'number' ? legacy.temperature : 0.2,
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
    return {
      openAiCompatBaseUrl: partial.openAiCompatBaseUrl ?? base.openAiCompatBaseUrl,
      claudeCompatBaseUrl: partial.claudeCompatBaseUrl ?? base.claudeCompatBaseUrl,
      apiKey: partial.apiKey ?? base.apiKey,
      model: partial.model ?? base.model,
      directModel: partial.directModel ?? base.directModel,
      claudeCliModel: partial.claudeCliModel ?? base.claudeCliModel,
      temperature: typeof partial.temperature === 'number' ? partial.temperature : 0.2,
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
