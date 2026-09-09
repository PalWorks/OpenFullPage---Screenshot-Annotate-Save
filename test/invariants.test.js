// OpenFullPage, security invariants (V1-SPEC §5).
//
// These run on every commit. They are the mechanical form of the promises in
// the README: no network, no remote code, no privileged APIs, no build step.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';

import { SHAPE_GROUPS, SHAPE_TOOLS, TOOLS } from '../src/lib/edit.js';
import { TOOLBAR_BUTTONS } from '../src/lib/settings.js';
import { makeZip } from '../tools/lib/zip.mjs';
import {
  BANNED,
  REPO_ROOT,
  checkManifest,
  checkPackedZip,
  proseFiles,
  readManifest,
  scanSources,
  scanBrands,
  scanShipped,
  shippedFiles,
} from './lib/scan.js';

function format(violations) {
  return violations.map((v) => `${v.path}:${v.line}, ${v.rule}, ${v.text}`).join('\n');
}

test('the scanner fires on a deliberate violation', () => {
  // The Step 0 acceptance gate. A green suite means nothing unless this fails
  // when it should, so the gate is tested before the thing it gates.
  const path = 'test/fixtures/violation.js';
  const source = readFileSync(join(REPO_ROOT, path), 'utf8');
  const violations = scanSources([{ path, source }]);

  const triggered = new Set(violations.map((v) => v.rule));
  for (const [rule] of BANNED) {
    assert.ok(triggered.has(rule), `rule "${rule}" did not fire on the poisoned fixture`);
  }
});

test('the poisoned fixture is not part of the shipped surface', () => {
  assert.ok(!shippedFiles().includes('test/fixtures/violation.js'));
});

test('no banned patterns in the shipped surface', () => {
  const violations = scanShipped();
  assert.equal(violations.length, 0, `banned patterns found:\n${format(violations)}`);
});

/**
 * The repository is public, and the shipped surface is the first thing a stranger
 * reads. A comment there saying a control came from a named product is the worst
 * document to own in a dispute, whatever the code actually does, and it is never
 * necessary: a convention can be described without naming whoever also follows it.
 * NOTICE.md is the exception and is not scanned, because the licence it satisfies
 * requires the name.
 */
test('the shipped surface names no other product', () => {
  const found = scanBrands(shippedFiles());
  assert.equal(found.length, 0, `other products named:\n${format(found)}`);
});

/**
 * The documents are the other half of that surface, and they are where the claims
 * went when the shipped surface was cleaned: a working note naming a live product,
 * a deferred task identifying an extension by install count, a roadmap line
 * asserting why a named competitor was removed from the store. Prose is scanned on
 * the same terms as code, with `NOTICE.md` exempt because the licence requires the
 * name and the disclaimer has to name what it disclaims. See DECISIONS.md D34.
 */
test('the documents name no other product', () => {
  const found = scanBrands(proseFiles());
  assert.equal(found.length, 0, `other products named:\n${found.join('\n')}`);
});

test('the brand scanner fires on a name it is meant to catch', () => {
  const found = scanBrands(['test/fixtures/violation.js']);
  assert.ok(found.length > 0, 'the fixture no longer trips the brand scanner');
});

test('broad access is offered, never granted at install', () => {
  const manifest = readManifest();

  // These are the whole point of the design: nothing broad is held by default.
  assert.ok(!('host_permissions' in manifest), 'required host_permissions must not exist');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting', 'storage']);
  assert.ok(manifest.optional_permissions.includes('webNavigation'));
  assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>']);

  // Even fully granted, the extension still cannot send anything anywhere.
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});

test('manifest declares no network or privileged surface', () => {
  const problems = checkManifest(readManifest());
  assert.equal(problems.length, 0, `manifest violations:\n${problems.join('\n')}`);
});

test('manifest checks reject a regressed manifest', () => {
  const clean = readManifest();
  const cases = [
    ['host_permissions', { ...clean, host_permissions: ['*://*/*'] }],
    ['web_accessible_resources', { ...clean, web_accessible_resources: [] }],
    ['update_url', { ...clean, update_url: 'https://example.invalid/updates.xml' }],
    ['a broad permission demanded at install', { ...clean, permissions: [...clean.permissions, 'tabs'] }],
    ['cookies at install', { ...clean, permissions: [...clean.permissions, 'cookies'] }],
    ['an over-broad optional origin', { ...clean, optional_host_permissions: ['<all_urls>', 'file:///*'] }],
    ['GoFullPage mark', { ...clean, name: 'GoFullPage Ultimate' }],
    [
      'weakened CSP',
      {
        ...clean,
        content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'" },
      },
    ],
  ];

  for (const [label, manifest] of cases) {
    assert.ok(checkManifest(manifest).length > 0, `${label} was not rejected`);
  }
});

test('every file the manifest references exists', () => {
  const manifest = readManifest();
  const referenced = [
    manifest.background?.service_worker,
    manifest.action?.default_popup,
  ].filter(Boolean);

  for (const path of referenced) {
    assert.ok(existsSync(join(REPO_ROOT, path)), `manifest references missing file ${path}`);
  }
});

// The store title carries search keywords and will be rewritten as the listing is
// tuned. The short name is the product, and the download filename is built from
// it, so a listing rewrite must not be able to lengthen every filename a user
// saves. Chrome caps short_name at 12 characters.
test('a short name exists and is short enough for Chrome to use', () => {
  const manifest = readManifest();
  assert.ok(manifest.short_name, 'manifest.json needs a short_name');
  assert.ok(
    manifest.short_name.length <= 12,
    `short_name is ${manifest.short_name.length} characters, Chrome allows 12`,
  );
  assert.ok(
    manifest.name.startsWith(manifest.short_name),
    'the store title should begin with the product name',
  );
});

test('VERSION and manifest.json agree', () => {
  // Two files carry the version; release tooling reads VERSION, Chrome reads the
  // manifest. Drift between them ships a zip whose name lies about its contents.
  const declared = readFileSync(join(REPO_ROOT, 'VERSION'), 'utf8').trim();
  assert.equal(declared, readManifest().version);
});

test('packaging is deterministic', () => {
  // The published SHA-256 is only meaningful if a reader can reproduce it, so
  // the archive must be a pure function of the file contents and their names ,
  // no timestamps, no filesystem ordering, no host details.
  const files = shippedFiles().map((name) => ({
    name,
    data: readFileSync(join(REPO_ROOT, name)),
  }));

  const once = makeZip(files);
  const twice = makeZip(files);
  assert.ok(once.equals(twice), 'two packs of the same sources differ');

  const built = join(REPO_ROOT, 'dist', `openfullpage-${readManifest().version}.zip`);
  if (existsSync(built)) {
    assert.ok(
      readFileSync(built).equals(once),
      'the package on disk is not what packing these sources produces, re-run tools/pack.sh',
    );
  }
});

test('the packed zip is byte-identical to the working tree', (t) => {
  const manifest = readManifest();
  const zip = join(REPO_ROOT, 'dist', `openfullpage-${manifest.version}.zip`);
  if (!existsSync(zip)) {
    t.skip('no package built, run tools/pack.sh (CI always builds one first)');
    return;
  }

  const problems = checkPackedZip(zip);
  assert.equal(problems.length, 0, `package differs from source:\n${problems.join('\n')}`);
});

/**
 * The markup and the module lists have to agree.
 *
 * Both of these are silent when they drift. A `data-tool` naming a tool that does
 * not exist makes a button that does nothing; a `data-button` missing from
 * TOOLBAR_GROUPS makes a control with no switch on the settings page, which is
 * how the theme button nearly shipped.
 */
test('every tool named in the markup is a tool that exists', () => {
  const markup = readFileSync(join(REPO_ROOT, 'src/ui/result.html'), 'utf8');
  const named = [...markup.matchAll(/data-tool="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'no tools in the markup at all');
  for (const tool of new Set(named)) assert.ok(TOOLS.includes(tool), `unknown tool "${tool}"`);
});

test('the shapes popover and the model agree about which shapes exist', () => {
  // Three lists used to describe the shapes: the markup, a hardcoded array in
  // result.js, and TOOLS in the model. Twelve shapes across three hand
  // maintained lists drift, and the failure is silent: a shape in the popover
  // that the model does not know, or a shape in the model with no way to reach
  // it. result.js now imports the list, so this checks the remaining pair.
  const markup = readFileSync(join(REPO_ROOT, 'src/ui/result.html'), 'utf8');
  const popover = markup.slice(markup.indexOf('id="pop-shapes"'), markup.indexOf('id="pop-text"'));
  const inMarkup = [...popover.matchAll(/data-shape="([\w-]+)"/g)].map((m) => m[1]);

  assert.deepEqual(inMarkup, SHAPE_TOOLS, 'the popover order must match SHAPE_TOOLS exactly');
  for (const kind of SHAPE_TOOLS) {
    assert.ok(TOOLS.includes(kind), `"${kind}" is in the popover but not in TOOLS`);
  }
  // Every group in the model has a heading in the markup, so a group cannot be
  // added to the model and silently render as a run of unlabelled buttons.
  for (const [name] of SHAPE_GROUPS) {
    assert.ok(popover.includes(`>${name}<`), `the "${name}" group has no heading in the popover`);
  }
});

test('every toolbar control in the markup can be switched off on the settings page', () => {
  const markup = readFileSync(join(REPO_ROOT, 'src/ui/result.html'), 'utf8');
  const named = [...markup.matchAll(/data-button="([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'no controls in the markup at all');
  for (const button of new Set(named)) {
    assert.ok(TOOLBAR_BUTTONS.includes(button), `"${button}" has no switch on the settings page`);
  }
  // And the other way: a switch for a control that is not there hides nothing.
  for (const button of TOOLBAR_BUTTONS) {
    assert.ok(named.includes(button), `"${button}" has a switch but no control in the toolbar`);
  }
});
