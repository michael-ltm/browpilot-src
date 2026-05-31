import { build, context } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(here, 'dist');
const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    background: resolve(here, 'src/background/index.ts'),
    cursor: resolve(here, 'src/content/cursor.ts'),
    popup: resolve(here, 'src/popup/popup.ts'),
  },
  outdir,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  sourcemap: true,
  logLevel: 'info',
};

async function copyStatic() {
  await mkdir(outdir, { recursive: true });
  await cp(resolve(here, 'manifest.json'), resolve(outdir, 'manifest.json'));
  await cp(resolve(here, 'src/popup/popup.html'), resolve(outdir, 'popup.html'));
  await cp(resolve(here, 'icons'), resolve(outdir, 'icons'), { recursive: true });
}

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  await copyStatic();
  console.log('esbuild watching…');
} else {
  await build(options);
  await copyStatic();
  console.log('esbuild build complete → dist/');
}
