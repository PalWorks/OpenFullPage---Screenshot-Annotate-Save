# Playbook

Operational procedures. Follow step by step.

## Commands

| Command | Does |
|---|---|
| `node --test 'test/**/*.test.js'` | The whole unit suite: security invariants, planner, editor model, settings, icons |
| `node --test test/plan.test.js` | One file, while iterating |
| `node test/e2e/run.mjs` | Drives a real Chrome over CDP: captures the local fixture, exercises the editor, checks the saved file |
| `node test/e2e/run.mjs --edit` | Adds the editor and interface checks: drawing, undo, redaction, text entry, every popover, and the rendered-page audit on the result tab and the options page |
| `node test/e2e/run.mjs --edit --shots <dir>` | The same, plus a screenshot of the toolbar and of each popover, for looking at with human eyes |
| `node test/e2e/run.mjs --stop` | Presses Finish now partway through a capture of a 15000 pixel fixture, and checks the image comes back short, trimmed and honest about it |
| `node test/e2e/run.mjs --direct` | Turns on straight-to-a-file, and checks a capture writes an image and closes its own tab with no editor and no click |
| `node test/e2e/run.mjs --headed --popup` | Proves Chrome actually opens the progress panel under the toolbar button. Headless will not open one, so this is the only mode that can check it, and it refuses to run without `--headed` |
| `node test/e2e/run.mjs --stale` | Points the service worker at a later protocol version than the pages read, which is what an extension update landing mid capture looks like. The result tab must say so rather than waiting on a progress bar that will never move |
| `node test/e2e/run.mjs --nudge` | Sets the capture count to four so the one about to run is the fifth, and checks the rating nudge appears, is written down, offers no sentiment fork, and that "Don't ask again" is permanent. D59 |
| `node test/e2e/run.mjs --remove` | Drives the fourth capture mode: hides the fixture's cookie bar, captures, then checks both that the element is absent from the picture and that the page was put back afterwards. D66 |
| `node test/e2e/run.mjs --frozen` | Makes the worker's capture step serve the previous frame once, which is what `captureVisibleTab` does when the compositor presented no frame for the new scroll position. The stitched fixture must still carry every band once. D56 |
| `node test/e2e/run.mjs --market --shots store/screenshots/raw` | Photographs the real product capturing `store/demo/report.html`, at exactly 1280x800. No network, no arguments: `--market` serves the demo page itself |
| `node tools/make-shots.mjs` | Puts a headline over each raw photograph and writes the five screenshots the store shows |
| `FPC_URLS=<url> node test/e2e/run.mjs ...` | Point any of the above at a page of your choosing rather than the fixture |
| `node tools/preview-icons.mjs` | Contact sheet of the icon at 128, 48, 32 and 16, on both Chrome toolbars |
| `node tools/make-icons.mjs --check` | Fails if the PNG icons no longer match their design source |
| `node tools/make-icons.mjs` | Regenerate the icons from source |
| `node tools/make-promo.mjs` | Redraw the two store promo tiles at 1400x560 and 440x280. Refuses to write a tile with a word outside it |
| `node tools/make-promo.mjs --all <dir>` | Every tile design, side by side, for choosing between them. `CHOSEN` in that file decides which one ships |
| `./tools/pack.sh` | Deterministic zip into `dist/openfullpage-<version>.zip` |
| `cd tools/verify-crx && go build -o verify-crx .` | Build the install verifier |
| `./verify-crx compare <installed dir> <repo root>` | Hash every file and exit non zero on any mismatch |

There is no `package.json` and no `npm run`. That is deliberate: see
[DECISIONS.md](DECISIONS.md) D1.

## The other two repositories

| What | Where |
|---|---|
| The extension | this repository, private, cleared to publish since 2026-09-09. See [MEMORY.md](MEMORY.md) |
| The website | [`PalWorks/openfullpage-site`](https://github.com/PalWorks/openfullpage-site), public, served at <https://palworks.github.io/openfullpage-site/> |
| The store listing | [`../store/LISTING.md`](../store/LISTING.md) in this repository, with its images |

The site deploys from its `main` branch with GitHub's own branch build, so there is
no workflow file to maintain and no Actions minutes spent. Its rendered-page audit
is the same script the extension uses, `test/e2e/page-audit.js`; run it against the
site by hand with the gstack browser after any change:

```bash
~/Documents/gstack/browse/dist/browse goto https://palworks.github.io/openfullpage-site/
~/Documents/gstack/browse/dist/browse eval /private/tmp/page-audit.js
```

## Running the extension you just cloned

1. Open `chrome://extensions`.
2. Turn on Developer mode, top right.
3. Load unpacked, and choose this folder.
4. Pin the icon and click it on any ordinary http(s) page.

## Adding a feature

1. **Read first.** [../AGENTS.md](../AGENTS.md), then the rows in
   [CONTEXT_MAP.md](CONTEXT_MAP.md) for the files you will touch, then the entry in
   [../TASKS.md](../TASKS.md) if the feature has one.
2. **Check the boundary.** Does it need a network call, a dependency, a build step,
   or a new required permission? If yes, stop: it does not get built in this form.
3. **Put the logic in a pure module** under `src/lib/` if it can be pure. That is
   what makes it testable in Node.
4. **Decide the user visible strings at design time**, including the failure ones.
   Every new failure path gets a sentence. No silent catch.
5. **If it adds a setting**, add the key to `DEFAULTS` **and** to `sanitise()` in
   `src/lib/settings.js`, in the same edit.
6. **Write the tests with the feature**, not after.
7. **Update the docs the change makes wrong**, in the same commit.
8. Run the unit suite and, if the change touches capture or the editor, the e2e
   suite.

## Cutting a release

1. `node --test 'test/**/*.test.js'` and `node test/e2e/run.mjs`. Both green.
2. Update `VERSION` and the `version` field in `manifest.json`. They must agree; a
   test enforces it.
3. Add a `CHANGELOG.md` entry describing what changed for a user, not for a
   developer.
4. **Re-sign the canary in `GOVERNANCE.md`**: update the date and confirm the
   statement is still true. This is a security promise, not bookkeeping. It has
   drifted before (see [LIMITATIONS.md](LIMITATIONS.md) L19).
5. `./tools/pack.sh`.
6. Commit with the version in the subject, matching the existing history style
   (`1.6.1: store title, and a short name to protect filenames`).
7. Upload `dist/openfullpage-<version>.zip` to the Chrome Web Store.
8. After it goes live, verify the published build with `tools/verify-crx` against
   this tree at that tag. If it does not match, treat it as a compromise.

## Rolling back

1. Re-upload the previous zip from `dist/` to the Web Store.
2. `git revert` the release commit.
3. Nothing else. There is no server, no migration and no persisted state that
   survives a downgrade, with one future exception: once capture history (F11)
   ships, its IndexedDB store carries a schema version and a downgrade must be
   tested against it.

## Responding to a suspected compromise

1. Compare the published extension to the tagged tree with `tools/verify-crx`.
2. If they differ, unpublish immediately. Do not patch forward.
3. The canary in `GOVERNANCE.md` is the user facing signal. If the maintainer cannot
   truthfully re-sign it, it must be removed rather than reworded, and users are
   instructed to treat that as compromise.

## Debugging a capture

- **The service worker log.** `chrome://extensions`, Inspect views, service worker.
  `runCapture` logs through `explain()`.
- **The result tab.** Ordinary DevTools. `say()` writes the status line the user
  sees.
- **A page that captures wrong** is nearly always one of: sticky elements that are
  not `position: sticky`, a scroll container that is not the window, lazy content
  slower than the settle budget, or a page that grows while being walked. All four
  are described in [ARCHITECTURE.md](ARCHITECTURE.md).
- **Reproduce deterministically** with the fixtures in `test/e2e/fixture/` before
  trying to fix anything against a live site.
