/**
 * CLI 命令行访问 DTO（S9，契约源 server/src/routes/cli-admin.ts）
 *
 * GET /api/cli/info 与 POST /api/cli/install-shim 的响应形状；开启/关闭/
 * 轮换走 S8 的 desktop-guarded 端点（POST /api/cli/enable、
 * /api/cli/token/rotate）。秘密边界：本 DTO 不含 cliToken（令牌只存在于
 * 0600 端点文件与请求头，永不经 renderer 展示）。
 */

export interface CliInfoDto {
  /** 命令行访问是否开启（config.cli.enabled）。 */
  enabled: boolean;
  /** endpoint.json 是否处于已发布状态（内存态）。 */
  endpointPublished: boolean;
  /** 端点文件绝对路径（展示用，不含令牌内容）。 */
  endpointFile: string;
  /** CLI 单文件打包产物是否存在（构建链产物）。 */
  cliAvailable: boolean;
  cliScript: string;
  /** shim 是否已安装（bin/feishu-sync 或 .cmd 任一存在）。 */
  shimInstalled: boolean;
  shimPath: string;
  /** 调起 CLI 的运行时（开发=当前 Node；打包=Electron RunAsNode）。 */
  command: string;
  args: string[];
  env: Record<string, string>;
  /** PATH 追加提示（不改用户 PATH，由用户自行决定）。 */
  pathHint: string;
}

export interface CliEnableResult {
  enabled: boolean;
  endpointFile: string;
  published: boolean;
}

export interface CliRotateResult {
  rotated: boolean;
  endpointFile: string;
}

export interface CliShimInstallResult {
  installed: boolean;
  shimPath: string;
  cmdPath: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  pathHint: string;
}
