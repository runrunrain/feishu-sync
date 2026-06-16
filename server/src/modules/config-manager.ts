/**
 * ConfigManager - Manages application configuration
 *
 * Follows the revised config schema from 飞书认证架构专项设计:
 * - REMOVED: app_id, app_secret, feishuAuthRef, feishuSpaceId
 * - ADDED: larkCliPath (optional), requiredScopes
 *
 * Storage: ~/.feishu-sync/config.json (or userData path in desktop mode)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Config, LLMConfig } from '../types/index.js';

const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.feishu-sync', 'config.json');
const DEFAULT_REQUIRED_SCOPES = [
  'wiki:node:retrieve',
  'wiki:space:retrieve',
  'docs:document:read',
  'sheets:spreadsheet:read',
  'docx:document:readonly',
  'drive:drive.metadata:readonly',
];

const DEFAULT_LLM_CONFIG: LLMConfig = {
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-chat',
  temperature: 0.2,
};

const DEFAULT_CONFIG: Config = {
  llm: DEFAULT_LLM_CONFIG,
  pollIntervalMinutes: 30,
  knowledgeBaseRoot: '',
  watchedRootUrls: [],
  larkCliPath: undefined,
  requiredScopes: DEFAULT_REQUIRED_SCOPES,
  enableAutoStart: true,
  enableNotifications: true,
};

export class ConfigManager {
  private configPath: string;
  private config: Config | null = null;

  constructor(configPath?: string) {
    this.configPath = configPath || DEFAULT_CONFIG_PATH;
  }

  /**
   * Load configuration from file, or return defaults if file doesn't exist
   */
  async load(): Promise<Config> {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const content = fs.readFileSync(this.configPath, 'utf-8');
        this.config = JSON.parse(content) as Config;
        console.info(`[ConfigManager] Loaded config from ${this.configPath}`);
      } else {
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
   * Save configuration to file
   */
  async save(config: Config): Promise<void> {
    try {
      const configDir = path.dirname(this.configPath);
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      // Note: apiKey is stored in plaintext for now.
      // M4 will integrate keytar for encrypted storage.
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      this.config = config;
      console.info(`[ConfigManager] Saved config to ${this.configPath}`);
    } catch (error) {
      console.error('[ConfigManager] Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Update LLM configuration
   */
  async updateLLMConfig(llm: Partial<LLMConfig>): Promise<void> {
    const currentConfig = await this.load();
    const updatedConfig = {
      ...currentConfig,
      llm: { ...currentConfig.llm, ...llm },
    };
    await this.save(updatedConfig);
  }

  /**
   * Update polling interval
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
   * Add a watched URL
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
   * Remove a watched URL
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
   * Get current config (cached)
   */
  getConfig(): Config | null {
    return this.config;
  }
}
