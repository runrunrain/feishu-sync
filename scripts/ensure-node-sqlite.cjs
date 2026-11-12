/** npm test may follow an Electron build. Repair only an incompatible/missing
 * native binary, without changing dependency versions or the packaged runtime. */
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repo = path.resolve(__dirname, '..');
const directory = process.argv.includes('--server') ? path.join(repo, 'server') : repo;
const probe = () => spawnSync(process.execPath, ['-e',
  "const Database=require('better-sqlite3');const db=new Database(':memory:');db.prepare('select 1').get();db.close();",
], { cwd: directory, encoding: 'utf8', windowsHide: true });
let result = probe();
if (result.status !== 0) {
  const reason = result.stderr || String(result.error || 'SQLite probe failed');
  if (!/NODE_MODULE_VERSION|Could not locate the bindings file|not a valid Win32 application|ERR_DLOPEN_FAILED/.test(reason)) {
    process.stderr.write(reason); process.exit(1);
  }
  const npm = process.env.npm_execpath;
  if (!npm) { console.error('Run through npm test so the matching npm executable is available.'); process.exit(1); }
  console.log(`[test environment] Rebuilding better-sqlite3 for Node ${process.version} (ABI ${process.versions.modules}) in ${directory}`);
  const rebuild = spawnSync(process.execPath, [npm, 'rebuild', 'better-sqlite3'], { cwd: directory, stdio: 'inherit', windowsHide: true });
  if (rebuild.status !== 0) process.exit(rebuild.status || 1);
  result = probe();
  if (result.status !== 0) { process.stderr.write(result.stderr || 'SQLite verification failed'); process.exit(1); }
}
