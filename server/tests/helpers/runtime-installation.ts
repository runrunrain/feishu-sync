/** 临时安装布局；npm 若被意外执行，只写本目录内的 sentinel，不触碰宿主安装。 */
import fs from 'node:fs';
import path from 'node:path';
import { PI_PACKAGE_NAME } from '../../src/agent/runtime-resolver.js';

export function makeRuntimeInstallation(root: string) {
  const bin = path.join(root, 'bin');
  const npmRoot = path.join(root, 'lib', 'node_modules', 'npm');
  const piRoot = path.join(root, 'lib', 'node_modules', ...PI_PACKAGE_NAME.split('/'));
  const marker = path.join(root, 'npm-was-executed');
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  fs.mkdirSync(path.join(npmRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(npmRoot, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name: 'npm' }));
  fs.writeFileSync(path.join(npmRoot, 'bin', 'npm-cli.js'),
    `#!${process.execPath}\nrequire('../lib/cli.js')\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(npmRoot, 'lib', 'cli.js'),
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');\n`);
  fs.symlinkSync('../lib/node_modules/npm/bin/npm-cli.js', path.join(bin, 'npm'));
  fs.mkdirSync(path.join(piRoot, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(piRoot, 'package.json'), JSON.stringify({ name: PI_PACKAGE_NAME, version: '1.4.0' }));
  fs.writeFileSync(path.join(piRoot, 'dist', 'cli.js'), '// fixture, never spawned');
  return { nodePath: path.join(bin, 'node'), npmRoot, piRoot, marker };
}
