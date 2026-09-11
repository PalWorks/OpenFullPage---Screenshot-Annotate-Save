# Memory

Durable context that is not derivable from the code, the tests, or the git history.
Assumptions, constraints and standing decisions that would otherwise be re-derived
or accidentally reversed.

Dates are absolute.

## Why this project exists

Browser extensions with large install bases are bought and sold, and an extension
that changes hands can ship whatever the new owner likes through an ordinary auto
update. Chrome re-prompts users only when permissions increase, so an update that
stays inside the permissions already granted is invisible. That mechanism, not any
particular product, is what every constraint in this repository points at. If a
change makes the extension better but less auditable, it is the wrong change. The
governance answer to it is in [../GOVERNANCE.md](../GOVERNANCE.md).

## What the comparison work established, as of 2026-09-08

Several extensions in this category were compared in September 2026, by installing
them and using them as a user does, and by reading the material anyone can read:
the store listing and the marketing site. **No other extension's source was read,
copied or adapted**, and none may be. Nothing about any individual product is
recorded here; what survived the comparison is the set of conventions the whole
category shares, which belong to nobody.

Two conclusions worth keeping:

- The contrast that matters is not the feature list, it is the manifest. Extensions
  in this category typically require access to every site you visit **at install**.
  Their privacy claim is a promise; ours is enforced by Chrome. That is the
  strongest line this product has, and it costs nothing to make because it is
  checkable in the reader's own browser.
- Nothing observed in the comparison was worth trading the boundary for. Every
  feature they hold that we refuse is refused for a reason recorded in the roadmap,
  not for lack of time.

Nothing about an identifiable third party is asserted in this repository unless it
is sourced and checkable, which is why this section carries no names, no install
counts and no store history. See [DECISIONS.md](DECISIONS.md) D34.

## Standing decisions

- **The store title is settled.** `OpenFullPage - Capture Screen, Annotate, Save`
  stands, decided 2026-09-08. The SEO objection was heard and set aside: the phrase
  order is weaker than "screen capture" and "screenshot" is absent, so revisit only
  if listing impressions come in low. Do not re-raise it otherwise.
- **`short_name` protects filenames.** Download names are built from the manifest
  `short_name`, capped at 40 characters, so the listing title can be rewritten for
  SEO without ever lengthening a filename. Chrome caps `short_name` at 12
  characters and `OpenFullPage` is exactly 12, so there is no slack.
- **Apply and Discard staging was rejected** on 2026-09-08 after the maintainer
  reviewed the tradeoff. Only the `beforeunload` guard was kept. See
  [DECISIONS.md](DECISIONS.md) D14.
- **Major UI changes require a before and after preview** before approval. This is a
  standing working agreement, not a one off.
- **The brand is teal, and violet is out.** Decided 2026-09-09 after two rejected
  marks. The extension icon is a retro camera caricature on a teal disc, drawn as
  geometry in `tools/icon-design.mjs`. See [DECISIONS.md](DECISIONS.md) D22. The
  editor interface has *not* been recoloured yet, because that needs a preview.
- **GitHub Actions stay minimal**, in this repository and every other. No workflow
  is added unless it enforces something that cannot be checked locally. The website
  deploys from a branch precisely so that it needs no workflow at all.
- **The support address in `src/ui/options.js` is a personal one** and should become
  a role address before the listing is public.

## Where things live, as of 2026-09-09

| | |
|---|---|
| Extension source | this repository, `PalWorks/OpenFullPage---Screenshot-Annotate-Save`, **cleared to publish**, see below |
| Website | `PalWorks/openfullpage-site`, **public**, <https://palworks.github.io/openfullpage-site/> |
| Store listing and assets | `store/` in this repository |
| Rejected logo variants | `~/Documents/openfullpage-logo-options/`, outside the repository |

The extension repository is still private, and everything that was gating its
publication is done as of 2026-09-09: the sanitisation pass (D34), the widened
scanner that keeps it done, and the history rebuild (D35). Flipping the switch is
the maintainer's, one command:

```bash
gh repo edit PalWorks/OpenFullPage---Screenshot-Annotate-Save --visibility public
```

The argument for keeping it closed was that `docs/ROADMAP.md` publishes the feature
order for the next six releases. The argument that won is that the product's whole
claim is "read it yourself", and a claim nobody can check is not a claim. The
roadmap goes into the open with it.

## Assumptions this codebase makes

- One capture at a time, one result tab per capture, one document per result tab.
  Multi part export (F10) is the first thing that breaks the last of these.
- Chrome only, Manifest V3, minimum version 116.
- The user is on a desktop with a pointer. Every drawing interaction assumes it.
- Nothing is persisted except settings. Capture history (F11) is the first feature
  that would change this, which is why it is opt in.

## Things that look like bugs and are not

- Gaps in shape id numbering: `nextId` is module state shared across documents (D12).
- `system-ui` as the interface font: a webfont is a banned network request (D13).
- No pixel eraser: it would break the immutable base image (D5, L16).
- Settings do not sync between machines: `chrome.storage.sync` is banned (D2).
