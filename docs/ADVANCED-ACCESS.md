# Advanced access

Two capabilities are switched off until you ask for them. This page says exactly
what each one costs, because the whole point of this extension is that you should
not have to guess.

Open them from **chrome://extensions → OpenFullPage → Extension options**.


## Capture inside cross-origin frames

**What it does.** Content embedded from another site, maps, videos, comment
widgets, embedded documents, is captured in full, including whatever sits below
that frame's own scrollbar.

**What it costs.** The `webNavigation` permission and access to **every site you
visit** (`<all_urls>`).

### Why the cost is that high

Chrome offers no narrower version of this. A page cannot read the height of a
frame served by another domain, the browser blocks it, deliberately, and that
block is what keeps sites from spying on each other. The only way around it is to
run our own code *inside* every frame, and permission to do that is granted per
origin. Since a frame can come from any origin, the request is for all of them.

There is no honest way to ask for less. So it is off by default, requested only
when you tick the box, and revocable at any time from the same box or from
`chrome://extensions`.

### What it does *not* change

**The extension still cannot send anything anywhere.** Its content security policy
sets `connect-src 'none'`, which Chrome enforces regardless of what permissions
have been granted. Reading a page and being able to transmit what you read are
separate powers, and this extension has never had the second one, enforced on
every commit by `test/invariants.test.js`.

So the honest summary is: granting this lets the extension *see* more of what is
on your screen at the moment you press capture. It does not give it a way to tell
anyone about it.

### What you get without it

Quite a lot, and it is worth knowing before you decide:

- Frame content that is **visible on screen** is already captured, cross-origin
  included. `captureVisibleTab` photographs what is painted, and no permission is
  involved.
- **Same-origin frames** are already expanded to their full height and captured
  entirely, because the page holding them is allowed to read their height.

The only gap this setting closes is content below a **cross-origin** frame's own
scrollbar. For most pages that is nothing at all.


## Extra capture modes

**What it does.** Adds two more ways to capture:

| Mode | Shortcut |
|---|---|
| Visible area only | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>V</kbd> |
| Pick an element | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd> |

It also lets you change what a plain toolbar click does, and add a delay before
capturing so you can open a menu first.

**What it costs.** Nothing. No permission is involved.

**Why it is off by default.** So that one click always means one thing. With this
off, the toolbar button captures the whole page, every time, on every site.


## What is stored

Your settings, in `chrome.storage.local`, on this computer. They are **never
synced**: the synced storage area would copy your configuration to Google's
servers, and `test/invariants.test.js` bans that API outright so it cannot start
happening quietly.

Permission states are not stored at all. The settings page reads them from
`chrome.permissions.contains()` every time it opens, so if you revoke access
elsewhere the checkbox tells you the truth rather than what we last recorded.
