# Verifying your install

You do not have to trust the maintainer of this extension, and you do not have to
trust the Chrome Web Store. You can check, on your own machine, that the code your
browser is running is exactly the code published here.

## Why this is possible here and not elsewhere

Most extensions are bundled, transpiled and minified before publication. The file
Chrome runs bears no resemblance to any file in the project's repository, so the
best you can do is reproduce the build and hope it lands on the same bytes.

OpenFullPage has **no build step**. No bundler, no transpiler, no minifier, no
dependencies. `src/background.js` in this repository *is* `src/background.js` in
your browser, character for character. Verification is therefore a file comparison,
which anyone can do and nobody can fake.

CI enforces this: `test/invariants.test.js` fails the build if the packaged zip ever
differs from the source tree by a single byte.

## The one-minute version

Find the installed copy. On macOS:

```bash
ls ~/Library/Application\ Support/Google/Chrome/Default/Extensions/
```

Chrome names the folder after the extension ID, with one subfolder per installed
version. Then, from a checkout of this repository at the matching tag:

```bash
diff -r --exclude=_metadata \
  ~/Library/Application\ Support/Google/Chrome/Default/Extensions/<id>/<version>/ \
  ./
```

`_metadata/` is added by Chrome after signing and is not ours. Files that exist only
in the repository, `test/`, `tools/`, `docs/`, `LICENSE`, are expected: they are
not shipped in the extension.

**Any other difference means the code running in your browser is not the code in
this repository.**

Other platforms:

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Google/Chrome/<Profile>/Extensions/` |
| Linux | `~/.config/google-chrome/<Profile>/Extensions/` |
| Windows | `%LOCALAPPDATA%\Google\Chrome\User Data\<Profile>\Extensions\` |

## The thorough version: verify-crx

`diff -r` tells you *that* something differs. `verify-crx` tells you what, hashes
every file, and exits non-zero so you can run it from a script or a cron job.

```bash
cd tools/verify-crx
go build -o verify-crx .
```

One static binary, no dependencies, nothing to install but Go itself.

### Compare what is running against this repository

```bash
./verify-crx compare \
  ~/Library/Application\ Support/Google/Chrome/Default/Extensions/<id>/<version>/ \
  ../../
```

```
checked 13 files from .../Extensions/<id>/1.0.0/

OK, every shipped file is byte-identical to the source tree.
```

It ignores `_metadata/`, `.git/`, `dist/` and `.DS_Store`, and it ignores files that
exist only in the source tree. It reports two kinds of problem:

- **NOT IN THE SOURCE TREE**: the extension is running a file this repository does
  not contain.
- **DIFFERENT FROM THE SOURCE TREE**: the extension is running a modified version
  of a file it does contain.

Either is serious. Check you compared against the tag matching the installed
version before concluding anything, then open an issue.

### Check a published package

```bash
./verify-crx zip openfullpage-1.5.0.zip ../../
```

Packaging is also deterministic: `./tools/pack.sh` on a clean checkout produces a
byte-identical archive, so you can reproduce the SHA-256 recorded in
[CHANGELOG.md](../CHANGELOG.md) rather than only comparing it against a file you
already downloaded.

### Publish or compare a single digest

```bash
./verify-crx digest ~/Library/.../Extensions/<id>/<version>/
```

Prints a SHA-256 per file and one `tree-sha256` over the whole tree, so two people
can compare one line instead of a directory listing. The digest covers file names as
well as contents, so a renamed file changes it.

## What this does and does not prove

**It proves** the bytes running in your browser match this repository, that no
extra code was added between the public source and the published extension. That is
the check the whole design exists to make possible, and the one an extension with a
build step cannot offer you at all.

**It does not prove** the source itself is safe: that is what reading it is for.
The shipped surface is 17 files and about 6,200 lines, of which roughly 3,100 are
JavaScript statements and most of the rest are comments explaining why. There are no
dependencies, so that is the whole of it: reading all of it is a realistic weekend,
and reading `manifest.json` plus `src/background.js` is a realistic hour.

Two habits make the check meaningful:

1. **Compare against a signed tag**, not against `main`. `git verify-tag v1.0.0`.
2. **Re-run it after an update.** Silent auto-update is the delivery mechanism this
   whole design is defending against; a one-time check at install time is exactly
   the check that misses it.

See [GOVERNANCE.md](../GOVERNANCE.md) for the non-transfer covenant and the canary
that goes with this.
