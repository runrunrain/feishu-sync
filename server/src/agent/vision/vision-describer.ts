/**
 * VisionDescriber — 图片描述编排 + 内容寻址缓存（设计 §3.2，S2）
 *
 * 职责：读取本地图片 → magic bytes 嗅探 → sha256 内容寻址缓存查找 →
 * 未命中经 VisionChannel 远端描述 → 结果原子写缓存。供 S3 构建链
 * （preflight describeMany）与 S5 设置页（status / test API）消费。
 *
 * 契约：
 *   - 每张图片按内容哈希共用一份当前描述；旧版按模型区分的缓存仍可读取。
 *     记录保留模型和提示词版本，tmp+rename 原子写；缓存不自动淘汰。
 *   - 永不抛异常（文件/配置/网络错误一律落入 unavailable + reason）。
 *   - apiKey 绝不进日志/错误信息（VisionChannel 已脱敏，此处不额外打印）。
 *   - 非图片文件（magic bytes 不匹配）诚实报 unsupported_format。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readAgentPromptFile } from '../agent-assets.js';
import type { Config } from '../../types/index.js';
import { resolveProviderModel } from '../../modules/model-selection.js';
import type { LlmProtocol } from '../../types/index.js';
import type { AgentVisionConfig } from '../../types/agent-knowledge.js';
import { buildDefaultAgentVisionConfig } from '../../types/agent-knowledge.js';
import { VisionChannel, type VisionImageMime } from './vision-channel.js';

export type ImageUnavailableReason =
  | 'vision_unconfigured'
  | 'vision_failed'
  | 'too_large'
  | 'unsupported_format'
  | 'limit'
  | 'missing_file'
  | 'not_described';

export interface ImageDescription {
  src: string;
  imageHash: string;
  state: 'described' | 'cached' | 'unavailable';
  reason?: ImageUnavailableReason;
  text?: string;
  /** 调试用失败消息（已脱敏，不含 apiKey） */
  message?: string;
  /** 手动重新生成未完成，旧缓存仍然保留（如存在）。 */
  refreshFailure?: 'limit' | 'too_large' | 'vision_unconfigured' | 'vision_failed' | 'cache_write_failed';
}

export interface VisionStatus {
  state: 'disabled' | 'ready' | 'invalid';
  model: string | null;
  message: string;
}

export interface ResolvedVisionContext {
  providerId: string;
  /** provider 预设 id（传回 VisionChannel 的 ModelSelection） */
  presetId: string;
  /** provider 预设的 openAiModel 别名（远端调用与缓存 model 字段都用它） */
  modelAlias: string;
  modelKey: string;
  prompt: string;
  promptVersion: string;
  baseUrl: string;
  apiKey: string;
  protocol: LlmProtocol;
  maxTokens: number;
  timeoutMs: number;
  maxImageBytes: number;
  maxImagesPerBuild: number;
  concurrency: number;
}

export interface VisionDescriberDeps {
  dataRoot: string;
  /** 每次调用取最新配置（ConfigManager.load 是异步的；S3 传 () => configManager.load()） */
  config: () => Config | Promise<Config>;
}

/** prompt 资产缺失时的内置兜底（与 image-describe.md 语义一致，保证链路可用）。 */
const FALLBACK_IMAGE_PROMPT = [
  '# 图片理解任务',
  '',
  '请用中文对图片输出结构化描述，固定四段：「图类型」「内容概述」「文字内容」（逐条转写可读文字，保持原文）「上下文提示」（该图可能服务于文档中的什么场景）。只描述真实可见内容，不臆测。',
].join('\n');

/** magic bytes 嗅探（图片文件无扩展名，签名是唯一可信依据）。 */
export function sniffImageMime(bytes: Buffer): VisionImageMime | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF87a') return 'image/gif';
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** 旧缓存可能来自更高的单图上限；分块哈希以查找缓存，不加载整张大图。 */
function hashOversizedImage(file: string): string | null {
  const hardLimit = 20 * 1024 * 1024;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const digest = crypto.createHash('sha256');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      total += read;
      if (total > hardLimit) return null;
      digest.update(chunk.subarray(0, read));
    }
    return digest.digest('hex');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 关闭失败不影响缓存查询 */ }
  }
}

export function visionCacheRoot(dataRoot: string): string {
  return path.join(dataRoot, 'agent', 'vision-cache');
}

export function visionCacheFilePath(dataRoot: string, imageHash: string, modelKey: string): string {
  return path.join(visionCacheRoot(dataRoot), imageHash.slice(0, 2), `${imageHash}.${modelKey}.json`);
}

export function visionCurrentCacheFilePath(dataRoot: string, imageHash: string): string {
  return path.join(visionCacheRoot(dataRoot), imageHash.slice(0, 2), `${imageHash}.json`);
}

interface VisionCacheEntry {
  schemaVersion: 1;
  imageHash: string;
  modelKey: string;
  model: string;
  promptVersion: string;
  text: string;
  createdAt: string;
}

/** 解析 vision 配置为可执行上下文；disabled/无效返回 null（message 经由 status()）。 */
export function resolveVisionContext(config: Config): ResolvedVisionContext | null {
  const vision = config.agent?.vision ?? buildDefaultAgentVisionConfig();
  if (!vision.enabled) return null;
  const resolved = resolveProviderModel(config.llm, { providerId: vision.providerId, modelId: vision.modelId });
  if (!resolved || !resolved.apiKey) return null;
  const prompt = readAgentPromptFile('image-describe.md') ?? FALLBACK_IMAGE_PROMPT;
  const promptVersion = crypto.createHash('sha256').update(prompt, 'utf-8').digest('hex').slice(0, 8);
  const modelKey = crypto.createHash('sha256')
    .update(`${resolved.providerId}/${resolved.openAiModel}/${promptVersion}`, 'utf-8')
    .digest('hex').slice(0, 12);
  return {
    providerId: resolved.providerId,
    presetId: resolved.presetId,
    modelAlias: resolved.openAiModel,
    modelKey,
    prompt,
    promptVersion,
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    protocol: resolved.protocol,
    maxTokens: resolved.maxTokens ?? 8192,
    timeoutMs: vision.timeoutMs,
    maxImageBytes: vision.maxImageBytes,
    maxImagesPerBuild: vision.maxImagesPerBuild,
    concurrency: vision.concurrency,
  };
}

export class VisionDescriber {
  private readonly deps: VisionDescriberDeps;

  constructor(deps: VisionDescriberDeps) {
    this.deps = deps;
  }

  /** 通道状态：disabled（未启用）/ invalid（启用了但引用失效）/ ready。 */
  async status(): Promise<VisionStatus> {
    const config = await this.deps.config();
    const vision = config.agent?.vision ?? buildDefaultAgentVisionConfig();
    if (!vision.enabled) return { state: 'disabled', model: null, message: '图片理解未启用' };
    const providerId = vision.providerId ?? config.llm.activeProviderId;
    const provider = (config.llm.providers ?? []).find((p) => p.id === providerId);
    if (!provider || !provider.enabled) {
      return { state: 'invalid', model: null, message: `图片理解引用的服务提供商不存在或已停用（agent.vision.providerId）` };
    }
    if (!provider.apiKey.trim()) {
      return { state: 'invalid', model: null, message: '图片理解引用的服务提供商缺少 API Key' };
    }
    const context = resolveVisionContext(config);
    if (!context) {
      return { state: 'invalid', model: null, message: '图片理解引用的模型预设不存在或已停用（agent.vision.modelId）' };
    }
    return { state: 'ready', model: context.modelAlias, message: '' };
  }

  /** 只读缓存查找（不触发远端调用）；模型切换或服务未就绪不影响已有描述。 */
  async lookup(imageHash: string): Promise<string | null> {
    const entry = this.readCache(imageHash);
    return entry?.text ?? null;
  }

  /** 已缓存的不同图片数量（兼容旧版同图多模型条目）。 */
  async cachedCount(): Promise<number> {
    const root = visionCacheRoot(this.deps.dataRoot);
    const hashes = new Set<string>();
    let buckets: string[] = [];
    try {
      buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return 0;
    }
    for (const bucket of buckets) {
      try {
        for (const name of fs.readdirSync(path.join(root, bucket))) {
          const match = /^([0-9a-f]{64})(?:\.[0-9a-f]{12})?\.json$/.exec(name);
          if (match) hashes.add(match[1]);
        }
      } catch {
        /* 单桶读取失败不影响计数 */
      }
    }
    return hashes.size;
  }

  /** 单图：读文件 → 嗅探 → 缓存 → 远端。永不抛异常。 */
  async describeOne(file: string, src: string, signal?: AbortSignal): Promise<ImageDescription> {
    const config = await this.deps.config();
    const vision: AgentVisionConfig = config.agent?.vision ?? buildDefaultAgentVisionConfig();
    const unavailable = (reason: ImageUnavailableReason, message?: string): ImageDescription => ({
      src, imageHash: '', state: 'unavailable', reason, ...(message ? { message } : {}),
    });
    // R2-06：stat 先行——超限单图不读入内存即拒（读取后复核先保留作竞态兑底）
    const maxBytes = Math.min(vision.maxImageBytes, 20 * 1024 * 1024);
    let size = -1;
    try {
      size = fs.statSync(file).size;
    } catch {
      return unavailable('missing_file', `无法读取图片文件：${file}`);
    }
    if (size > maxBytes) {
      const imageHash = size <= 20 * 1024 * 1024 ? hashOversizedImage(file) : null;
      const cached = imageHash ? this.readCache(imageHash) : null;
      if (imageHash && cached) return { src, imageHash, state: 'cached', text: cached.text };
      return unavailable('too_large', `图片 ${size} 字节超出上限 ${vision.maxImageBytes}`);
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      return unavailable('missing_file', `无法读取图片文件：${file}`);
    }
    const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
    const mime = sniffImageMime(bytes);
    if (!mime) return { src, imageHash, state: 'unavailable', reason: 'unsupported_format' };
    const cached = this.readCache(imageHash);
    if (cached) return { src, imageHash, state: 'cached', text: cached.text };
    if (bytes.length > maxBytes) {
      return { src, imageHash, state: 'unavailable', reason: 'too_large', message: `图片 ${bytes.length} 字节超出上限 ${vision.maxImageBytes}` };
    }
    const context = await this.resolveContext();
    if (!context) return { src, imageHash, state: 'unavailable', reason: 'vision_unconfigured' };
    // VisionChannel 内部会按 selection 从 providers 重新解析 apiKey/baseUrl/protocol
    const channel = new VisionChannel(config.llm, { providerId: context.providerId, modelId: context.presetId });
    const result = await channel.describe(
      { bytes, mime, prompt: context.prompt },
      { timeoutMs: context.timeoutMs, signal },
    );
    if ((result.finishReason === 'stop' || result.finishReason === 'length') && typeof result.text === 'string' && result.text.trim()) {
      this.writeCache({ imageHash, modelKey: context.modelKey, model: context.modelAlias, promptVersion: context.promptVersion, text: result.text });
      return { src, imageHash, state: 'described', text: result.text };
    }
    return { src, imageHash, state: 'unavailable', reason: 'vision_failed', message: result.errorMessage || '图片识别未返回有效描述' };
  }

  /**
   * 批量：缓存命中不计 maxImagesPerBuild；未缓存超出配额的部分标 limit。
   *
   * 逐图读取并检查缓存，即使新识别配额已满也不遗漏后续缓存。
   * 同一图片内容在本批次只识别一次；只有配额内的图片字节进入队列，
   * 其余字节检查后立即释放，内存仍受 quota × maxImageBytes 约束。
   */
  async describeMany(
    items: Array<{ file: string; src: string }>,
    opts: { signal: AbortSignal; onProgress: (p: { done: number; total: number }) => void; refreshCached?: boolean },
  ): Promise<Map<string, ImageDescription>> {
    const results = new Map<string, ImageDescription>();
    const context = await this.resolveContext();
    const config = await this.deps.config();
    const vision: AgentVisionConfig = config.agent?.vision ?? buildDefaultAgentVisionConfig();
    let done = 0;
    const total = items.length;
    const progress = () => opts.onProgress({ done, total });
    const quota = Math.max(0, Math.min(vision.maxImagesPerBuild, 5000));
    const maxBytes = Math.min(vision.maxImageBytes, 20 * 1024 * 1024);

    // 第一遍：逐张检查本地文件和缓存；相同内容共用一个待识别任务。
    const pending: Array<{ sources: string[]; bytes: Buffer; imageHash: string; mime: VisionImageMime; cached: VisionCacheEntry | null }> = [];
    const pendingByHash = new Map<string, typeof pending[number]>();
    for (const item of items) {
      let size = -1;
      try {
        size = fs.statSync(item.file).size;
      } catch {
        results.set(item.src, { src: item.src, imageHash: '', state: 'unavailable', reason: 'missing_file' });
        done += 1;
        continue;
      }
      if (size > maxBytes) {
        const imageHash = size <= 20 * 1024 * 1024 ? hashOversizedImage(item.file) : null;
        const cached = imageHash ? this.readCache(imageHash) : null;
        results.set(item.src, imageHash && cached
          ? { src: item.src, imageHash, state: 'cached', text: cached.text, ...(opts.refreshCached ? { refreshFailure: 'too_large' as const } : {}) }
          : { src: item.src, imageHash: imageHash ?? '', state: 'unavailable', reason: 'too_large', message: `图片 ${size} 字节超出上限 ${vision.maxImageBytes}` });
        done += 1;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = fs.readFileSync(item.file);
      } catch {
        results.set(item.src, { src: item.src, imageHash: '', state: 'unavailable', reason: 'missing_file' });
        done += 1;
        continue;
      }
      const imageHash = crypto.createHash('sha256').update(bytes).digest('hex');
      const mime = sniffImageMime(bytes);
      if (!mime) {
        results.set(item.src, { src: item.src, imageHash, state: 'unavailable', reason: 'unsupported_format' });
        done += 1;
        continue;
      }
      const cached = this.readCache(imageHash);
      if (bytes.length > maxBytes) { // stat/读取竞态兑底
        results.set(item.src, cached
          ? { src: item.src, imageHash, state: 'cached', text: cached.text, ...(opts.refreshCached ? { refreshFailure: 'too_large' as const } : {}) }
          : { src: item.src, imageHash, state: 'unavailable', reason: 'too_large' });
        done += 1;
        continue;
      }
      if (cached && !opts.refreshCached) {
        results.set(item.src, { src: item.src, imageHash, state: 'cached', text: cached.text });
        done += 1;
        continue;
      }
      if (!context) {
        // 服务未就绪仍使用已有缓存，且不尝试重新识别。
        results.set(item.src, cached
          ? { src: item.src, imageHash, state: 'cached', text: cached.text, refreshFailure: 'vision_unconfigured' }
          : { src: item.src, imageHash, state: 'unavailable', reason: 'vision_unconfigured' });
        done += 1;
        continue;
      }
      const existing = pendingByHash.get(imageHash);
      if (existing) {
        existing.sources.push(item.src);
        continue;
      }
      if (pending.length >= quota) {
        results.set(item.src, cached
          ? { src: item.src, imageHash, state: 'cached', text: cached.text, refreshFailure: 'limit' }
          : { src: item.src, imageHash, state: 'unavailable', reason: 'limit' });
        done += 1;
        continue;
      }
      const task = { sources: [item.src], bytes, imageHash, mime, cached };
      pending.push(task);
      pendingByHash.set(imageHash, task);
    }
    progress();

    // 服务未就绪时已在第一遍复用缓存或标记 unavailable，无描述队列。
    if (!context) {
      return results;
    }

    const toDescribe = pending;

    // 并发受限的远端描述（worker pool）
    const concurrency = Math.max(1, Math.min(vision.concurrency, 8));
    let cursor = 0;
    const worker = async () => {
      while (cursor < toDescribe.length) {
        const item = toDescribe[cursor++];
        const result = opts.signal.aborted ? { finishReason: 'error', text: '', errorMessage: '图片识别已取消' } : await new VisionChannel(
          config.llm,
          { providerId: context.providerId, modelId: context.presetId },
        ).describe({ bytes: item.bytes, mime: item.mime, prompt: context.prompt }, { timeoutMs: context.timeoutMs, signal: opts.signal });
        const hasText = typeof result.text === 'string' && Boolean(result.text.trim());
        const success = !opts.signal.aborted && (result.finishReason === 'stop' || result.finishReason === 'length') && hasText;
        const saved = success && this.writeCache({ imageHash: item.imageHash, modelKey: context.modelKey, model: context.modelAlias, promptVersion: context.promptVersion, text: result.text });
        const message = result.errorMessage || (!success && !hasText ? '图片识别未返回有效描述' : undefined);
        for (const src of item.sources) {
          if (opts.refreshCached && item.cached && (!success || !saved)) {
            results.set(src, { src, imageHash: item.imageHash, state: 'cached', text: item.cached.text,
              refreshFailure: success ? 'cache_write_failed' : 'vision_failed', ...(message ? { message } : {}) });
          } else if (success) {
            results.set(src, { src, imageHash: item.imageHash, state: 'described', text: result.text,
              ...(opts.refreshCached && !saved ? { refreshFailure: 'cache_write_failed' as const } : {}) });
          } else {
            results.set(src, { src, imageHash: item.imageHash, state: 'unavailable', reason: 'vision_failed', message });
          }
        }
        done += item.sources.length;
        progress();
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, toDescribe.length) }, worker));
    return results;
  }

  private async resolveContext(): Promise<ResolvedVisionContext | null> {
    const config = await this.deps.config();
    return resolveVisionContext(config);
  }

  private readCache(imageHash: string): VisionCacheEntry | null {
    if (!/^[0-9a-f]{64}$/.test(imageHash)) return null;
    const readEntry = (file: string): VisionCacheEntry | null => {
      try {
        const entry = JSON.parse(fs.readFileSync(file, 'utf-8')) as VisionCacheEntry;
        return entry?.imageHash === imageHash && typeof entry.text === 'string' && entry.text.trim() ? entry : null;
      } catch {
        return null;
      }
    };
    const current = readEntry(visionCurrentCacheFilePath(this.deps.dataRoot, imageHash));
    if (current) return current;

    // 升级前可能同图有多种模型的结果，保留旧文件并使用最近生成的一条。
    try {
      const bucket = path.dirname(visionCurrentCacheFilePath(this.deps.dataRoot, imageHash));
      let latest: VisionCacheEntry | null = null;
      let latestTime = -Infinity;
      for (const name of fs.readdirSync(bucket).sort()) {
        if (!new RegExp(`^${imageHash}\\.[0-9a-f]{12}\\.json$`).test(name)) continue;
        const file = path.join(bucket, name);
        const entry = readEntry(file);
        if (!entry) continue;
        const createdAt = Date.parse(entry.createdAt);
        let time = createdAt;
        if (!Number.isFinite(time)) {
          try { time = fs.statSync(file).mtimeMs; } catch { continue; }
        }
        if (!latest || time > latestTime) { latest = entry; latestTime = time; }
      }
      return latest;
    } catch {
      return null;
    }
  }

  /** tmp+rename 原子写；失败静默（缓存不可用不阻断描述主链路）。 */
  private writeCache(entry: Omit<VisionCacheEntry, 'schemaVersion' | 'createdAt'>): boolean {
    const target = visionCurrentCacheFilePath(this.deps.dataRoot, entry.imageHash);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const record: VisionCacheEntry = { schemaVersion: 1, createdAt: new Date().toISOString(), ...entry };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
      return true;
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 清理失败忽略 */
      }
      return false;
    }
  }
}
