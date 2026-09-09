// Package the extension for the Chrome Web Store.
//
// This is packaging, not building: the archive holds the source files verbatim,
// and test/invariants.test.js asserts that byte for byte. The archive is also
// deterministic, same sources in, same bytes and same SHA-256 out, on any
// machine, so the hash published in CHANGELOG.md is reproducible rather than
// merely checkable against one download.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeZip } from './lib/zip.mjs';
import { REPO_ROOT, shippedFiles } from '../test/lib/scan.js';

const version = JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8')).version;
const out = join(REPO_ROOT, 'dist', `openfullpage-${version}.zip`);

const files = shippedFiles().map((name) => ({
  name,
  data: readFileSync(join(REPO_ROOT, name)),
}));

const zip = makeZip(files);
mkdirSync(join(REPO_ROOT, 'dist'), { recursive: true });
writeFileSync(out, zip);

console.log(`dist/openfullpage-${version}.zip  (${files.length} files, ${zip.length} bytes)`);
console.log(createHash('sha256').update(zip).digest('hex'));
