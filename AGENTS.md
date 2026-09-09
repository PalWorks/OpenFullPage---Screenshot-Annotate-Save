# AGENTS.md

The behaviour contract for any agent or automation changing this repository. In most
repos this file is advice. Here it is close to a specification, because the product
is a set of properties that are easy to destroy accidentally and impossible to
restore after a bad release ships to users.

Read [CLAUDE.md](CLAUDE.md) first for orientation.

## Role

You are a contributor to a security sensitive browser extension with one maintainer
and no review queue. Nobody will catch your mistake before it reaches users except
CI and the tests you write. Behave accordingly.

## Hard bans, enforced by CI

`test/invariants.test.js` and `test/lib/scan.js` fail the build on all of these. The
scanner is itself tested against a deliberately poisoned fixture
(`test/fixtures/violation.js`), so a green suite means the checker still fires.

| Banned | Why |
|---|---|
| `fetch`, `XMLHttpRequest`, `WebSocket`, `navigator.sendBeacon` | The CSP already blocks them. The scanner stops them being written at all |
| `eval`, `new Function`, `setTimeout('string')` | Remote code execution surface |
| `update_url` in the manifest | Auto update from outside the Web Store, the exact mechanism this project exists to close off |
| `chrome.storage.sync` | Sends user configuration to Google's servers |
| Required `host_permissions` | Broad site access granted silently at install |
| `web_accessible_resources`, `externally_connectable` | Lets a page talk to the extension |
| Any npm, pip or vendored dependency | Breaks the byte identical zip, which is the whole audit story |
| Any build, bundle, transpile or minify step | Same reason |

If a rule genuinely blocks a task, stop and say so. Do not work around it, do not
add an exception, do not "temporarily" disable a test.

## Restricted areas

| File | Rule |
|---|---|
| `manifest.json` | Permission changes need an explicit decision recorded in [docs/DECISIONS.md](docs/DECISIONS.md). Never add a required host permission |
| `test/invariants.test.js`, `test/lib/scan.js` | Add checks freely. Weakening or deleting a check is a maintainer decision, never an agent's |
| `GOVERNANCE.md` | The canary line is re-signed at release time by the maintainer. Do not edit it to make a test pass |
| `test/fixtures/violation.js` | The poisoned fixture. It must keep triggering every rule |
| `tools/pack.mjs`, `tools/lib/zip.mjs` | Packaging is deterministic on purpose. Changes here change every published hash |

## Coding conventions

- **ES modules, no framework, no transpiler.** The code Chrome runs is the code in
  this repository, character for character.
- **Pure logic goes in `src/lib/`** and is unit tested in Node. Anything that
  touches the DOM or `chrome.*` goes in `src/ui/`, `src/content/` or
  `src/background.js`. This split is what makes the tile arithmetic and the editing
  model testable at all.
- **Content scripts are self contained.** Every function in `src/content/*.js` is
  injected by `chrome.scripting.executeScript`, so it cannot close over module
  scope or import anything. If you add a helper, inline it.
- **Comments explain why, not what.** Look at `src/lib/plan.js` for the house style:
  every constant carries the reason it has that value.
- **Errors are named and visible.** No silent catch. Every failure a user can hit
  gets a sentence they can act on, through `explain()` in `src/background.js` or
  `say()` in `src/ui/result.js`.
- **The original capture is immutable.** The editor renders shapes over a pristine
  copy on every frame. Never draw into `base`. This is what makes undo exact and
  redaction genuinely destructive in the export.
- **Coordinates are in original capture pixels**, never in cropped view pixels. See
  [docs/DOMAIN.md](docs/DOMAIN.md).
- **Check CSS specificity before adding a rule.** This has bitten the project three
  times in one day and every time the JavaScript was correct. A bare
  `.pop[hidden] { display: none }` scores (0,2,0) and loses to a later
  `.pop.paint { display: flex }`, so no popover could close. `#toolbar button.icon
  svg` scores (1,1,2) and beats `.caret`, so every chevron rendered at the size of
  the glyph beside it. `.masthead nav a` beat `.btn-primary`, so a button was teal
  on teal. When a rule must win, qualify it (`#toolbar .pop[hidden]`) or exclude the
  exception from the broad rule (`svg:not(.caret)`). Never reach for `!important`.
- **Selection chrome is drawn in screen space, shape geometry in image space.** A
  4px stroke must stay 4px in the export; a 9px handle must stay 9px under the
  pointer. See [docs/DECISIONS.md](docs/DECISIONS.md) D19.
- **Name conventions, not products.** Nothing in `src/`, the manifest, `docs/`,
  `store/`, `tools/` or the Markdown at the root may name another product;
  `scanBrands` in `test/lib/scan.js` fails the build if one appears. Write "the
  convention in annotation tools", not "the way X does it". That is not
  squeamishness, it is accuracy: the convention belongs to the category. The same
  rule covers claims that identify a competitor without naming one, which no
  scanner can catch: do not assert what a particular extension did unless the claim
  is sourced and the source is in the sentence. `NOTICE.md` is the one exception to
  the naming rule, because the licence requires the name. See D34.
- **`hidden` works on HTML elements and not on SVG.** `SVGElement` has no `hidden`
  property, so `svg.hidden = true` sets a plain JavaScript property, leaves the
  attribute alone and paints exactly what it painted before. Use `showGlyph()` in
  `src/ui/result.js`, which sets the attribute, and remember that CSS has to say
  what `hidden` means for SVG because the user agent stylesheet does not. Three
  glyphs were stuck this way at once. See [docs/DECISIONS.md](docs/DECISIONS.md) D37.
- **Never put `overflow: hidden` on an ancestor of a popover.** A popover is
  positioned outside its container by definition, so the container clips it away
  entirely: laid out correctly, readable in every property, painted nowhere. Round
  or clip the children instead. See D38.
- **Settings are written through `saveSettings`, which serialises.** It is
  read-modify-write over the whole object, so never call `chrome.storage.local.set`
  for a setting directly: two overlapping writes would each put back what the other
  had just changed.

## Definition of done

A change is not done until all of these are true:

1. `node --test 'test/**/*.test.js'` passes.
2. New behaviour has a unit test if it is pure, or an end to end test if it is not.
3. Every new failure path has a user visible message, decided at design time.
4. Any new setting key is added to **both** `DEFAULTS` and `sanitise()` in
   `src/lib/settings.js`. `sanitise()` silently discards unknown keys, so a key
   added to only one of the two is written nowhere and fails silently.
5. Docs that the change makes wrong are updated in the same commit. Stale docs are
   worse than no docs.
6. `./tools/pack.sh` still produces a zip that is byte identical to the tree.
7. If the change touches an interface, `node test/e2e/run.mjs --edit` passes,
   including the rendered-page audit. It asks the browser what it actually drew:
   contrast against the real background, content wider than the window, broken
   images, skipped heading levels. A test that asserts `element.hidden` while the
   pixels say otherwise is how three separate bugs reached a user.
8. If the change moves anything visible, regenerate the store screenshots with
   `node test/e2e/run.mjs --market --shots store/screenshots`, so the listing can
   never show an interface that no longer exists.

## Review rules

- Small, complete diffs. A feature and its tests land together.
- No new abstraction for a problem that does not exist yet.
- Prefer extending a pure module over adding logic to `src/ui/result.js`, which is
  already the most churned file in the repo.
- If you find a bug outside your task, say so. Do not silently fix it in an
  unrelated diff, and do not silently leave it.

## Safety constraints

- Never weaken a permission boundary to make something easier.
- Never add a remotely updated list of anything. A remote selector list is a remote
  code channel with extra steps.
- Never persist a user's captured image without an explicit opt in. As of 1.6.1
  nothing is persisted except settings.
- Treat everything read back out of storage as hostile. `sanitise()` in
  `src/lib/settings.js` is the pattern to copy.
