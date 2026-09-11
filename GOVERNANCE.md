# Governance

OpenFullPage exists because of a specific, documented failure mode in the Chrome
Web Store: an extension with a large install base changes hands, and the new owner
ships malware through silent auto-update. Chrome only re-prompts users when
*permissions* increase, so nobody re-consents. The install base is the asset, and
it trades: figures of roughly $0.20 to $1 per weekly active user circulate openly in
the brokerage market for browser extensions.

Every rule below targets that mechanism.

## Writing style

No em dashes, no en dashes, no double or triple hyphen used as punctuation, and no
horizontal rules made of hyphens. That applies to prose, code comments, commit
messages, docs and UI strings alike. Use a comma, a colon, a full stop or
parentheses, or rewrite the sentence. Command line flags such as `node --test` are
not punctuation and stay as they are.

## Non-transfer covenant

**This extension's Chrome Web Store listing and its publisher account will not be
sold, transferred, or handed to another party.** Not to an acquirer, not to an
"extension management" firm, not to anyone who emails offering to buy it.

If the current maintainer can no longer maintain it, the extension will be
**unpublished** and the repository **archived**. It will not be passed on.

## Canary

The line below is re-signed at every release. **If it is missing, stale by more
than one release, or removed, treat this extension as compromised and uninstall it.**

> As of **2026-09-11**, the maintainer has sole control of the publisher account,
> has received no acquisition offer that was accepted, and has not been compelled
> by any party to alter this extension.

## Publish credential

The Google account holding the Web Store listing and the GitHub account holding
this repository are both protected by **hardware-backed 2FA** (passkey or security
key). SMS 2FA is not sufficient, the publish credential is the crown jewel.

## Release integrity

- Every release is a **signed git tag**.
- The SHA-256 of every published zip is recorded in [CHANGELOG.md](CHANGELOG.md).
- There is **no build step**. The zip contains the repository's source files
  verbatim, and CI fails if they ever diverge, so anyone can compare the bytes
  running in their browser against this repository without trusting the
  maintainer *or* Google.

## The repository is never deleted

Only archived. In more than one documented extension takeover the source
repository was deleted at handover, which is the loudest available warning signal
and was missed every time. Committing never to delete this one turns that signal
into something a reader can rely on: a repository that has gone means something has
gone wrong.

## Single maintainer

This project currently has one publisher, which means there is no two-human gate
on a release. That is a known weakness, mitigated by the controls above. A second
maintainer will be recruited before the extension crosses roughly **50,000 users**.

## Scope limits

These are structural, enforced by CI (`test/invariants.test.js`), not promises:

- No network access of any kind. The CSP declares `connect-src 'none'`.
- No `host_permissions`, no `web_accessible_resources`, no `externally_connectable`.
- No accounts, no telemetry, no analytics, no remote configuration.
- **No monetisation that creates an obligation.** The rule this replaces said
  "no monetisation" flatly, and the reasoning behind it was always about one
  mechanism: a paid tier needs accounts, accounts need authentication,
  authentication needs a server, and a server is the thing this extension is
  built not to have. That chain is what is banned, whatever it is called:
  subscriptions, licences, seats, a pro build, a trial, an unlock.

  A gift starts no such chain. A link to a funding page needs no account, no
  authentication and no server of ours, and the browser makes that request when
  the reader clicks it, not the extension, so `connect-src 'none'` stays
  literally true. A donation link is therefore allowed, under three conditions
  which are the whole reason for allowing it:

  - **No feature is ever gated, delayed or degraded for anyone who does not
    pay.** The moment money buys something, the ban above applies again.
  - **Nothing is ever asked for inside a capture or an editor.** The options
    page and the repository, nowhere else.
  - **Every rupee is published.** Whichever platform holds it, the ledger is
    public, because this project's argument is that you should not have to take
    its word for anything.

A pull request that weakens any of these fails CI. Changing the invariants and the
code in the same commit is the thing to watch for in review.
