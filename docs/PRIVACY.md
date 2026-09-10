# Privacy policy

**OpenFullPage collects no data. None. It has no ability to.**

Last updated: 2026-09-09 · Applies to: OpenFullPage 1.0.0 and later

## What is collected

Nothing.

- No personal information, no account, no sign-in.
- No analytics, no telemetry, no crash reporting, no unique identifiers.
- No browsing history, no page content, no cookies.
- No advertising, no third-party services of any kind.

## What happens to your screenshots

They are composited in your browser's memory and written wherever you save them:
your own downloads folder, as PNG, JPEG, WebP or PDF, or your clipboard. They are never
uploaded, and they are never seen by anyone but you.

The Upload button is a hand off, not an upload. It copies the image to your
clipboard and opens the image host you chose in a new tab, so that you paste it
there yourself. The extension performs no upload and could not: `connect-src 'none'`
blocks every outbound request it could make. What you then paste, and to whom, is
between you and that host.

## Why you do not have to take this on trust

This is not a policy commitment that could be quietly reversed in a future update.
It is a property of how the extension is built:

- Its content security policy declares **`connect-src 'none'`**. Chrome itself
  refuses to let the extension open a network connection. There is no setting or
  update that loosens this without the change being visible in `manifest.json`.
- It holds **no host permissions by default**, so it cannot read the sites you
  visit. It can read one tab, at the moment you click its button on that tab, and
  no other. Broad access exists only as an option you must switch on yourself, and
  can revoke, and even then, `connect-src 'none'` still applies.
- It stores **only your own settings**, with `chrome.storage.local`, on this
  computer. The synced storage area, which would copy data to Google's servers,
  is banned outright by the invariants.
- It contains no `eval`, no `new Function`, and no `update_url` for
  self-distribution, so it cannot fetch or generate code at runtime.

Every one of these is checked automatically on every change to the source, by
`test/invariants.test.js`. A change that weakens any of them fails the build.

You can confirm the code running in your browser is the code published in the
repository: see [VERIFYING-YOUR-INSTALL.md](VERIFYING-YOUR-INSTALL.md).

## Permissions and what they are for

| Permission | Purpose |
|---|---|
| `activeTab` | Read the one tab you clicked the button on, in order to capture it |
| `scripting` | Measure the page, load content below the fold, hide repeating fixed headers |
| `storage` | Remember your settings on this computer. Never synced |
| `downloads` (optional) | Save the finished image. Asked for when you press Download, not at install, and never if you only view or copy the image |
| `webNavigation` + `<all_urls>` (optional, off) | Only if you switch on cross-origin frame capture. See [ADVANCED-ACCESS.md](ADVANCED-ACCESS.md) |

## Changes to this policy

If this ever changes, it should not, the change will appear in this file's git
history and in [CHANGELOG.md](../CHANGELOG.md) before any release that contains it.
A version that collects data would require new permissions, which Chrome would
prompt you to re-approve.

See also [GOVERNANCE.md](../GOVERNANCE.md), which records a public commitment never
to sell or transfer this extension, and the canary that lets you check it.

## Contact

Open an issue on the project's repository.
