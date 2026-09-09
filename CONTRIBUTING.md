# Contributing

This is a solo maintained project with an unusual constraint set. Read
[AGENTS.md](AGENTS.md) before writing anything, whether you are a person or an
agent: it is the contract, not a style guide.

## Before you start

Open an issue describing what you want to change. For anything that touches
permissions, storage, the manifest, or the packaging, do this first: those changes
have a decision record attached (see [docs/DECISIONS.md](docs/DECISIONS.md)) and a
pull request that violates one will be closed rather than revised.

## Setup

```bash
git clone <this repo>
node --test 'test/**/*.test.js'
```

That is the whole setup. There is no install step because there are no dependencies,
and no build step because the shipped zip is byte identical to the tree. Node 22 or
newer. To run the extension: `chrome://extensions`, Developer mode, Load unpacked.

## The five things a pull request must not do

1. Add a network call of any kind.
2. Add a dependency, a bundler, a transpiler or a minifier.
3. Add a required host permission, or anything beyond `activeTab`, `scripting` and
   `storage` at install.
4. Use `chrome.storage.sync`, `eval`, `new Function`, or `update_url`.
5. Weaken or delete a check in `test/invariants.test.js` or `test/lib/scan.js`.

CI fails on all five. They are the product, not the guardrails around it.

## Branches and commits

- Branch from `main`.
- Commit subjects follow the existing history: a version for releases
  (`1.6.1: store title, and a short name to protect filenames`), a plain imperative
  otherwise.
- One logical change per pull request. A feature and its tests land together.

## Writing style

No em dashes, no en dashes, no double or triple hyphen used as punctuation, and no
horizontal rules made of hyphens. That applies to prose, code comments, commit
messages, docs and UI strings alike. Use a comma, a colon, a full stop or
parentheses, or rewrite the sentence. Command line flags such as `node --test` are
not punctuation and stay as they are.

## Code conventions

- ES modules, no framework.
- Pure logic in `src/lib/`, unit tested in Node. DOM and `chrome.*` in `src/ui/`,
  `src/content/` and `src/background.js`.
- Content scripts are injected function by function, so every function in
  `src/content/` must be self contained: no imports, no module scope.
- Comments explain why, not what. `src/lib/plan.js` is the reference.
- Errors are named and user visible. No silent catch.
- New setting keys go in both `DEFAULTS` and `sanitise()` in `src/lib/settings.js`.

## Tests

Node's built in runner. Unit tests for anything pure, end to end tests
(`test/e2e/run.mjs`, real Chrome over CDP) for anything that touches the DOM or
Chrome APIs. A change to capture or the editor should run both.

`test/fixtures/violation.js` is deliberately poisoned so the scanner is tested
before the thing it gates. Do not clean it up.

## Reviews

The maintainer reviews everything. Expect questions about permissions and
dependencies before questions about style. A change that is correct but weakens an
auditable property will be declined even if the code is good.

## Major UI changes

Layout changes, control grouping, new panels and anything that moves a familiar
control need explicit approval before implementation, and approval needs a before
and after preview. Come with the preview.
