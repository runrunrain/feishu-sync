/**
 * ConfigManager migration reconcile tests (v0.2.0 direct-channel 401 fix).
 *
 * Covers the root-cause fix for the 2026-06-19 e2e-sync report:
 * persisted configs that still carried the legacy deepseek
 * `openAiCompatBaseUrl` after the P3 migration (because P3 preserved
 * legacy.baseUrl verbatim) produced a 401 when DirectChannel sent a
 * bigmodel Bearer key to the deepseek host.
 *
 * Strategy: pure-function unit tests on the exported reconcile helpers.
 * No fs, no real ConfigManager instance — just the decision logic.
 */

import { describe, it, expect } from 'vitest';
import {
  looksLikeBigmodelKey,
  reconcileOpenAiCompatBaseUrl,
  reconcileModelAlias,
} from '../src/modules/config-manager.js';

const BIGMODEL_KEY = '80ca91e556484dfb9126672d6fbaae8c.65LWXDL6NvRyb9RN';
const BIGMODEL_PAAS_V4 = 'https://open.bigmodel.cn/api/paas/v4';
const DEEPSEEK_URL = 'https://api.deepseek.com';

describe('looksLikeBigmodelKey', () => {
  it('accepts a real bigmodel <id>.<secret> key', () => {
    expect(looksLikeBigmodelKey(BIGMODEL_KEY)).toBe(true);
  });

  it('rejects OpenAI-style keys (sk- prefix, no dot)', () => {
    expect(looksLikeBigmodelKey('sk-proj-abcdef123456')).toBe(false);
  });

  it('rejects Anthropic-style keys (sk-ant- prefix)', () => {
    expect(looksLikeBigmodelKey('sk-ant-api03-xxxxxxxxxxxx')).toBe(false);
  });

  it('rejects empty / null / undefined', () => {
    expect(looksLikeBigmodelKey('')).toBe(false);
    expect(looksLikeBigmodelKey(null)).toBe(false);
    expect(looksLikeBigmodelKey(undefined)).toBe(false);
  });
});

describe('reconcileOpenAiCompatBaseUrl', () => {
  it('substitutes bigmodel paas/v4 when key is bigmodel but host is deepseek', () => {
    // This is the exact 2026-06-19 e2e-sync failure scenario.
    expect(reconcileOpenAiCompatBaseUrl(DEEPSEEK_URL, BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('substitutes bigmodel paas/v4 when key is bigmodel but host is openai.com', () => {
    expect(
      reconcileOpenAiCompatBaseUrl('https://api.openai.com', BIGMODEL_KEY),
    ).toBe(BIGMODEL_PAAS_V4);
  });

  it('leaves bigmodel host unchanged when key is bigmodel', () => {
    expect(reconcileOpenAiCompatBaseUrl(BIGMODEL_PAAS_V4, BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('leaves custom OpenAI-compat gateway unchanged (non-bigmodel key)', () => {
    // A user's self-hosted gateway with a non-bigmodel key must NOT be
    // silently rewritten — respect the user's config.
    expect(
      reconcileOpenAiCompatBaseUrl(
        'https://my-gateway.example.com/v1',
        'sk-proj-something',
      ),
    ).toBe('https://my-gateway.example.com/v1');
  });

  it('leaves custom gateway unchanged even with bigmodel key (unknown host)', () => {
    // Unknown host + bigmodel key: we do NOT assume the user misconfigured.
    // Only the known deepseek/openai.com hosts are auto-corrected.
    expect(
      reconcileOpenAiCompatBaseUrl(
        'https://my-proxy.example.com/v1',
        BIGMODEL_KEY,
      ),
    ).toBe('https://my-proxy.example.com/v1');
  });

  it('falls back to bigmodel default when url is empty', () => {
    expect(reconcileOpenAiCompatBaseUrl('', BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('falls back to bigmodel default when url is null', () => {
    expect(reconcileOpenAiCompatBaseUrl(null, BIGMODEL_KEY)).toBe(
      BIGMODEL_PAAS_V4,
    );
  });

  it('handles malformed url gracefully', () => {
    expect(reconcileOpenAiCompatBaseUrl('not-a-url', BIGMODEL_KEY)).toBe(
      'not-a-url',
    );
  });
});

describe('reconcileModelAlias', () => {
  it('resets deepseek-chat to bigmodel Anthropic alias when key is bigmodel', () => {
    expect(reconcileModelAlias('deepseek-chat', BIGMODEL_KEY)).toBe(
      'glm-5.2[1m]',
    );
  });

  it('resets deepseek-reasoner to bigmodel Anthropic alias when key is bigmodel', () => {
    expect(reconcileModelAlias('deepseek-reasoner', BIGMODEL_KEY)).toBe(
      'glm-5.2[1m]',
    );
  });

  it('leaves bigmodel alias unchanged when key is bigmodel', () => {
    expect(reconcileModelAlias('glm-5.2[1m]', BIGMODEL_KEY)).toBe('glm-5.2[1m]');
    expect(reconcileModelAlias('glm-4-flash', BIGMODEL_KEY)).toBe('glm-4-flash');
  });

  it('leaves deepseek-chat unchanged when key is NOT bigmodel (deepseek user)', () => {
    // A real deepseek user keeps deepseek-chat; we must not rewrite it.
    expect(reconcileModelAlias('deepseek-chat', 'sk-deepseek-xxx')).toBe(
      'deepseek-chat',
    );
  });

  it('defaults to bigmodel Anthropic alias when model is empty', () => {
    expect(reconcileModelAlias('', BIGMODEL_KEY)).toBe('glm-5.2[1m]');
    expect(reconcileModelAlias(null, BIGMODEL_KEY)).toBe('glm-5.2[1m]');
  });
});
