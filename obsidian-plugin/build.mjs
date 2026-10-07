import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(pluginDir);
const outputDir = path.join(pluginDir, 'dist');
await mkdir(outputDir, { recursive: true });
await build({
  entryPoints: [path.join(pluginDir, 'src/main.ts')],
  outfile: path.join(outputDir, 'main.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  sourcemap: false,
  minify: true,
  logLevel: 'info'
});
await Promise.all([
  copyFile(path.join(projectDir, 'manifest.json'), path.join(outputDir, 'manifest.json')),
  copyFile(path.join(pluginDir, 'styles.css'), path.join(outputDir, 'styles.css'))
]);
