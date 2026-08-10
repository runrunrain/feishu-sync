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
  files: [
    "package.json",
    "dist/**",
    "dist-electron/**",
    "server/package.json",
    "server/dist/**",
    "server/node_modules/**",
    "!server/src/**",
    "!server/__tests__/**",
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
    "**/*.node",
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
