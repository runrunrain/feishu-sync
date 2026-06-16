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

const { execSync } = require('node:child_process');
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
const skipServerDeps = params.skipServerDeps || process.env.DESKTOP_SKIP_SERVER_DEPS;
const platform = params.platform || process.env.DESKTOP_TARGET_PLATFORM;
const arch = params.arch || process.env.DESKTOP_TARGET_ARCH;

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

console.log(`\n========== Building feishu-sync Desktop [${platform} ${arch}] ==========\n`);

// ========== Environment Setup ==========

const rootDir = path.resolve(__dirname, '..');
const appDir = path.resolve(rootDir); // App directory (same as root)
const outputDir = path.resolve(rootDir, `dist-desktop/${platform}-${arch}`);

// Set environment variables for electron-builder.config.js
process.env.DESKTOP_TARGET_PLATFORM = platform;
process.env.DESKTOP_TARGET_ARCH = arch;
process.env.DESKTOP_APP_DIR = appDir;
process.env.DESKTOP_OUTPUT_DIR = outputDir;

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

// ========== Build Steps ==========

async function main() {
  const startTime = Date.now();

  try {
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
    logStep('Step 5: Rebuild native modules (better-sqlite3 for Electron 31)');

    // Strategy: Use electron-builder install-app-deps (preferred for electron-builder workflows)
    // Fallback: npx @electron/rebuild -f -w better-sqlite3
    let rebuildResult;
    try {
      console.log('Attempting electron-builder install-app-deps...');
      rebuildResult = run('npx electron-builder install-app-deps');
      checkSuccess(rebuildResult, 'Native rebuild (electron-builder)');
    } catch (e1) {
      console.warn('electron-builder install-app-deps failed, trying @electron/rebuild fallback...');
      rebuildResult = run('npx @electron/rebuild -f -w better-sqlite3', {
        env: {
          ...process.env,
          electron: execSync('npm list electron --json').toString().match(/"version":"(\d+\.\d+\.\d+)"/)?.[1] || '31.7.7'
        }
      });
      checkSuccess(rebuildResult, 'Native rebuild (@electron/rebuild fallback)');
    }

    // Verify better-sqlite3 .node exists
    const betterSqlite3Path = path.resolve(rootDir, 'server/node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    if (!fs.existsSync(betterSqlite3Path)) {
      throw new Error(`Native module not found at ${betterSqlite3Path}. Rebuild failed.`);
    }
    console.log(`✅ Native module verified: ${betterSqlite3Path}`);

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
