#!/usr/bin/env node
// Copy the shared page files from markers/ into ../markers-window/ as real files.
// LUNA loads Add On files through ua-content:// and refuses a symlink that resolves outside the Add On
// folder, so the floating-window Add On cannot symlink to markers/. markers/ is the single source of
// truth; run this (or `npm run build`) after editing it, and before packing the window Add On.
import { copyFileSync, existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DST = resolve(SRC, '..', 'markers-window');
const FILES = ['index.html', 'logic.js', 'main.js', 'luna-skin.css', 'vendor/luna.global.js'];

if (!existsSync(DST)) { console.error(`No ${DST}`); process.exit(1); }
for (const f of FILES) {
  const to = join(DST, f);
  mkdirSync(dirname(to), { recursive: true });
  if (existsSync(to) && lstatSync(to).isSymbolicLink()) rmSync(to); // an old symlink would be written through
  copyFileSync(join(SRC, f), to);
}
// A symlinked vendor/ directory from the earlier layout: replace it with a real one.
console.log(`Synced ${FILES.length} files to ${DST}`);
