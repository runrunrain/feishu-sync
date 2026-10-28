/**
 * CliEndpoint — CLI 命令行访问端点（设计 kb-agent-upgrade §6.2）
 *
 * 职责：当设置中「命令行访问」（config.cli.enabled）开启时，
 * 生成与 desktop token 完全分离的独立 CLI 令牌，并把它随服务 URL
 * 一起发布到 `<dataRoot>/run/endpoint.json`（目录 0700 / 文件 0600，
 * tmp+rename 原子写），供 CLI 客户端（S9）发现与认证。
 *
 * 安全边界（§6.2）：令牌文件与明文 provider key 的 config.json 同属
 * 本用户信任域——同 uid 恶意进程两者皆可读，这是既有边界，不宣称更强；
 * 令牌阻断的是同机其他用户、浏览器页面（Origin 拒绝，见 cli-auth）与
 * DNS rebinding（回环 Host 校验）。
 *
 * revoke() 只在文件内 pid 与当前进程一致时删除文件（防多实例误删
 * 他人端点）；应用崩溃残留的陈旧文件由下次 publish 覆盖 + CLI 侧
 * app_not_reachable 语义兜底，不做启动时隐式清理。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 端点发现文件契约（S9 客户端按此解析；schemaVersion 前向兼容）。 */
export interface CliEndpointFile {
  schemaVersion: 1;
  /** 服务监听基址，如 http://127.0.0.1:3001。 */
  url: string;
  /** 发布该端点的进程 pid，revoke 依此判定所有权。 */
  pid: number;
  /** ISO 8601 发布时间。 */
  startedAt: string;
  /** 应用版本（server package.json version）。 */
  appVersion: string;
  /** 32 字节 base64url CLI 令牌。 */
  cliToken: string;
}

export interface CliEndpointOptions {
  /**
   * 是否已开启命令行访问。buildServer 注入 config 快照读取器；
   * 缺省恒 true 便于测试 / 独立使用（发布与否仍由 publish 调用方决定）。
   */
  enabledProvider?: () => boolean;
  /** 覆盖 appVersion（测试注入口）。 */
  appVersion?: string;
}

function readAppVersion(override?: string): string {
  if (override) return override;
  try {
    // server/package.json（同步读，模块加载一次即缓存于调用方）
    const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return String(JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '');
  } catch {
    return '';
  }
}

export class CliEndpoint {
  private readonly runDir: string;
  private readonly filePath: string;
  private readonly enabledProvider: () => boolean;
  private readonly appVersion: string;
  private token: string | null = null;
  private url: string | null = null;
  private publishedAt: string | null = null;

  constructor(dataRoot: string, options: CliEndpointOptions = {}) {
    this.runDir = path.join(dataRoot, 'run');
    this.filePath = path.join(this.runDir, 'endpoint.json');
    this.enabledProvider = options.enabledProvider ?? (() => true);
    this.appVersion = readAppVersion(options.appVersion);
  }

  /** 端点文件绝对路径（供 API 响应 / 测试断言）。 */
  get endpointFilePath(): string {
    return this.filePath;
  }

  /** 当前已知服务 URL（startServer 回填；null = 尚未监听）。 */
  getUrl(): string | null {
    return this.url;
  }

  /** 令牌是否处于已发布状态（内存态）。 */
  isPublished(): boolean {
    return this.token !== null && this.publishedAt !== null;
  }

  /**
   * startServer 在端口确定后调用：记录 URL 并在 cli.enabled 时发布端点。
   */
  onServerStarted(url: string): void {
    this.url = url;
    if (this.enabledProvider()) {
      this.publish(url);
    }
  }

  /**
   * 发布端点文件（生成令牌的幂等入口：未生成则生成，已生成则复用）。
   * 目录 0700、文件 0600、tmp+rename 原子写。
   */
  publish(url?: string): void {
    const effectiveUrl = url ?? this.url;
    if (!effectiveUrl) {
      throw new Error('CliEndpoint.publish: server URL 未确定（startServer 前不可发布）');
    }
    this.url = effectiveUrl;
    if (!this.token) {
      this.token = crypto.randomBytes(32).toString('base64url');
    }
    const payload: CliEndpointFile = {
      schemaVersion: 1,
      url: effectiveUrl,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      appVersion: this.appVersion,
      cliToken: this.token,
    };
    this.writeEndpointFile(payload);
    this.publishedAt = payload.startedAt;
  }

  /**
   * 撤销端点：内存令牌立即失效；磁盘文件仅在 pid 匹配（本进程发布的）
   * 时删除，避免误删并行实例的端点。幂等。
   */
  revoke(): void {
    this.token = null;
    this.publishedAt = null;
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<CliEndpointFile>;
      if (raw.pid === process.pid) {
        fs.rmSync(this.filePath, { force: true });
      }
      // pid 不匹配 → 他实例文件，保留（CLI 侧按 app_not_reachable 处理）。
    } catch {
      // 文件损坏/不可读：保守不删（无法证明所有权）。
    }
  }

  /**
   * 轮换令牌：仅在已开启且已发布状态下有效；重新生成令牌并重写文件。
   * 未发布时抛错（调用方应先校验 cli.enabled）。
   */
  rotate(): void {
    if (!this.isPublished()) {
      throw new Error('CliEndpoint.rotate: 端点未发布（命令行访问未开启）');
    }
    this.token = crypto.randomBytes(32).toString('base64url');
    this.publish(this.url ?? undefined);
  }

  /** timing-safe 令牌校验。 */
  verify(provided: string): boolean {
    if (!this.token) return false;
    const a = Buffer.from(provided, 'utf-8');
    const b = Buffer.from(this.token, 'utf-8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  private writeEndpointFile(payload: CliEndpointFile): void {
    fs.mkdirSync(this.runDir, { recursive: true, mode: 0o700 });
    // recursive mkdir 的 mode 只作用于新建层且受 umask 影响；显式 chmod
    // 保证已存在目录也收拢到 0700（对既有 run 目录的权限漂移兜底）。
    try {
      fs.chmodSync(this.runDir, 0o700);
    } catch {
      /* chmod 失败不阻断发布（目录可能由外部管理）；文件级 0600 仍强制 */
    }
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600); // writeFileSync mode 受 umask 影响，显式收拢
    fs.renameSync(tmpPath, this.filePath);
  }
}
