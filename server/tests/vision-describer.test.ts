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
import { VisionDescriber, sniffImageMime, visionCacheFilePath } from '../src/agent/vision/vision-describer.js';
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
async function fixtureWithCounter(mode: { fail?: boolean } = {}): Promise<{ port: number; count: () => number }> {
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
        choices: [{ index: 0, message: { role: 'assistant', content: `DESC(${calls})` }, finish_reason: 'stop' }],
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
    const cacheFile = visionCacheFilePath(root, first.imageHash, expectCacheKey(config));
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

  it('缓存命中跨 modelKey 隔离：换模型后不读旧缓存', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    let config = makeConfig(fixture.port);
    const describer = new VisionDescriber({ dataRoot: root, config: () => config });
    const file = writeImage(root, 'a.png', TINY_PNG);
    const first = await describer.describeOne(file, 'images/01-a');
    expect(first.state).toBe('described');

    // 切换到 alt 模型（新 modelKey）→ 重新远端
    config = makeConfig(fixture.port, {}, {
      models: [
        { id: 'preset', name: 'Vision Preset', enabled: true, openAiModel: 'vision-model', contextWindow: 64000, maxTokens: 2048 },
        { id: 'alt', name: 'Alt', enabled: true, openAiModel: 'vision-model-alt', contextWindow: 32000, maxTokens: 1024 },
      ],
    });
    config.agent.vision.modelId = 'alt';
    const redescribed = await describer.describeOne(file, 'images/01-a');
    expect(redescribed.state).toBe('described');
    expect(fixture.count()).toBe(2);
    expect(await describer.cachedCount()).toBe(2); // 两个 modelKey 各一条
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

  it('R2-06：大量未缓存图 + 小配额 → 读取文件数 ≤ quota（quota 截断后不再读取剩余文件）', async () => {
    const fixture = await fixtureWithCounter();
    const root = newTmpRoot();
    const describer = new VisionDescriber({
      dataRoot: root,
      config: () => makeConfig(fixture.port, { maxImagesPerBuild: 3, concurrency: 2 }),
    });
    // 10 张互不相同的合法 PNG（IEND 后拖尾被解析器忽略，字节不同即不同 hash）
    const files = Array.from({ length: 10 }, (_, index) =>
      writeImage(root, `img-${index}.png`, Buffer.concat([TINY_PNG, Buffer.from([index, 0x00, 0x01])])));
    const readSpy = vi.spyOn(fs, 'readFileSync');
    try {
      const results = await describer.describeMany(
        files.map((file, index) => ({ file, src: `images/${index}` })),
        { signal: new AbortController().signal, onProgress: () => {} },
      );
      // 图片文件读取次数（排除缓存文件读取）≤ 配额 3：配额满后剩余文件不再读入内存
      const imageReads = readSpy.mock.calls
        .map(([readPath]) => String(readPath))
        .filter((readPath) => readPath.startsWith(root) && !readPath.includes('vision-cache'))
        .length;
      expect(imageReads).toBeLessThanOrEqual(3);
      expect([...results.values()].filter((item) => item.state === 'described')).toHaveLength(3);
      expect([...results.values()].filter((item) => item.reason === 'limit')).toHaveLength(7);
      expect(fixture.count()).toBe(3);
    } finally {
      readSpy.mockRestore();
    }
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
