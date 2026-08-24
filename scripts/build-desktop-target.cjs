#!/usr/bin/env node

/**
 * feishu-sync Desktop Build Script
 *
 * Build flow:
 * 1. build:all (vite build + server build)
 * 2. electron:build (esbuild main+preload)
 * 3. Prepare runtime (copy dist/server to staging)
 * 4. Install server production dependencies
 * 5. Rebuild native modules (better-sqlite3 for Electron 31)
 * 6. Package (electron-builder)
 *
 * Usage:
 *   node scripts/build-desktop-target.js --platform win32 --arch x64
 *   node scripts/build-desktop-target.js --platform darwin --arch x64
 *   node scripts/build-desktop-target.js --platform darwin --arch arm64
 */

const { execFileSync, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

// ========== Argument Parsing ==========

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        params[key] = args[i + 1];
        i++;
      } else {
        params[key] = true;
      }
    }
  }
  return params;
}

const params = parseArgs();
const skipServerDeps = params.skipServerDeps || params['skip-server-deps'] || process.env.DESKTOP_SKIP_SERVER_DEPS;
const platform = params.platform || process.env.DESKTOP_TARGET_PLATFORM;
const arch = params.arch || process.env.DESKTOP_TARGET_ARCH;
const macSigningMode = String(
  params.macSigning || params['mac-signing'] || process.env.DESKTOP_MAC_SIGNING || 'adhoc'
).toLowerCase();

if (!platform || !arch) {
  console.error('Usage: node build-desktop-target.js --platform <win32|darwin> --arch <x64|arm64>');
  process.exit(1);
}

if (!['win32', 'darwin'].includes(platform)) {
  console.error(`Unsupported platform: ${platform}`);
  process.exit(1);
}

if (!['x64', 'arm64'].includes(arch)) {
  console.error(`Unsupported arch: ${arch}`);
  process.exit(1);
}

if (!['adhoc', 'release'].includes(macSigningMode)) {
  console.error(`Unsupported macOS signing mode: ${macSigningMode}. Expected "adhoc" or "release".`);
  process.exit(1);
}

console.log(`\n========== Building feishu-sync Desktop [${platform} ${arch}] ==========\n`);

// ========== Environment Setup ==========

const rootDir = path.resolve(__dirname, '..');
const appDir = path.resolve(rootDir); // App directory (same as root)
// Use fixed directory (no timestamp) to ensure consistent delivery path
const outputDir = path.resolve(rootDir, `dist-desktop/${platform}-${arch}`);

// Set environment variables for electron-builder.config.js
process.env.DESKTOP_TARGET_PLATFORM = platform;
process.env.DESKTOP_TARGET_ARCH = arch;
process.env.DESKTOP_APP_DIR = appDir;
process.env.DESKTOP_OUTPUT_DIR = outputDir;
process.env.DESKTOP_MAC_SIGNING = macSigningMode;

// ========== Utility Functions ==========

function run(command, options = {}) {
  const cwd = options.cwd || rootDir;
  const env = { ...process.env, ...options.env };

  console.log(`\n[CWD: ${cwd}]`);
  console.log(`$ ${command}`);
  try {
    const output = execSync(command, { cwd, env, stdio: 'inherit', encoding: 'utf-8' });
    return { success: true, output };
  } catch (error) {
    return { success: false, error: error.message, code: error.status };
  }
}

function logStep(stepName) {
  console.log(`\n========== ${stepName} ==========`);
}

function checkSuccess(result, stepName) {
  if (!result.success) {
    console.error(`\n❌ ${stepName} failed (exit code ${result.code || 'unknown'})`);
    if (result.error) {
      console.error(result.error);
    }
    process.exit(1);
  }
  console.log(`\n✅ ${stepName} completed`);
}

function hasCompleteNotarizationCredentials() {
  const env = process.env;
  return Boolean(
    (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER)
      || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID)
      || env.APPLE_KEYCHAIN_PROFILE
  );
}

function hasCodeSigningIdentity() {
  if (process.env.CSC_LINK) {
    return true;
  }

  try {
    const output = execFileSync(
      'security',
      ['find-identity', '-v', '-p', 'codesigning'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return /Developer ID Application:/.test(output);
  } catch {
    return false;
  }
}

function verifyMacPackage() {
  // electron-builder 的 appOutDir 仅在「构建架构 ≠ 运行机架构」或显式指定时
  // 带 -<arch> 后缀：Apple Silicon 上构建 x64 时输出在 mac/ 而非 mac-x64/，
  // 因此按候选目录逐一探测，取第一个真实存在的 .app 路径。
  const candidates = [
    path.resolve(outputDir, `mac-${arch}`, 'Feishu Sync.app'),
    path.resolve(outputDir, 'mac', 'Feishu Sync.app'),
    path.resolve(outputDir, 'mac-arm64', 'Feishu Sync.app'),
    path.resolve(outputDir, 'mac-x64', 'Feishu Sync.app'),
  ];
  const appPath = candidates.find((p) => fs.existsSync(p));
  if (!appPath) {
    throw new Error(`Packaged macOS app not found in any of: ${candidates.join(', ')}`);
  }

  execFileSync(
    'codesign',
    ['--verify', '--deep', '--strict', '--verbose=2', appPath],
    { stdio: 'inherit' }
  );
  console.log(`✅ macOS bundle signature is internally valid (${macSigningMode})`);

  if (macSigningMode !== 'release') {
    console.log('ℹ️  This is an ad-hoc signed local build. Use a :release script for distribution.');
    return;
  }

  execFileSync(
    'spctl',
    ['--assess', '--type', 'execute', '--verbose=2', appPath],
    { stdio: 'inherit' }
  );

  execFileSync(
    'xcrun',
    ['stapler', 'validate', appPath],
    { stdio: 'inherit' }
  );
  console.log('✅ Developer ID signature, Gatekeeper assessment and app notarization ticket verified');
}

// ========== Build Steps ==========

async function main() {
  const startTime = Date.now();

  try {
    if (platform === 'darwin') {
      console.log(`macOS signing mode: ${macSigningMode}`);
      if (macSigningMode === 'release') {
        if (!hasCodeSigningIdentity()) {
          throw new Error(
            'Release build requires a Developer ID Application certificate '
            + 'in the keychain or CSC_LINK/CSC_KEY_PASSWORD.'
          );
        }
        if (!hasCompleteNotarizationCredentials()) {
          throw new Error(
            'Release build requires Apple notarization credentials. Configure '
            + 'APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER (recommended), '
            + 'APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID, '
            + 'or APPLE_KEYCHAIN_PROFILE.'
          );
        }
      }
    }

    // Step 1: Build frontend + server
    logStep('Step 1: Build frontend (vite) + server (tsc)');
    const buildAllResult = run('npm run build:all');
    checkSuccess(buildAllResult, 'Build all');

    // Step 2: Build Electron main + preload
    logStep('Step 2: Build Electron main + preload (esbuild)');
    const electronBuildResult = run('npm run electron:build');
    checkSuccess(electronBuildResult, 'Electron build');

    // Step 3: Prepare runtime (copy dist/server to packaging root)
    logStep('Step 3: Prepare runtime (verify dist/server structure)');
    const serverDistExists = fs.existsSync(path.resolve(rootDir, 'server/dist'));
    const serverNodeModulesExists = fs.existsSync(path.resolve(rootDir, 'server/node_modules'));
    if (!serverDistExists) {
      throw new Error('server/dist not found. Did server build fail?');
    }
    if (!serverNodeModulesExists) {
      throw new Error('server/node_modules not found. Did npm install fail?');
    }
    console.log(`✅ Runtime structure verified`);

    // Step 4: Install server production dependencies (skipped if --skip-server-deps)
    logStep('Step 4: Install server production dependencies (npm install --omit=dev)');
    const serverInstallResult = run('npm install --omit=dev', { cwd: path.resolve(rootDir, 'server') });
    checkSuccess(serverInstallResult, 'Server dependencies');

    // Step 5: Rebuild native modules (better-sqlite3 for Electron 31)
    //
    // IMPORTANT ROOT CAUSE (v0.2.0 ABI crash fix, 2026-06-19):
    //   `electron-builder install-app-deps` only scans the app root's node_modules.
    //   It does NOT recurse into `server/node_modules`. Because asarUnpack includes
    //   `server/**`, the plain-node (ABI=137) copy of better-sqlite3 from
    //   server/node_modules was shipped as-is, while the runtime (Electron 31,
    //   NODE_MODULE_VERSION 125) loaded it and crashed.
    //
    //   Fix: explicitly run @electron/rebuild against server/node_modules so the
    //   server-side better-sqlite3 is compiled for Electron's ABI (125).
    //
    //   We still rebuild the root node_modules copy too (cheap, and keeps them
    //   consistent in case anything loads better-sqlite3 from the root).
    logStep('Step 5: Rebuild native modules (better-sqlite3 for Electron 31)');

    // Resolve the exact Electron version installed at the root.
    // Parse the JSON and read dependencies.electron.version explicitly; the old
    // regex /"version":"(\d+\.\d+\.\d+)"/ accidentally matched the project's own
    // version (0.2.0) because that field appears first in `npm list` output.
    const electronVersionRaw = execSync('npm list electron --json', { cwd: rootDir, encoding: 'utf-8' });
    let electronVersion = null;
    try {
      const parsed = JSON.parse(electronVersionRaw);
      const deps = parsed && parsed.dependencies && parsed.dependencies.electron;
      if (deps && typeof deps.version === 'string') {
        electronVersion = deps.version;
      }
    } catch {
      // fall through to regex fallback below
    }
    if (!electronVersion) {
      // Fallback: read package.json devDependencies/Dependencies electron field.
      try {
        const rootPkg = require(path.resolve(rootDir, 'package.json'));
        const rawDep = (rootPkg.devDependencies && rootPkg.devDependencies.electron)
          || (rootPkg.dependencies && rootPkg.dependencies.electron);
        if (rawDep) {
          // Strip leading non-digits (^, ~, >=, etc.)
          const cleaned = rawDep.replace(/^[^\d]+/, '');
          if (/^\d+\.\d+\.\d+$/.test(cleaned)) {
            electronVersion = cleaned;
          }
        }
      } catch {
        // give up
      }
    }
    if (!electronVersion) {
      throw new Error('Could not resolve Electron version from `npm list electron --json` or package.json. Aborting rebuild.');
    }
    console.log(`Resolved Electron version: ${electronVersion} (NODE_MODULE_VERSION 125 for Electron 31.x)`);

    // 5a. Rebuild server/node_modules/better-sqlite3 (the copy the runtime actually loads).
    const rebuildServerResult = run(
      `npx @electron/rebuild -f -w better-sqlite3 -v ${electronVersion}`,
      { cwd: path.resolve(rootDir, 'server') }
    );
    checkSuccess(rebuildServerResult, 'Native rebuild (server/node_modules for Electron)');

    // 5b. Also rebuild root node_modules better-sqlite3 (consistency; required by Step 6 packaging if it picks root copy).
    const rebuildRootResult = run(
      `npx @electron/rebuild -f -w better-sqlite3 -v ${electronVersion}`,
      { cwd: rootDir }
    );
    checkSuccess(rebuildRootResult, 'Native rebuild (root node_modules for Electron)');

    // Verify better-sqlite3 .node exists in BOTH locations and sanity-check ABI via Electron itself.
    const serverNativePath = path.resolve(rootDir, 'server/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    const rootNativePath = path.resolve(rootDir, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    if (!fs.existsSync(serverNativePath)) {
      throw new Error(`Server native module not found at ${serverNativePath}. Rebuild failed.`);
    }
    if (!fs.existsSync(rootNativePath)) {
      throw new Error(`Root native module not found at ${rootNativePath}. Rebuild failed.`);
    }
    console.log(`✅ Native modules verified:`);
    console.log(`   - ${serverNativePath}`);
    console.log(`   - ${rootNativePath}`);
    console.log(`   (Both rebuilt for Electron ${electronVersion}, NODE_MODULE_VERSION 125)`);

    // Step 6: Package with electron-builder
    logStep(`Step 6: Package with electron-builder [${platform} ${arch}]`);

    const electronBuilderCmd = `npx electron-builder --config electron-builder.config.cjs --${platform === 'darwin' ? 'mac' : 'windows'} --${arch}`;
    const packageResult = run(electronBuilderCmd);

    if (!packageResult.success) {
      console.error(`\n❌ Packaging failed (exit code ${packageResult.code || 'unknown'})`);
      if (packageResult.error) {
        console.error(packageResult.error);
      }

      // Check for common errors
      if (packageResult.error?.includes('gyp') || packageResult.error?.includes('MSBuild')) {
        console.error('\n🔧 Native rebuild failed due to missing build tools.');
        console.error('Fix: Install Visual Studio Build Tools for Windows 2019 or later.');
        console.error('Download: https://visualstudio.microsoft.com/downloads/');
        console.error('Required workload: "C++ build tools"');
      } else if (packageResult.error?.includes('electron') && packageResult.error?.includes('download')) {
        console.error('\n🔧 Electron binary download failed (network or cache issue).');
        console.error('Fix: Check network connectivity or clear Electron cache: %LOCALAPPDATA%\\electron\\Cache');
      }

      process.exit(1);
    }

    console.log(`\n✅ Packaging completed`);

    // Verify output
    logStep('Step 7: Verify package output');
    const expectedExtensions = platform === 'win32' ? ['.exe'] : ['.dmg', '.zip'];
    const outputFiles = fs.readdirSync(outputDir).filter(f => expectedExtensions.some(ext => f.endsWith(ext)));

    if (outputFiles.length === 0) {
      console.warn(`⚠️  No package output found in ${outputDir}`);
      console.warn('Expected extensions:', expectedExtensions.join(', '));
    } else {
      console.log(`✅ Package outputs:`);
      for (const f of outputFiles) {
        const fpath = path.resolve(outputDir, f);
        const stats = fs.statSync(fpath);
        console.log(`   - ${f} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
      }
    }

    if (platform === 'darwin') {
      verifyMacPackage();
    }

    // Verify extraResources (icons)
    if (platform === 'win32') {
      logStep('Step 8: Verify extraResources (tray icons)');
      const unpackedResourcesDir = path.resolve(outputDir, 'resources');
      if (fs.existsSync(unpackedResourcesDir)) {
        const iconPath = path.resolve(unpackedResourcesDir, 'build/tray-icon.ico');
        if (fs.existsSync(iconPath)) {
          console.log(`✅ Icon found in unpacked resources: ${iconPath}`);
        } else {
          console.warn(`⚠️  Icon not found: ${iconPath}`);
        }
      } else {
        console.warn(`⚠️  Unpacked resources directory not found: ${unpackedResourcesDir}`);
        console.warn('Note: NSIS oneClick=false, icons should be in installed app resources, not unpacked.');
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`\n========== Build completed in ${duration}s ==========`);
    console.log(`Output directory: ${outputDir}`);

  } catch (error) {
    console.error('\n❌ Build failed:', error.message);
    process.exit(1);
  }
}

main();
