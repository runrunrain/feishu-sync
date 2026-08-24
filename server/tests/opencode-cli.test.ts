/**
 * OpenCode integration boundary tests.
 *
 * These use a tiny local shell fixture, never a real OpenCode binary or model
 * provider. They verify the two properties that matter for packaged desktop
 * stability: PATH discovery works without a login shell, and raw document
 * content is kept out of the spawned command line.
 */

import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenCodeCliService } from '../src/modules/opencode-cli-service.js';
import {
  OpenCodeCliChannel,
  buildOpenCodeRuntimeSettings,
  parseOpenCodeRunOutput,
} from '../src/modules/opencode-cli-channel.js';
import type { LlmConfig } from '../src/modules/content-backend.js';

const tempRoots: string[] = [];

function makeFixture(commandBody: string): { root: string; executable: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-opencode-test-'));
  tempRoots.push(root);
  const executable = path.join(root, 'opencode');
  fs.writeFileSync(executable, `#!/bin/sh\n${commandBody}`, { mode: 0o755 });
  return { root, executable };
}

function llmConfig(): LlmConfig {
  return {
    openAiCompatBaseUrl: 'https://example.invalid/openai',
    claudeCompatBaseUrl: 'https://example.invalid/anthropic',
    apiKey: '',
    model: 'unused-by-opencode',
    temperature: 0.2,
    primaryChannel: 'opencode',
    fallbackOnFailure: false,
  };
}

afterEach(() => {
  while (tempRoots.length) {
    const root = tempRoots.pop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('OpenCode CLI discovery', () => {
  it('finds and version-verifies an executable on PATH without using a login shell', async () => {
    const { root } = makeFixture(`
if [ "$1" = "--version" ]; then
  echo "opencode 9.8.7"
  exit 0
fi
exit 1
`);
    const service = new OpenCodeCliService({
      env: { PATH: root, SHELL: '/does/not/exist' },
      platform: process.platform,
    });

    const status = await service.getStatus();

    expect(status.executable).toBe(true);
    expect(status.version).toBe('9.8.7');
    expect(status.source).toBe('path');
  });
});

describe('OpenCode local channel', () => {
  it('passes source via an attachment file, parses NDJSON, and returns markdown', async () => {
    const { executable } = makeFixture(`
if [ "$1" = "--version" ]; then
  echo "opencode 9.8.7"
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "RAW_DOCUMENT_MUST_NOT_BE_AN_ARG" ]; then
    echo "raw content leaked to argv" >&2
    exit 9
  fi
done
seen_prompt=0
for arg in "$@"; do
  case "$arg" in
    "你是本地 Markdown 文档整理助手。"*) seen_prompt=1 ;;
  esac
  if [ "$arg" = "--file" ] && [ "$seen_prompt" -ne 1 ]; then
    echo "prompt must be positioned before attachment flags" >&2
    exit 10
  fi
done
case "$OPENCODE_CONFIG_CONTENT" in
  *'"feishu-sync-runtime"'*'"npm":"@ai-sdk/openai-compatible"'*'"apiKey":"test-key"'*'"baseURL":"https://open.bigmodel.cn/api/paas/v4"'*'"models":{"glm-5.2"'*) ;;
  *) echo "missing scoped runtime provider configuration" >&2; exit 11 ;;
esac
printf '%s\\n' '{"type":"text","part":{"type":"text","text":"# 已整理\\n\\n正文"}}'
`);
    const config = {
      ...llmConfig(),
      apiKey: 'test-key',
      openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.2[1m]',
      providers: [{
        id: 'bigmodel',
        name: '智谱 GLM',
        enabled: true,
        apiKey: 'test-key',
        openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
        claudeCompatBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
        defaultModelId: 'default',
        models: [{ id: 'default', name: 'GLM 5.2', openAiModel: 'glm-5.2[1m]', claudeCliModel: 'glm-5.2[1m]', enabled: true }],
      }],
      activeProviderId: 'bigmodel',
      activeModelId: 'default',
    };
    const channel = new OpenCodeCliChannel(config, { executablePath: executable });

    const result = await channel.adapt({
      rawContent: 'RAW_DOCUMENT_MUST_NOT_BE_AN_ARG',
      localOldContent: '# 风格示例',
      options: { timeoutMs: 5_000 },
    });

    expect(result.finishReason).toBe('stop');
    expect(result.channelName).toBe('opencode');
    expect(result.adaptedMarkdown).toBe('# 已整理\n\n正文');
  });

  it('derives a complete scoped OpenAI-compatible overlay without exposing a saved key to local config', () => {
    const runtime = buildOpenCodeRuntimeSettings({
      ...llmConfig(),
      apiKey: 'test-key',
      openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-5.2[1m]',
    });
    expect(runtime.model).toBe('feishu-sync-runtime/glm-5.2');
    expect(runtime.configContent).toContain('"feishu-sync-runtime"');
    expect(runtime.configContent).toContain('"npm":"@ai-sdk/openai-compatible"');
    expect(runtime.configContent).toContain('"baseURL":"https://open.bigmodel.cn/api/paas/v4"');
    expect(runtime.configContent).toContain('"models":{"glm-5.2"');
  });

  it('uses OpenCode\'s native Zhipu Coding Plan provider for the coding endpoint', () => {
    const runtime = buildOpenCodeRuntimeSettings({
      ...llmConfig(),
      apiKey: 'test-key',
      openAiCompatBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
      model: 'glm-5.2[1m]',
    });

    expect(runtime.model).toBe('zhipuai-coding-plan/glm-5.2');
    expect(runtime.configContent).toContain('"model":"zhipuai-coding-plan/glm-5.2"');
    expect(runtime.configContent).not.toContain('"feishu-sync-runtime"');
    expect(runtime.env).toEqual({ ZHIPU_API_KEY: 'test-key' });
  });

  it('takes the final text event and surfaces an error event when no text exists', () => {
    expect(parseOpenCodeRunOutput([
      '{"type":"text","part":{"type":"text","text":"first"}}',
      '{"type":"text","part":{"type":"text","text":"final"}}',
    ].join('\n'))).toEqual({ markdown: 'final' });

    expect(parseOpenCodeRunOutput('{"type":"error","error":{"message":"provider unavailable"}}'))
      .toEqual({ markdown: null, error: 'provider unavailable' });

    expect(parseOpenCodeRunOutput(JSON.stringify({
      type: 'error',
      error: { name: 'UnknownError', data: { message: 'upstream unavailable' } },
    }))).toEqual({ markdown: null, error: 'upstream unavailable' });
  });
});
