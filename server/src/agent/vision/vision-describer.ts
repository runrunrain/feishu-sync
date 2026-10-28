/**
 * VisionDescriber — 图片描述编排 + 内容寻址缓存（设计 §3.2，S2）
 *
 * 职责：读取本地图片 → magic bytes 嗅探 → sha256 内容寻址缓存查找 →
 * 未命中经 VisionChannel 远端描述 → 结果原子写缓存。供 S3 构建链
 * （preflight describeMany）与 S5 设置页（status / test API）消费。
 *
 * 契约：
 *   - 缓存目录 `<dataRoot>/agent/vision-cache/<hash[0:2]>/<imageHash>.<modelKey>.json`，
 *     modelKey = sha256(`${providerId}/${model}/${promptVersion}`)[0:12]，
 *     tmp+rename 原子写；v1 无淘汰（设计 §11 未知项）。
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

export function visionCacheRoot(dataRoot: string): string {
  return path.join(dataRoot, 'agent', 'vision-cache');
}

export function visionCacheFilePath(dataRoot: string, imageHash: string, modelKey: string): string {
  return path.join(visionCacheRoot(dataRoot), imageHash.slice(0, 2), `${imageHash}.${modelKey}.json`);
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

  /** 只读缓存查找（不触发远端调用）。未就绪 / 未命中返回 null。 */
  async lookup(imageHash: string): Promise<string | null> {
    const context = await this.resolveContext();
    if (!context) return null;
    const entry = this.readCache(imageHash, context.modelKey);
    return entry?.text ?? null;
  }

  /** 缓存条目总数（跨所有模型，供设置页展示）。 */
  async cachedCount(): Promise<number> {
    const root = visionCacheRoot(this.deps.dataRoot);
    let count = 0;
    let buckets: string[] = [];
    try {
      buckets = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    } catch {
      return 0;
    }
    for (const bucket of buckets) {
      try {
        count += fs.readdirSync(path.join(root, bucket)).filter((name) => name.endsWith('.json')).length;
      } catch {
        /* 单桶读取失败不影响计数 */
      }
    }
    return count;
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
    if (bytes.length > maxBytes) {
      return { src, imageHash, state: 'unavailable', reason: 'too_large', message: `图片 ${bytes.length} 字节超出上限 ${vision.maxImageBytes}` };
    }
    const context = await this.resolveContext();
    if (!context) return { src, imageHash, state: 'unavailable', reason: 'vision_unconfigured' };
    const cached = this.readCache(imageHash, context.modelKey);
    if (cached) return { src, imageHash, state: 'cached', text: cached.text };
    // VisionChannel 内部会按 selection 从 providers 重新解析 apiKey/baseUrl/protocol
    const channel = new VisionChannel(config.llm, { providerId: context.providerId, modelId: context.presetId });
    const result = await channel.describe(
      { bytes, mime, prompt: context.prompt },
      { timeoutMs: context.timeoutMs, signal },
    );
    if (result.finishReason === 'stop' || result.finishReason === 'length') {
      this.writeCache({ imageHash, modelKey: context.modelKey, model: context.modelAlias, promptVersion: context.promptVersion, text: result.text });
      return { src, imageHash, state: 'described', text: result.text };
    }
    return { src, imageHash, state: 'unavailable', reason: 'vision_failed', message: result.errorMessage };
  }

  /**
   * 批量：缓存命中不计 maxImagesPerBuild；未缓存超出配额的部分标 limit。
   *
   * R2-06：内存有界——先 stat 尺寸（超限单图不读即拒），逐图读取→哈希→
   * 查缓存（命中即释放字节，不保留）；仅配额内未缓存图保留 bytes 进入
   * 并发描述队列；配额截断后不再读取剩余文件（直接标 limit），在途字节
   * 上限 = quota × maxImageBytes，不随全工作集无界增长。
   */
  async describeMany(
    items: Array<{ file: string; src: string }>,
    opts: { signal: AbortSignal; onProgress: (p: { done: number; total: number }) => void },
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

    // 第一遍：本地检查（stat 尺寸/文件/格式/缓存）——不触网、不超配额读满
    const pending: Array<{ file: string; src: string; bytes: Buffer; imageHash: string; mime: VisionImageMime }> = [];
    for (const item of items) {
      // 配额已满：剩余未缓存图不再读文件（读到的字节也不保留），直接标 limit
      if (context && pending.length >= quota) {
        results.set(item.src, { src: item.src, imageHash: '', state: 'unavailable', reason: 'limit' });
        done += 1;
        continue;
      }
      let size = -1;
      try {
        size = fs.statSync(item.file).size;
      } catch {
        results.set(item.src, { src: item.src, imageHash: '', state: 'unavailable', reason: 'missing_file' });
        done += 1;
        continue;
      }
      if (size > maxBytes) {
        results.set(item.src, { src: item.src, imageHash: '', state: 'unavailable', reason: 'too_large', message: `图片 ${size} 字节超出上限 ${vision.maxImageBytes}` });
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
      if (bytes.length > maxBytes) { // stat/读取竞态兑底
        results.set(item.src, { src: item.src, imageHash, state: 'unavailable', reason: 'too_large' });
        done += 1;
        continue;
      }
      if (context) {
        const cached = this.readCache(imageHash, context.modelKey);
        if (cached) {
          // 命中即释放字节（不进 pending，不占配额）
          results.set(item.src, { src: item.src, imageHash, state: 'cached', text: cached.text });
          done += 1;
          continue;
        }
      } else {
        // 未启用：逐图分类但不保留字节（内存有界），全部 vision_unconfigured
        results.set(item.src, { src: item.src, imageHash, state: 'unavailable', reason: 'vision_unconfigured' });
        done += 1;
        continue;
      }
      pending.push({ file: item.file, src: item.src, bytes, imageHash, mime });
    }
    progress();

    // 未启用：第一遍已逐图标 vision_unconfigured（不保留字节），无描述队列
    if (!context) {
      return results;
    }

    const toDescribe = pending; // 已在第一遍截断至 quota 内

    // 并发受限的远端描述（worker pool）
    const concurrency = Math.max(1, Math.min(vision.concurrency, 8));
    let cursor = 0;
    const worker = async () => {
      while (cursor < toDescribe.length) {
        const item = toDescribe[cursor++];
        const result = await new VisionChannel(
          config.llm,
          { providerId: context.providerId, modelId: context.presetId },
        ).describe({ bytes: item.bytes, mime: item.mime, prompt: context.prompt }, { timeoutMs: context.timeoutMs, signal: opts.signal });
        if (result.finishReason === 'stop' || result.finishReason === 'length') {
          this.writeCache({ imageHash: item.imageHash, modelKey: context.modelKey, model: context.modelAlias, promptVersion: context.promptVersion, text: result.text });
          results.set(item.src, { src: item.src, imageHash: item.imageHash, state: 'described', text: result.text });
        } else {
          results.set(item.src, { src: item.src, imageHash: item.imageHash, state: 'unavailable', reason: 'vision_failed', message: result.errorMessage });
        }
        done += 1;
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

  private readCache(imageHash: string, modelKey: string): VisionCacheEntry | null {
    try {
      const raw = fs.readFileSync(visionCacheFilePath(this.deps.dataRoot, imageHash, modelKey), 'utf-8');
      const entry = JSON.parse(raw) as VisionCacheEntry;
      if (typeof entry?.text !== 'string') return null;
      return entry;
    } catch {
      return null;
    }
  }

  /** tmp+rename 原子写；失败静默（缓存不可用不阻断描述主链路）。 */
  private writeCache(entry: Omit<VisionCacheEntry, 'schemaVersion' | 'createdAt'>): void {
    const target = visionCacheFilePath(this.deps.dataRoot, entry.imageHash, entry.modelKey);
    const tmp = `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const record: VisionCacheEntry = { schemaVersion: 1, createdAt: new Date().toISOString(), ...entry };
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf-8');
      fs.renameSync(tmp, target);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 清理失败忽略 */
      }
    }
  }
}
