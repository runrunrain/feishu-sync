// ABI verification: load better-sqlite3 from server/node_modules using Electron runtime.
// Exit 0 with stdout "ABI_OK_<modules>" if load succeeds; non-zero otherwise.
const path = require('node:path');
const Module = require('node:module');

// Force module resolution to find better-sqlite3 in server/node_modules.
const serverDepsDir = path.resolve(__dirname, '..', 'server', 'node_modules');
const candidatePaths = [
  path.join(serverDepsDir, 'better-sqlite3'),
];
const existing = candidatePaths.filter((p) => {
  try {
    return require('fs').existsSync(path.join(p, 'package.json'));
  } catch {
    return false;
  }
});
if (existing.length === 0) {
  process.stderr.write('better-sqlite3 not found under server/node_modules\n');
  process.exit(2);
}
// Prepend server node_modules to module resolution paths.
module.paths.unshift(serverDepsDir);

try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec('CREATE TABLE t(x INTEGER)');
  db.prepare('INSERT INTO t VALUES (?)').run(42);
  const row = db.prepare('SELECT x FROM t').get();
  db.close();
  process.stdout.write('ABI_OK_modules=' + process.versions.modules + '_node=' + process.versions.node + '_electron=' + process.versions.electron + '_row_x=' + row.x + '\n');
  process.exit(0);
} catch (err) {
  process.stderr.write('LOAD_FAILED: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exit(1);
}
