#!/usr/bin/env node
// Vendor the LUNA Builder SDK's script-tag bundle into vendor/luna.global.js, with the load-retry
// fix from patches/ua-builder-sdk-load-retry.patch applied: failed loads are retried, not
// remembered, since LUNA can time a read out while it is still opening a session. The SDK now
// ships prebuilt, so the fix is applied to the built bundle: each edit must find its anchor
// exactly once, or nothing is written.
//
//   node scripts/vendor-sdk.mjs            from the installed SDK
//   LUNA_BUILDER_SDK=<folder> node ...     from another SDK folder
//
// When the SDK carries the fix itself (the bundle already says `this.loading === loading`), the
// plain bundle is vendored and this script says so: then delete the patch and this step.

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SDK = process.env.LUNA_BUILDER_SDK ?? join(homedir(), 'Library', 'Application Support', 'LUNA Builder SDK');
const source = join(SDK, 'plugins', 'ua-luna-builder', 'sdk', 'luna.global.js');
const target = join(ROOT, 'vendor', 'luna.global.js');

let bundle = readFileSync(source, 'utf8');
const version = /var VERSION = "([^"]+)"/.exec(bundle)?.[1] ?? 'unknown';

const EDITS = [
  {
    what: 'Node.load forgets a failure',
    from: `    load(options) {
      if (!this.loading) {
        this.loading = this.client.store.load(this.path, options).then(() => void 0);
      }`,
    to: `    load(options) {
      if (!this.loading) {
        const loading = this.client.store.load(this.path, options).then(() => void 0);
        loading.catch(() => {
          if (this.loading === loading) this.loading = void 0;
        });
        this.loading = loading;
      }`,
  },
  {
    what: 'Collection.load forgets a failure',
    from: `    load() {
      if (!this.loading) {
        this.loading = this.client.store.load(this.path, this.loadOptions).then(() => void 0);
      }`,
    to: `    load() {
      if (!this.loading) {
        const loading = this.client.store.load(this.path, this.loadOptions).then(() => void 0);
        loading.catch(() => {
          if (this.loading === loading) this.loading = void 0;
        });
        this.loading = loading;
      }`,
  },
  {
    what: 'Session.ready forgets a failure',
    from: `        this.readyPromise = watch.ready.then(() => Promise.all([this.tracks.load(), this.buses.load(), this.playlists.load(), this.musical.ready(), this.markers.load(), this.contexts.load(), this.client.gui.watchPluginWindows()])).then(() => void 0);
      }`,
    to: `        const ready = watch.ready.then(() => Promise.all([this.tracks.load(), this.buses.load(), this.playlists.load(), this.musical.ready(), this.markers.load(), this.contexts.load(), this.client.gui.watchPluginWindows()])).then(() => void 0);
        ready.catch(() => {
          if (this.readyPromise !== ready) return;
          this.readyPromise = void 0;
          this.watchRelease?.();
          this.watchRelease = void 0;
        });
        this.readyPromise = ready;
      }`,
  },
];

if (bundle.includes('this.loading === loading')) {
  console.log(`SDK ${version} already forgets failed loads: vendoring the plain bundle. Delete patches/ and this step.`);
} else {
  for (const { what, from, to } of EDITS) {
    const count = bundle.split(from).length - 1;
    if (count !== 1) throw new Error(`${what}: expected its anchor once in SDK ${version}, found ${count}. Update scripts/vendor-sdk.mjs for this SDK.`);
    bundle = bundle.replace(from, to);
  }
}
writeFileSync(target, bundle);
console.log(`${target}: SDK ${version}${bundle.includes('this.readyPromise !== ready') ? ', load-retry fix applied' : ''}`);
