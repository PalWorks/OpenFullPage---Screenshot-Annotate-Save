# CLAUDE.md

Entry point for Claude Code and any other coding agent working in this repository.
Read this first, then [AGENTS.md](AGENTS.md). Read
[docs/CONTEXT_MAP.md](docs/CONTEXT_MAP.md) to find anything else.

## What this is

OpenFullPage is a Chrome extension that captures a whole web page as one image,
lets you annotate it, and saves it. It exists because browser extensions with large
install bases are bought and sold, and an extension that changes hands can ship
whatever the new owner likes through an ordinary auto update, which Chrome does not
re-prompt for as long as the permissions do not widen.

The product is not the feature list. The product is that the feature list is
delivered **without** network access, dependencies, a build step, or broad site
permissions, and that anyone can verify this in about five minutes.

## The five rules you must not break

1. **No network.** `connect-src 'none'` is in the manifest CSP. No `fetch`, no
   `XMLHttpRequest`, no WebSocket, no remote font, no remote image, no analytics.
2. **No remote code.** No `eval`, no `new Function`, no `update_url`, no remote
   config, no remotely updated lists of any kind.
3. **No dependencies and no build step.** The shipped zip is byte identical to this
   repository. `test/invariants.test.js` proves it. Adding a package breaks the one
   property that makes the extension auditable.
4. **No permission granted silently at install** beyond `activeTab`, `scripting`
   and `storage`. Anything broader is optional, off by default, and revocable.
5. **No synced storage.** `chrome.storage.sync` sends user configuration to Google.
   Only `chrome.storage.local`.

CI fails on every one of these. If a task seems to require breaking one, the task is
wrong, not the rule. Say so and stop.

## Working agreements with the maintainer

- **Major UI and UX changes need explicit approval before they are built, and
  approval is only given after seeing a before and after preview.** Come prepared
  with the preview; do not ask for a decision without one. This covers toolbar
  layout, control grouping, new panels, navigation, and anything that changes where
  a familiar control lives. It does not cover a single new menu item in an existing
  menu, or copy changes.
- **Writing style, everywhere:** no em dashes, no en dashes, no double or triple
  hyphen used as punctuation, no horizontal rules made of hyphens. This applies to
  prose, code comments, commit messages, docs, and UI strings. Use a comma, a colon,
  a full stop, or parentheses, or rewrite the sentence. Command line flags such as
  `node --test` are not punctuation and stay as they are.
- **GitHub Actions stay minimal.** Do not add a workflow, a job, or a scheduled run
  unless it enforces something that cannot be checked locally. Prefer a step in the
  existing job over a new workflow file. No linting, formatting, dependency bots,
  release automation or coverage uploads unless asked. `.github/workflows/ci.yml` is
  the exception that earns its place: it is what turns the five rules into tests.
- **Verify before claiming.** This repo's whole method is turning promises into
  tests. Do the same with your own claims: run the suite, do not assert it passes.

## Commands

```bash
node --test 'test/**/*.test.js'     # 264 unit tests plus the security invariants
node test/e2e/run.mjs               # real Chrome, drives a capture over CDP
node tools/make-icons.mjs --check   # icons still match their design source
./tools/pack.sh                     # build dist/openfullpage-<version>.zip
```

Full command table and the release checklist: [docs/PLAYBOOK.md](docs/PLAYBOOK.md).

## Testing

Node's built in runner, no framework. Unit tests live in `test/*.test.js` and cover
the pure modules (`src/lib/`). Anything touching the DOM or Chrome APIs is covered
by the end to end suite in `test/e2e/`. See [docs/TESTING.md](docs/TESTING.md).

## Where to start

| You are doing | Read |
|---|---|
| Anything at all | [AGENTS.md](AGENTS.md) |
| Looking for a file | [docs/CONTEXT_MAP.md](docs/CONTEXT_MAP.md) |
| Understanding the capture pipeline | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| Confused by a term in the code | [docs/DOMAIN.md](docs/DOMAIN.md) |
| Wondering why something is the way it is | [docs/DECISIONS.md](docs/DECISIONS.md) |
| Picking up work | [TASKS.md](TASKS.md), then [docs/ROADMAP.md](docs/ROADMAP.md) |
| About to hit a known edge | [docs/LIMITATIONS.md](docs/LIMITATIONS.md) |
| Releasing | [docs/PLAYBOOK.md](docs/PLAYBOOK.md) |

## Skill routing

When the request matches an available gstack skill, invoke it with the Skill tool.
When in doubt, invoke the skill.

- Product ideas and brainstorming: `/gstack-office-hours`
- Strategy and scope: `/gstack-plan-ceo-review`
- Architecture: `/gstack-plan-eng-review`
- Design system or plan design review: `/gstack-design-consultation`, `/gstack-plan-design-review`
- Full review pipeline: `/gstack-autoplan`
- Bugs and errors: `/gstack-investigate`
- QA and site behaviour: `/gstack-qa` or `/gstack-qa-only`
- Code review of a diff: `/gstack-review`
- Visual polish: `/gstack-design-review`
- Ship, deploy, PR: `/gstack-ship`, `/gstack-land-and-deploy`
- Save or resume context: `/gstack-context-save`, `/gstack-context-restore`
- Turn vague intent into a spec: `/gstack-spec`
