import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { storeManifest } from './lib/store-manifest.ts';
import { zipFiles } from './lib/zip.ts';

const root = 'packages/extension/dist';
const source = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
const files = [];
async function collect(dir) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && !/\.(map|tsbuildinfo|pem)$/.test(entry.name) && !entry.name.startsWith('.')) {
      const name = relative(root, path).replaceAll('\\', '/');
      const data = name === 'manifest.json' ? Buffer.from(JSON.stringify(storeManifest(source, version), null, 2)) : await readFile(path);
      files.push({ name, data });
    }
  }
}
await collect(root);
await mkdir('artifacts', { recursive: true });
for (const browser of ['chrome', 'edge']) {
  const path = `artifacts/browpilot-${browser}-${version}.zip`;
  await writeFile(path, zipFiles(files));
  console.log(path);
}
