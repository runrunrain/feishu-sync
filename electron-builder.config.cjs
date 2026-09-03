const path = require("node:path");
const packageJson = require("./package.json");

const targetPlatform = process.env.DESKTOP_TARGET_PLATFORM;
const targetArch = process.env.DESKTOP_TARGET_ARCH;
const appDir = process.env.DESKTOP_APP_DIR;
const outputDir = process.env.DESKTOP_OUTPUT_DIR;
const macSigningMode = (process.env.DESKTOP_MAC_SIGNING || "adhoc").trim().toLowerCase();
const isMacRelease = targetPlatform === "darwin" && macSigningMode === "release";
const defaultRepository = "yourcompany/feishu-sync";
const repository = process.env.GITHUB_REPOSITORY || defaultRepository;
const [rawGithubOwner, rawGithubRepo] = repository.split("/");
const githubOwner = /^[A-Za-z0-9_.-]+$/.test(rawGithubOwner || "") ? rawGithubOwner : "yourcompany";
const githubRepo = /^[A-Za-z0-9_.-]+$/.test(rawGithubRepo || "") ? rawGithubRepo : "feishu-sync";

function normalizeUpdateFeedUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "https:") {
    throw new Error("DESKTOP_UPDATE_FEED_URL must use https://");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("DESKTOP_UPDATE_FEED_URL must not contain credentials, query strings or fragments");
  }
  return parsed.href.endsWith("/") ? parsed.href : `${parsed.href}/`;
}

function resolveUpdateFeedUrl() {
  const configuredFeedUrl = process.env.DESKTOP_UPDATE_FEED_URL?.trim();
  if (configuredFeedUrl) {
    return normalizeUpdateFeedUrl(configuredFeedUrl);
  }
  return normalizeUpdateFeedUrl(`https://github.com/${githubOwner}/${githubRepo}/releases/latest/download/`);
}

const updateFeedUrl = resolveUpdateFeedUrl();

if (!targetPlatform || !targetArch || !appDir || !outputDir) {
  throw new Error("DESKTOP_TARGET_PLATFORM, DESKTOP_TARGET_ARCH, DESKTOP_APP_DIR and DESKTOP_OUTPUT_DIR are required");
}

if (!["darwin", "win32"].includes(targetPlatform)) {
  throw new Error(`Unsupported DESKTOP_TARGET_PLATFORM: ${targetPlatform}`);
}

if (!["x64", "arm64"].includes(targetArch)) {
  throw new Error(`Unsupported DESKTOP_TARGET_ARCH: ${targetArch}`);
}

if (!["adhoc", "release"].includes(macSigningMode)) {
  throw new Error(`Unsupported DESKTOP_MAC_SIGNING: ${macSigningMode}. Expected "adhoc" or "release".`);
}

module.exports = {
  appId: "com.yourcompany.feishu-sync",
  productName: "Feishu Sync",
  forceCodeSigning: isMacRelease,
  directories: {
    app: path.resolve(appDir),
    output: path.resolve(outputDir),
    buildResources: "build",
  },
  compression: "maximum",
  files: [
    "package.json",
    "dist/**",
    "dist-electron/**",
    "server/package.json",
    "server/dist/**",
    "server/node_modules/**",
    "!node_modules/**",
    "!server/src/**",
    "!server/__tests__/**",
    "!server/tests/**",
    "!server/node_modules/better-sqlite3/deps/**",
    "!server/node_modules/better-sqlite3/src/**",
    "!server/node_modules/better-sqlite3/build/Release/obj/**",
    "!server/node_modules/better-sqlite3/build/Release/obj.target/**",
    "!server/node_modules/better-sqlite3/build/Release/*.a",
    "!server/node_modules/better-sqlite3/build/*.target.mk",
    "!server/node_modules/openai/src/**",
    "!server/node_modules/**/*.md",
    "!server/node_modules/**/*.d.ts",
    "!server/node_modules/**/*.d.ts.map",
    "!server/node_modules/**/*.js.map",
    "!server/node_modules/**/test/**",
    "!server/node_modules/**/tests/**",
    "!server/node_modules/**/example/**",
    "!server/node_modules/**/examples/**",
    "!server/node_modules/**/docs/**",
    "!**/.env",
    "!**/.env.*",
    "!**/*.map",
    "!src/**",
    "!release/**",
    "!dist-desktop/**",
  ],
  asar: true,
  asarUnpack: [
    "server/**",
  ],
  extraResources: [
    {
      from: path.resolve(__dirname, "build"),
      to: "build",
      filter: ["tray-icon.ico", "tray-iconTemplate.png"],
    },
  ],
  publish: [
    {
      provider: "generic",
      url: updateFeedUrl,
      // 2026-09 修复：mac 双架构自动更新馈送分离。electron-updater 在 macOS
      // 不按架构区分渠道文件（固定读 <channel>-mac.yml，且不携带 arch 后缀），
      // 双架构构建若共用 latest 通道，latest-mac.yml 会同名竞速上传，只有
      // 先到者的架构条目存活——另一架构的应用后续自动更新会拿到错误架构
      // 的安装包。arm64 改用 latest-arm64 通道（app-update.yml 烘焙进包，
      // 运行时读 latest-arm64-mac.yml）；x64 保持缺省 latest-mac.yml。Windows
      // 仅构建 x64，无冲突。Linux 渠道自带 arch 后缀，不受影响。
      ...(targetPlatform === "darwin" && targetArch === "arm64"
        ? { channel: "latest-arm64" }
        : {}),
    },
  ],
  npmRebuild: false,
  buildDependenciesFromSource: false,
  extraMetadata: {
    version: packageJson.version,
    main: "dist-electron/main.cjs",
  },
  mac: targetPlatform === "darwin" ? {
    target: [
      { target: "dmg", arch: [targetArch] },
      { target: "zip", arch: [targetArch] },
    ],
    category: "public.app-category.productivity",
    artifactName: "FeishuSync-${version}-${arch}.${ext}",
    electronLanguages: ["zh_CN", "zh_TW", "en"],
    // Local builds are fully ad-hoc signed so macOS sees one internally
    // consistent bundle instead of the partially signed Electron template.
    // Release builds let electron-builder select/import a Developer ID
    // Application certificate and are notarized when Apple credentials exist.
    identity: isMacRelease ? undefined : "-",
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize: isMacRelease ? undefined : false,
  } : undefined,
  dmg: {
    sign: isMacRelease,
  },
  win: targetPlatform === "win32" ? {
    target: [{ target: "nsis", arch: [targetArch] }],
    artifactName: "FeishuSync-Setup-${version}-${arch}.${ext}",
  } : undefined,
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  },
};
