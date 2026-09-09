# Context map

Which file to read for what. Written so an agent reads three files instead of
fifteen.

## By question

| Question | File |
|---|---|
| What am I allowed to do here? | [../AGENTS.md](../AGENTS.md) |
| How does a capture actually work? | [ARCHITECTURE.md](ARCHITECTURE.md) |
| What does `outputScale` mean? | [DOMAIN.md](DOMAIN.md) |
| Why is it built this way? | [DECISIONS.md](DECISIONS.md) |
| What is known to be broken or missing? | [LIMITATIONS.md](LIMITATIONS.md) |
| What should I work on? | [../TASKS.md](../TASKS.md) |
| What was deliberately deferred? | [../TODOS.md](../TODOS.md) |
| Where is the product going? | [ROADMAP.md](ROADMAP.md) |
| How do I release, or roll back? | [PLAYBOOK.md](PLAYBOOK.md) |
| How do I run the tests? | [TESTING.md](TESTING.md) |
| What do we promise users about privacy? | [PRIVACY.md](PRIVACY.md) |
| What does the optional broad permission cost? | [ADVANCED-ACCESS.md](ADVANCED-ACCESS.md) |
| How does a user verify their install? | [VERIFYING-YOUR-INSTALL.md](VERIFYING-YOUR-INSTALL.md) |
| What does the store listing say? | [../store/LISTING.md](../store/LISTING.md) |
| Why is the icon the way it is? | [`../tools/icon-design.mjs`](../tools/icon-design.mjs), and [DECISIONS.md](DECISIONS.md) D22 |
| How do I check an interface actually renders correctly? | [`../test/e2e/page-audit.js`](../test/e2e/page-audit.js), and D23 |
| Why did my CSS rule not apply? | Specificity. [../AGENTS.md](../AGENTS.md), coding conventions |
| How does the grouped toolbar work? | [ARCHITECTURE.md](ARCHITECTURE.md), "The toolbar is groups of controls" |
| Why does cropping not crop straight away? | [DECISIONS.md](DECISIONS.md) D30 |
| How is a PDF written with no dependencies? | [`../src/lib/pdf.js`](../src/lib/pdf.js), and D31 |
| Why is "system" not just light? | [`../src/lib/theme.js`](../src/lib/theme.js), and D32 |
| May I name another product, in code or in a document? | No. [DECISIONS.md](DECISIONS.md) D34, enforced by `scanBrands` over `src/`, `docs/`, `store/`, `tools/` and the root Markdown |
| Why does git history start at one commit? | [DECISIONS.md](DECISIONS.md) D35 |
| Why is the page behind the capture not white? | [DECISIONS.md](DECISIONS.md) D36 |
| Why will my SVG not hide? | It is not an HTML element. [DECISIONS.md](DECISIONS.md) D37 |
| My popover is in the DOM and I cannot see it | An ancestor is clipping it. [DECISIONS.md](DECISIONS.md) D38 |
| Why does a popover live inside another popover? | [DECISIONS.md](DECISIONS.md) D40 |
| Why does picking Arrow change the stroke style? | [DECISIONS.md](DECISIONS.md) D41 |
| What is the cursor supposed to say? | [DECISIONS.md](DECISIONS.md) D42 |
| Where does the website live? | [PLAYBOOK.md](PLAYBOOK.md), "The other two repositories" |
| Who controls this project and what happens if it is sold? | [../GOVERNANCE.md](../GOVERNANCE.md) |
| How do I report a vulnerability? | [../SECURITY.md](../SECURITY.md) |

## By source file

| File | Holds | Read before touching |
|---|---|---|
| `src/background.js` | Capture orchestration, the tile walk, progress, the result tab port | ARCHITECTURE, DOMAIN |
| `src/lib/plan.js` | Tile arithmetic, canvas limits, scale, filenames. Pure, heavily tested | DOMAIN |
| `src/lib/edit.js` | The editing model: shapes, history, geometry, hit testing. Pure | DOMAIN, DECISIONS |
| `src/lib/settings.js` | Settings, defaults, sanitising, the style Reset restores, the optional permission set | AGENTS (the `sanitise` trap) |
| `src/lib/pdf.js` | PDF writing, by hand. Page planning, deflate, the file structure. Pure | DECISIONS D31 |
| `src/lib/theme.js` | The three theme states and how they are stamped on a document | DECISIONS D32 |
| `src/lib/badge.js` | Toolbar icon progress drawing | nothing |
| `src/ui/result.js` | Stitching, filename, format menu, export, keyboard. The most churned file | ARCHITECTURE, LIMITATIONS |
| `src/ui/editor.js` | Canvas rendering and pointer input for the editor | DOMAIN, DECISIONS |
| `src/ui/options.js` | Settings page, the optional permission toggle | ADVANCED-ACCESS |
| `src/ui/progress.js` | The capture progress popup | nothing |
| `src/content/measure.js` | Page metrics, injected | DOMAIN |
| `src/content/prepare.js` | Sticky and fixed handling, scrolling, lazy loading, frames | ARCHITECTURE, DOMAIN |
| `src/content/pick.js` | The element picker | nothing |
| `test/invariants.test.js` | The security invariants. The heart of the project | AGENTS |
| `test/lib/scan.js` | The banned pattern scanner and manifest checks | AGENTS |
| `tools/pack.mjs` | Deterministic zip packaging | AGENTS |
| `tools/verify-crx/` | Go binary that compares an installed extension to this tree | VERIFYING-YOUR-INSTALL |

## Reading order for a cold start

1. [../CLAUDE.md](../CLAUDE.md)
2. [../AGENTS.md](../AGENTS.md)
3. This file
4. Whatever the table above points at for the task in hand
