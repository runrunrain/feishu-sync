import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: [fileURLToPath(new URL('../../src/share/render.tsx', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/share-render.cjs', import.meta.url)),
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env': '{}' },
});
