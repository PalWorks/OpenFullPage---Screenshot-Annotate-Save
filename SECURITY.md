# Security

## Reporting a vulnerability

Email the maintainer rather than opening a public issue, and give a description of
the class of problem plus the steps to reproduce it. If you do not get an
acknowledgement within seven days, open a public issue saying only that you are
waiting on a security response. Do not include a working exploit in a public issue.

## The threat model this project exists to answer

The risk in this category is not a clever exploit. It is ownership.

A screenshot extension accumulates a large install base. The install base is an
asset, and it trades: figures of roughly $0.20 to $1 per weekly active user
circulate openly in the brokerage market for browser extensions. It changes hands.
The new owner ships an update, and Chrome only re-prompts users when *permissions
increase*, so nobody re-consents and nobody notices. This is a documented pattern
across the extension ecosystem rather than a hypothetical, and it is not specific
to any one product.

This repository makes no accusation against any named extension. It does not need
to: the mechanism is the problem, and the mechanism works the same way whoever is
holding the account.

Everything in this repository is aimed at that mechanism:

| Defence | Mechanism | Enforced by |
|---|---|---|
| It cannot send your data anywhere | `connect-src 'none'` | Chrome, regardless of permissions |
| It cannot read sites you do not capture | `activeTab` only; broad access is optional and off | Chrome, plus `test/invariants.test.js` |
| It cannot run code from elsewhere | No `eval`, no `update_url`, no remote config | CSP and the source scanner |
| A malicious update cannot hide | No build step, so the shipped zip is diffable against this tree | `tools/pack.mjs` and the byte identical packaging test |
| Ownership cannot change quietly | Non transfer covenant plus a re-signed canary | [GOVERNANCE.md](GOVERNANCE.md) |

## What to check yourself

You do not have to trust any of the above.

```bash
diff -r --exclude=_metadata \
  ~/Library/Application\ Support/Google/Chrome/Default/Extensions/<id>/<version>/ ./
```

Or build the verifier and get a per file hash comparison:

```bash
cd tools/verify-crx && go build -o verify-crx .
./verify-crx compare ~/Library/.../Extensions/<id>/<version>/ ../../
```

Full instructions: [docs/VERIFYING-YOUR-INSTALL.md](docs/VERIFYING-YOUR-INSTALL.md).

## The canary

[GOVERNANCE.md](GOVERNANCE.md) carries a statement, re-signed at every release, that
the maintainer still controls the publisher account, has accepted no acquisition
offer, and has not been compelled to alter the extension.

**If that line is missing, stale by more than one release, or reworded, treat this
extension as compromised and uninstall it.** A canary that is quietly softened is
the signal, not the absence of bad news.

## Scope

In scope: anything that lets the extension read data it should not, send data
anywhere, execute code from outside the repository, or acquire a permission the user
did not grant. Also in scope: any way the published build could differ from this
repository without detection.

Out of scope: the fact that a captured image contains whatever was on the page, and
denial of service against your own browser tab.
