/**
 * VisionDescriber 测试（S2，设计 §3.2）
 *
 * 临时 dataRoot + 本地回环 HTTP fixture（真实 SDK，不触外网、不 mock）：
 *   - describeOne：成功描述 → 缓存原子落盘；再次调用命中缓存不再触网
 *   - lookup / cachedCount 只读缓存
 *   - magic bytes 嗅探与 unsupported_format / too_large / missing_file
 *   - 未启用 → vision_unconfigured；服务端 5xx → vision_failed（不抛异常）
 *   - describeMany：cached+described 混合、进度回调、maxImagesPerBuild 配额
 *   - apiKey 绝不出现在任何输出
 */

import { afterAll, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Config } from '../src/types/index.js';
import { VisionDescriber, sniffImageMime, visionCacheFilePath, visionCurrentCacheFilePath } from '../src/agent/vision/vision-describer.js';
import { readAgentPromptFile } from '../src/agent/agent-assets.js';

const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const OTHER_PNG = Buffer.concat([TINY_PNG, Buffer.from([0x00, 0x01])]); // 字节不同 → 不同 hash；PNG 解析器忽略 IEND 后拖尾
const API_KEY = 'vision-fixture-key';

const servers: http.Server[] = [];
const tmpDirs: string[] = [];
afterAll(() => {
  for (const s of servers) s.close();
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 可直接计数的 fixture 句柄 */
async function fixtureWithCounter(mode: { fail?: boolean; empty?: boolean } = {}): Promise<{ port: number; count: () => number }> {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      calls += 1;
      if (mode.fail) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `server blew up for ${API_KEY}` } }));
        return;
      }
      const body = JSON.parse(raw || '{}');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'c', object: 'chat.completion', model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: mode.empty ? '   ' : `DESC(${calls})` }, finish_reason: 'stop' }],
        usage: { total_tokens: 10 },
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, count: () => calls };
}

function makeConfig(port: number, visionOverrides: Record<string, unknown> = {}, providerOverrides: Record<string, unknown> = {}): Config {
  return {
    llm: {
      temperature: 0.2, primaryChannel: 'direct', fallbackOnFailure: false,
      openAiCompatBaseUrl: '', apiKey: '', model: '',
      activeProviderId: 'vision-prov',
      providers: [{
        id: 'vision-prov', name: 'Vision Fixture', enabled: true, protocol: 'openai-completions',
        apiKey: API_KEY, openAiCompatBaseUrl: `http://127.0.0.1:${port}/v1`, defaultModelId: 'preset',
        models: [{ id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 2048 }],
        ...providerOverrides,
      }],
    },
    agent: {
      vision: {
        enabled: true, providerId: 'vision-prov', modelId: 'preset',
        concurrency: 2, maxImageBytes: 5 * 1024 * 1024, maxImagesPerBuild: 300, timeoutMs: 5000,
        ...visionOverrides,
      },
    },
  } as unknown as Config;
}

function newTmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-desc-'));
  tmpDirs.push(dir);
  return dir;
}

function writeImage(root: string, name: string, bytes: Buffer): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
}

describe('sniffImageMime（magic bytes）', () => {
  it('识别 png/jpeg/gif/webp，拒绝文本与其他二进制', () => {
    expect(sniffImageMime(TINY_PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageMime(Buffer.from('GIF89a\x01\x00'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('GIF87a\x01\x00'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('RIFF\x00\x00\x00\x00WEBPVP8 '))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('# markdown 不是图片'))).toBeNull();
    expect(sniffImageMime(Buffer.from(''))).toBeNull();
    // 伪 png：仅扩展名改变不了嗅探结果
    const fake = Buffer.from('这不是图片，尽管叫 png');
    expect(sniffImageMime(fake)).toBeNull();
  });
});

describe('VisionDescriber.describeOne + 缓存', () => {
  it('成功描述 → 缓存原子落盘 → 第二次调用命中缓存不再触网', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const config = makeConfig(fixture.port);
    const describer = new VisionDescriber({ dataRoot: root, config: () => config });
    const file = writeImage(root, 'a.png', TINY_PNG);

    const first = await describer.describeOne(file, 'images/01-a');
    expect(first.state).toBe('described');
    expect(first.text).toBe('DESC(1)');
    expect(first.imageHash).toBe(crypto.createHash('sha256').update(TINY_PNG).digest('hex'));
    expect(fixture.count()).toBe(1);

    // 缓存文件落盘：两级目录 + JSON 字段
    const cacheFile = visionCurrentCacheFilePath(root, first.imageHash);
    expect(fs.existsSync(cacheFile)).toBe(true);
    const entry = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    expect(entry.schemaVersion).toBe(1);
    expect(entry.model).toBe('vision-model');
    expect(entry.text).toBe('DESC(1)');
    expect(entry.imageHash).toBe(first.imageHash);
    expect(entry.modelKey).toMatch(/^[0-9a-f]{12}$/);
    expect(entry.promptVersion).toMatch(/^[0-9a-f]{8}$/);
    expect(typeof entry.createdAt).toBe('string');
    // apiKey 绝不进缓存
    expect(fs.readFileSync(cacheFile, 'utf-8')).not.toContain(API_KEY);

    const second = await describer.describeOne(file, 'images/01-a');
    expect(second.state).toBe('cached');
    expect(second.text).toBe('DESC(1)');
    expect(fixture.count()).toBe(1); // 未再触网

    // lookup：已缓存 hash 返回文本；未知 hash 返回 null
    expect(await describer.lookup(first.imageHash)).toBe('DESC(1)');
    expect(await describer.lookup('0'.repeat(64))).toBeNull();
    expect(await describer.cachedCount()).toBe(1);
  });

  it('切换识图模型仍复用已有缓存，主动重新生成后再切回也使用新结果', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    let config = makeConfig(fixture.port);
    const describer = new VisionDescriber({ dataRoot: root, config: () => config });
    const file = writeImage(root, 'a.png', TINY_PNG);
    const first = await describer.describeOne(file, 'images/01-a');
    expect(first.state).toBe('described');

    // 切换到 alt 模型仍复用既有结果，只有明确重新生成时才调用新模型。
    config = makeConfig(fixture.port, {}, {
      models: [
        { id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 2048 },
        { id: 'alt', name: 'Alt', enabled: true, openAiModel: 'vision-model-alt', contextWindow: 32000, maxTokens: 1024 },
      ],
    });
    config.agent.vision.modelId = 'alt';
    expect(await describer.describeOne(file, 'images/01-a')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(fixture.count()).toBe(1);
    const refreshed = await describer.describeMany([{ file, src: 'images/01-a' }],
      { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(refreshed.get('images/01-a')).toMatchObject({ state: 'described', text: 'DESC(2)' });
    config.agent.vision.modelId = 'preset';
    expect(await describer.describeOne(file, 'images/01-a')).toMatchObject({ state: 'cached', text: 'DESC(2)' });
    expect(await describer.lookup(first.imageHash)).toBe('DESC(2)');
    expect(fixture.count()).toBe(2);
    expect(await describer.cachedCount()).toBe(1);
  });

  it('兼容同图多模型的旧缓存并优先使用最新结果，重新生成后保留旧文件', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const config = makeConfig(fixture.port);
    const describer = new VisionDescriber({ dataRoot: root, config: () => config });
    const file = writeImage(root, 'legacy.png', TINY_PNG);
    const hash = crypto.createHash('sha256').update(TINY_PNG).digest('hex');
    const oldPath = visionCacheFilePath(root, hash, expectCacheKey(config));
    const recentPath = visionCacheFilePath(root, hash, '123456789abc');
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    const legacy = { schemaVersion: 1, imageHash: hash, modelKey: expectCacheKey(config), model: 'old', promptVersion: 'old', text: '旧结果', createdAt: '2026-01-01T00:00:00.000Z' };
    fs.writeFileSync(oldPath, JSON.stringify(legacy));
    fs.writeFileSync(recentPath, JSON.stringify({ ...legacy, modelKey: '123456789abc', text: '较新的结果', createdAt: '2026-02-01T00:00:00.000Z' }));
    expect(await describer.describeOne(file, 'legacy')).toMatchObject({ state: 'cached', text: '较新的结果' });
    expect(await describer.cachedCount()).toBe(1);
    const refreshed = await describer.describeMany([{ file, src: 'legacy' }],
      { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(refreshed.get('legacy')).toMatchObject({ state: 'described', text: 'DESC(1)' });
    expect(await describer.describeOne(file, 'legacy')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(fs.existsSync(oldPath)).toBe(true);
    expect(fs.existsSync(recentPath)).toBe(true);
    expect(await describer.cachedCount()).toBe(1);
  });

  it('识图未启用或配置无效时仍可复用缓存，重新生成时明确标记未完成', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    let config = makeConfig(fixture.port);
    const describer = new VisionDescriber({ dataRoot: root, config: () => config });
    const cached = writeImage(root, 'cached.png', TINY_PNG);
    const fresh = writeImage(root, 'fresh.png', OTHER_PNG);
    const hash = (await describer.describeOne(cached, 'cached')).imageHash;
    config = makeConfig(fixture.port, { enabled: false });
    expect(await describer.lookup(hash)).toBe('DESC(1)');
    const items = [{ file: cached, src: 'cached' }, { file: fresh, src: 'fresh' }];
    const normal = await describer.describeMany(items, { signal: new AbortController().signal, onProgress: () => {} });
    expect(normal.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(normal.get('fresh')).toMatchObject({ state: 'unavailable', reason: 'vision_unconfigured' });
    config = makeConfig(fixture.port, {}, { apiKey: '' });
    const refresh = await describer.describeMany(items, { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(refresh.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'vision_unconfigured' });
    expect(refresh.get('fresh')).toMatchObject({ state: 'unavailable', reason: 'vision_unconfigured' });
    expect(fixture.count()).toBe(1);
  });

  it('missing_file / unsupported_format / too_large / vision_unconfigured 均不触网不抛异常', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const missing = await new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) })
      .describeOne(path.join(root, 'nope.png'), 'images/missing');
    expect(missing.state).toBe('unavailable');
    expect(missing.reason).toBe('missing_file');

    const textFile = writeImage(root, 'note.md', Buffer.from('# 文本不是图片'));
    const unsupported = await new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) })
      .describeOne(textFile, 'images/fake');
    expect(unsupported.reason).toBe('unsupported_format');
    expect(unsupported.imageHash).toBe(crypto.createHash('sha256').update('# 文本不是图片').digest('hex'));

    const pngFile = writeImage(root, 'big.png', TINY_PNG);
    const tooLarge = await new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImageBytes: 8 }) })
      .describeOne(pngFile, 'images/big');
    expect(tooLarge.reason).toBe('too_large');

    const unconfigured = await new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { enabled: false }) })
      .describeOne(pngFile, 'images/a');
    expect(unconfigured.reason).toBe('vision_unconfigured');
    expect(fixture.count()).toBe(0);
  });

  it('服务端 5xx → vision_failed（错误消息脱敏 apiKey，不写缓存）', async () => {
    const fixture = await fixtureWithCounter({ fail: true });
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) });
    const file = writeImage(root, 'a.png', TINY_PNG);
    const result = await describer.describeOne(file, 'images/01-a');
    expect(result.state).toBe('unavailable');
    expect(result.reason).toBe('vision_failed');
    expect(result.message ?? '').not.toContain(API_KEY);
    expect(result.message ?? '').toContain('***');
    expect(fs.existsSync(path.join(root, 'agent', 'vision-cache'))).toBe(false);
  });

  it('status：disabled / ready / invalid（provider 停用、缺 key）', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const disabled = await new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { enabled: false }) }).status();
    expect(disabled.state).toBe('disabled');

    const ready = await new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) }).status();
    expect(ready.state).toBe('ready');
    expect(ready.model).toBe('vision-model');

    const providerGone = await new VisionDescriber({
      dataRoot: root,
      config: () => makeConfig(fixture.port, { providerId: 'ghost' }),
    }).status();
    expect(providerGone.state).toBe('invalid');

    const noKey = await new VisionDescriber({
      dataRoot: root,
      config: () => makeConfig(fixture.port, {}, { apiKey: '' }),
    }).status();
    expect(noKey.state).toBe('invalid');
  });
});

describe('VisionDescriber.describeMany', () => {
  it('cached + described 混合，进度回调单调收尾，缓存命中不占配额', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) });
    const fileA = writeImage(root, 'a.png', TINY_PNG);
    const fileB = writeImage(root, 'b.png', OTHER_PNG);
    // 预热 A 的缓存
    await describer.describeOne(fileA, 'images/a');

    const progress: Array<{ done: number; total: number }> = [];
    const results = await describer.describeMany(
      [
        { file: fileA, src: 'images/a' },
        { file: fileB, src: 'images/b' },
      ],
      { signal: new AbortController().signal, onProgress: (p) => progress.push({ ...p }) },
    );
    expect(results.get('images/a')?.state).toBe('cached');
    expect(results.get('images/b')?.state).toBe('described');
    expect(fixture.count()).toBe(2); // 预热 1 次 + describeMany 只补 B
    const dones = progress.map((p) => p.done);
    expect([...dones].sort((x, y) => x - y)).toEqual(dones);
    expect(progress.at(-1)).toEqual({ done: 2, total: 2 });
  });

  it('maxImagesPerBuild=0 → 未缓存全部标 limit，不触网', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImagesPerBuild: 0 }) });
    const fileA = writeImage(root, 'a.png', TINY_PNG);
    const results = await describer.describeMany([{ file: fileA, src: 'images/a' }], { signal: new AbortController().signal, onProgress: () => {} });
    expect(results.get('images/a')).toMatchObject({ state: 'unavailable', reason: 'limit' });
    expect(fixture.count()).toBe(0);
  });

  it('未启用 → 全部 vision_unconfigured', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { enabled: false }) });
    const fileA = writeImage(root, 'a.png', TINY_PNG);
    const results = await describer.describeMany([{ file: fileA, src: 'images/a' }], { signal: new AbortController().signal, onProgress: () => {} });
    expect(results.get('images/a')).toMatchObject({ state: 'unavailable', reason: 'vision_unconfigured' });
  });

  it('大量未缓存图只在配额内发起识别', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({
      dataRoot: root,
      config: () => makeConfig(fixture.port, { maxImagesPerBuild: 3, concurrency: 2 }),
    });
    // 10 张互不相同的合法 PNG（IEND 后拖尾被解析器忽略，字节不同即不同 hash）
    const files = Array.from({ length: 10 }, (_, index) =>
      writeImage(root, `img-${index}.png`, Buffer.concat([TINY_PNG, Buffer.from([index, 0x00, 0x01])])));
    const results = await describer.describeMany(
      files.map((file, index) => ({ file, src: `images/${index}` })),
      { signal: new AbortController().signal, onProgress: () => {} },
    );
    expect([...results.values()].filter((item) => item.state === 'described')).toHaveLength(3);
    expect([...results.values()].filter((item) => item.reason === 'limit')).toHaveLength(7);
    expect(fixture.count()).toBe(3);
  });

  it('新图配额用完后仍查找并复用后面的缓存，配额为零也可复用', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    let quota = 1;
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImagesPerBuild: quota }) });
    const cached = writeImage(root, 'cached.png', TINY_PNG);
    const fresh = writeImage(root, 'fresh.png', OTHER_PNG);
    const over = writeImage(root, 'over.png', Buffer.concat([TINY_PNG, Buffer.from([2])]));
    await describer.describeOne(cached, 'warm');
    const results = await describer.describeMany([
      { file: fresh, src: 'fresh' }, { file: over, src: 'over' }, { file: cached, src: 'cached' },
    ], { signal: new AbortController().signal, onProgress: () => {} });
    expect(results.get('fresh')?.state).toBe('described');
    expect(results.get('over')).toMatchObject({ state: 'unavailable', reason: 'limit' });
    expect(results.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(fixture.count()).toBe(2);
    quota = 0;
    const zero = await describer.describeMany([{ file: cached, src: 'cached' }, { file: over, src: 'over' }],
      { signal: new AbortController().signal, onProgress: () => {} });
    expect(zero.get('cached')?.state).toBe('cached');
    expect(zero.get('over')).toMatchObject({ state: 'unavailable', reason: 'limit' });
    expect(fixture.count()).toBe(2);
  });

  it('单图识别大小上限降低后仍能复用已有缓存', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    let maxImageBytes = 1024;
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImageBytes }) });
    const file = writeImage(root, 'cached.png', TINY_PNG);
    await describer.describeOne(file, 'cached');
    maxImageBytes = 8;
    expect(await describer.describeOne(file, 'cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    const normal = await describer.describeMany([{ file, src: 'cached' }],
      { signal: new AbortController().signal, onProgress: () => {} });
    expect(normal.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    const refresh = await describer.describeMany([{ file, src: 'cached' }],
      { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(refresh.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'too_large' });
    expect(fixture.count()).toBe(1);
  });

  it('同一图片被多个文档引用时只识别一次并只占一个配额', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImagesPerBuild: 1 }) });
    const a = writeImage(root, 'a.png', TINY_PNG);
    const same = writeImage(root, 'same.png', TINY_PNG);
    const other = writeImage(root, 'other.png', OTHER_PNG);
    const progress: number[] = [];
    const results = await describer.describeMany([
      { file: a, src: 'doc1::a' }, { file: same, src: 'doc2::same' }, { file: other, src: 'doc3::other' },
    ], { signal: new AbortController().signal, onProgress: ({ done }) => progress.push(done) });
    expect(results.get('doc1::a')).toMatchObject({ state: 'described', text: 'DESC(1)' });
    expect(results.get('doc2::same')).toMatchObject({ state: 'described', text: 'DESC(1)' });
    expect(results.get('doc3::other')).toMatchObject({ state: 'unavailable', reason: 'limit' });
    expect(fixture.count()).toBe(1);
    expect(progress.at(-1)).toBe(3);
  });

  it('手动重新生成后更新共享缓存，其他图片缓存不受影响', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) });
    const selected = writeImage(root, 'selected.png', TINY_PNG);
    const other = writeImage(root, 'other.png', OTHER_PNG);
    await describer.describeOne(selected, 'selected');
    await describer.describeOne(other, 'other');
    const results = await describer.describeMany([
      { file: selected, src: 'doc1::selected' }, { file: selected, src: 'doc2::selected' },
    ], { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(results.get('doc1::selected')).toMatchObject({ state: 'described', text: 'DESC(3)' });
    expect(results.get('doc2::selected')).toMatchObject({ state: 'described', text: 'DESC(3)' });
    expect(await describer.describeOne(selected, 'selected')).toMatchObject({ state: 'cached', text: 'DESC(3)' });
    expect(await describer.describeOne(other, 'other')).toMatchObject({ state: 'cached', text: 'DESC(2)' });
    expect(fixture.count()).toBe(3);
  });

  it('重新生成失败或达到上限时保留并复用旧缓存', async () => {
    const mode = { fail: false };
    const fixture = await fixtureWithCounter(mode);
    const root = newTmpRoot();
    let quota = 1;
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImagesPerBuild: quota }) });
    const cached = writeImage(root, 'cached.png', TINY_PNG);
    await describer.describeOne(cached, 'cached');
    mode.fail = true;
    const failed = await describer.describeMany([{ file: cached, src: 'cached' }],
      { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(failed.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'vision_failed' });
    quota = 0;
    const limited = await describer.describeMany([{ file: cached, src: 'cached' }],
      { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(limited.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'limit' });
    expect(await describer.describeOne(cached, 'cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(fixture.count()).toBe(2);
  });

  it('模型返回空描述时不覆盖旧缓存，也不将未缓存图片计为成功', async () => {
    const mode = { empty: false };
    const fixture = await fixtureWithCounter(mode);
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) });
    const cached = writeImage(root, 'cached.png', TINY_PNG);
    const fresh = writeImage(root, 'fresh.png', OTHER_PNG);
    await describer.describeOne(cached, 'cached');
    mode.empty = true;
    const results = await describer.describeMany([{ file: cached, src: 'cached' }, { file: fresh, src: 'fresh' }],
      { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
    expect(results.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'vision_failed' });
    expect(results.get('fresh')).toMatchObject({ state: 'unavailable', reason: 'vision_failed' });
    expect(await describer.describeOne(cached, 'cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(await describer.lookup(crypto.createHash('sha256').update(OTHER_PNG).digest('hex'))).toBeNull();
  });

  it('取消后不再发起图片识别并保留原有缓存', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) });
    const file = writeImage(root, 'cached.png', TINY_PNG);
    await describer.describeOne(file, 'cached');
    const controller = new AbortController(); controller.abort();
    const result = await describer.describeMany([{ file, src: 'cached' }],
      { signal: controller.signal, onProgress: () => {}, refreshCached: true });
    expect(result.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'vision_failed' });
    expect(await describer.describeOne(file, 'cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
    expect(fixture.count()).toBe(1);
  });

  it('重新生成的缓存写入失败时保留旧缓存', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port) });
    const file = writeImage(root, 'cached.png', TINY_PNG);
    await describer.describeOne(file, 'cached');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk failure'); });
    try {
      const result = await describer.describeMany([{ file, src: 'cached' }],
        { signal: new AbortController().signal, onProgress: () => {}, refreshCached: true });
      expect(result.get('cached')).toMatchObject({ state: 'cached', text: 'DESC(1)', refreshFailure: 'cache_write_failed' });
      expect(await describer.describeOne(file, 'cached')).toMatchObject({ state: 'cached', text: 'DESC(1)' });
      expect(fixture.count()).toBe(2);
    } finally { rename.mockRestore(); }
  });

  it('R2-06：stat 先行——超限单图不读入内存即拒（describeOne/describeMany 同口径）', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    // maxImageBytes=8：TINY_PNG（70B）超限，应被 stat 直接拒绝
    const describer = new VisionDescriber({ dataRoot: root, config: () => makeConfig(fixture.port, { maxImageBytes: 8 }) });
    const big = writeImage(root, 'big.png', TINY_PNG);
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const one = await describer.describeOne(big, 'images/big');
      expect(one.reason).toBe('too_large');
      const batch = await describer.describeMany([{ file: big, src: 'images/big2' }], { signal: new AbortController().signal, onProgress: () => {} });
      expect(batch.get('images/big2')?.reason).toBe('too_large');
      expect(readSpy.mock.calls.filter(([readPath]) => String(readPath).endsWith('big.png'))).toHaveLength(0);
      expect(fixture.count()).toBe(0);
    } finally {
      readSpy.mockRestore();
    }
  });
});

/** 按当前配置推导缓存 key（与实现同式，供断言缓存路径）。 */
function expectCacheKey(config: Config): string {
  const provider = config.llm.providers![0];
  const model = provider.models.find((m: any) => m.id === config.agent.vision.modelId) ?? provider.models[0];
  const prompt = readAgentPromptFile('image-describe.md') ?? '';
  const promptVersion = crypto.createHash('sha256').update(prompt, 'utf-8').digest('hex').slice(0, 8);
  return crypto.createHash('sha256').update(`${provider.id}/${model.openAiModel}/${promptVersion}`, 'utf-8').digest('hex').slice(0, 12);
}
