// Version: 1.0.0
//
// Link check: resolves every import of index.js and everything it pulls in, and confirms each
// imported name is really exported by the file it names -- WITHOUT running any of the bot code.
// Importing index.js for real starts a bot that logs in to the server (on 2026-11-10 a careless
// `node -e 'import("./index.js")'` kicked the live Babs with a duplicate login); this never
// evaluates a bot module, so it cannot.
//
// Packages (mineflayer, vec3, ...) are imported for real to learn their export names -- importing
// them connects nothing. Needs --experimental-vm-modules:
//   node --experimental-vm-modules tests/link-check.mjs [entry.js]

import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = pathToFileURL(root + (process.argv[2] ?? 'index.js')).href;
const context = vm.createContext({});
const cache = new Map();

async function load(url) {
  if (cache.has(url)) return cache.get(url);
  let mod;
  if (url.startsWith('file:')) {
    const source = await readFile(fileURLToPath(url), 'utf8');
    mod = new vm.SourceTextModule(source, { identifier: url, context });
  } else {
    const real = await import(url); // resolved from tests/, which walks up to this service's node_modules
    const names = Object.keys(real);
    mod = new vm.SyntheticModule(names.includes('default') ? names : [...names, 'default'],
      function () { for (const n of names) this.setExport(n, real[n]); }, { identifier: url, context });
  }
  cache.set(url, mod);
  return mod;
}

const top = await load(entry);
await top.link((specifier, referencing) =>
  load(specifier.startsWith('.') ? new URL(specifier, referencing.identifier).href : specifier));
const local = [...cache.keys()].filter((u) => u.startsWith('file:'));
console.log(`linked ${local.length} bot modules and ${cache.size - local.length} packages: every import resolves.`);
