# Chrome Web Store listing

Everything the Developer Dashboard asks for, written out so it can be pasted in
rather than improvised at submission time. Every claim here is one the code
actually supports; if a feature moves, this file moves with it.

Assets live beside this file. Screenshots are real captures of the product taken
by `node test/e2e/run.mjs --market --shots <dir>`, which drives the real extension
in real Chrome, so they cannot drift from what the extension does.

## Store listing tab

### Name

```
OpenFullPage - Capture Screen, Annotate, Save
```

44 of the 45 characters allowed. Settled on 2026-09-08, see `docs/MEMORY.md`.

### Summary

The short description, 132 characters maximum.

```
Capture a whole web page as one image, annotate it, save it. No network access at all, and you can check that yourself.
```

118 characters.

### Detailed description

```
I'm tired of free screenshot extensions planting malicious code, cookies, tracking users and profiting via referrals using unsuspecting users.

I'm also tired of decent extensions offering basic functionalities for free, and then charging for even slightly useful functionalities.

Thus, have prepared this fully open source Full Page Screen Capture, Edit, Annotate, Save and Upload Chrome Extension

OpenFullPage takes a picture of an entire web page, not just the part you can see, lets you mark it up, and saves it.

It also does something unusual for this category: it proves it is not sending your screenshots anywhere.


WHAT IT DOES

- Captures a whole page of any length as a single image
- Or just the visible area, or one element you point at
- Lets you stop a capture early and keep the part it reached, for pages that never
  finish loading
- Optionally saves straight to your downloads folder, with no editor at all
- Holds sticky headers and floating bars still, so they do not repeat down the image
- Waits for lazy-loaded images before capturing each screenful
- Annotates with arrows, lines, boxes, ellipses, a highlighter, text and numbered steps
- Fills shapes with a colour and an opacity you choose, from any colour, not a fixed palette
- Redacts by destroying the pixels underneath, not by covering them
- Crops with a region you can adjust and confirm, rather than cutting on release
- Undoes and redoes every edit
- Light, dark, or whatever your system is set to
- Saves as PNG, JPEG, WebP or PDF with a filename you can edit, or copies to the clipboard
- Hands the image to an image host of your choice through your clipboard, if you want a link


WHY YOU CAN BELIEVE THE PRIVACY CLAIM

Every extension in this category says it respects your privacy. The difference
here is that you do not have to take anyone's word for it.

1. NO NETWORK ACCESS
   The extension manifest sets connect-src 'none'. That is not a promise about
   how the code behaves. It is an instruction to Chrome to refuse every outbound
   request the extension could make: fetch, XMLHttpRequest, WebSocket, beacons.
   Open DevTools, capture a long page, and watch the Network tab stay empty.

2. NO REMOTE CODE
   No eval, no new Function, no update server of our own, no remotely fetched
   configuration or blocklists. Nothing arrives after you install.

3. NO DEPENDENCIES AND NO BUILD STEP
   The package you install is byte for byte the files in the public repository.
   There is no bundler in between that could add something you did not read. The
   build proves it by rebuilding the package and diffing it against the source.

4. NO BROAD PERMISSIONS AT INSTALL
   Only activeTab, scripting and storage. It cannot read a page until you click
   the button on that page. Everything wider is optional, off by default, and
   revocable.

5. NO SYNCED STORAGE
   chrome.storage.sync would send your settings to Google's servers. Settings
   stay on the machine that made them. You can export them to a file yourself if
   you want to move them.

All five are checked on every commit and the build fails if any is broken.


NO ACCOUNT, NO ANALYTICS, NO PAID TIER

There is nothing to sign in to and nothing to upgrade. There is also no reason
for us to collect anything about you, because there is no product to sell you
later.


OPEN SOURCE

GPL-3.0. Read the code, run the tests, rebuild the package and compare it with
what you installed. It takes about five minutes and the instructions are on the
site.


WHAT IT CANNOT DO

Honesty runs both ways, so: it cannot capture the Chrome Web Store, chrome://
pages, or other extensions' pages, because Chrome forbids extensions from
touching those. Pages taller than 16,384 pixels are scaled down to fit rather
than cut off, because that is Chrome's canvas limit, and the editor tells you
when that has happened. There is no cloud history and no share link, because
both would need the network access this deliberately does not have.
```

### Category

`Workflow & Planning`. Second choice `Developer Tools`.

### Language

English (United Kingdom). The interface says "colour" and "sanitise", so the
listing should not say "color". This is a change from the earlier draft, which
said United States.

## Graphic assets

| Asset | File | Size | Required |
|---|---|---|---|
| Store icon | `promo/store-icon-128.png` | 128x128 | yes |
| Screenshot 1 | `screenshots/shot-capture.png` | 1280x800 | at least one |
| Screenshot 2 | `screenshots/shot-annotate.png` | 1280x800 | |
| Screenshot 3 | `screenshots/shot-redact.png` | 1280x800 | |
| Screenshot 4 | `screenshots/shot-save.png` | 1280x800 | |
| Screenshot 5 | `screenshots/shot-upload.png` | 1280x800 | |

The names are the harness's, not this file's. `marketingShots()` in
`test/e2e/run.mjs` decides them, and this table follows it, so regenerating can
never leave a listing pointing at a file that is no longer produced.
| Small promo tile | `promo/small-tile-440x280.png` | 440x280 | yes |
| Marquee promo tile | `promo/marquee-1400x560.png` | 1400x560 | no |

Screenshot captions, if the dashboard offers them:

1. One image of the whole page, however long it is
2. Arrows, boxes, highlights and numbered steps
3. Redaction that removes the pixels, not just covers them
4. Save as PNG, JPEG, WebP or PDF, with a filename you choose
5. Send it to an image host through your clipboard. The extension never uploads

## Privacy practices tab

### Single purpose

```
OpenFullPage captures a web page as an image, lets the user annotate that image,
and saves it. Every permission it requests serves that one purpose, and all of
the work happens on the user's own computer.
```

### Permission justifications

**activeTab**

```
Reads the page the user has asked to capture. It is granted only at the moment
the user clicks the OpenFullPage toolbar button on that page, and it lapses when
they navigate away. Without it the extension cannot see the page it is being
asked to photograph. This is deliberately used instead of host permissions so
that the extension has no standing access to any site.
```

**scripting**

```
Runs the code that measures the page, scrolls it one screenful at a time, holds
sticky and fixed elements still so they do not repeat down the final image, and
restores the page to how it was afterwards. It can only run in a tab where
activeTab has already granted access for this one capture.
```

**storage**

```
Saves the user's own preferences on their own computer: default capture mode,
annotation colour and stroke width, capture delay, export format, whether captures
go straight to a file, and which toolbar controls they want visible. chrome.storage.local only. The extension
never uses chrome.storage.sync, so no settings are sent to any server.
```

**downloads**

```
Writes the finished image into the user's downloads folder. This permission is
optional and is requested at the moment the user first clicks Save, not at
install time. If the user declines it, the extension keeps working and they can
still right-click the image and save it themselves.

It is also requested from the settings page if the user switches on "Save
straight to your downloads instead of opening the editor", because that mode has
no later click to attach a permission prompt to. Declining leaves the setting off.
```

**webNavigation, and host access to all sites**

```
Optional and switched off by default. When the user turns it on in settings, it
lets the extension enumerate cross-origin iframes so their full contents are
captured rather than only the portion visible on screen. It is requested through
chrome.permissions.request from the settings page, never at install, and the
user can revoke it at any time. With it granted the extension can read pages, and
still cannot transmit anything: the content security policy sets
connect-src 'none'.
```

### Remote code

**No, I am not using remote code.** All code is in the package. There is no eval,
no `new Function`, no remotely loaded script, and no remotely fetched
configuration. `test/invariants.test.js` fails the build if any appears.

### Data usage

Certify that OpenFullPage does **not** collect or use any of:

- Personally identifiable information
- Health information
- Financial and payment information
- Authentication information
- Personal communications
- Location
- Web history
- User activity
- Website content

The extension has no network access, so there is no mechanism by which it could
transmit any of the above. Captured images are held in the tab that made them and
are written only where the user saves them.

Also certify:

- Data is not sold to third parties
- Data is not used or transferred for purposes unrelated to the single purpose
- Data is not used or transferred to determine creditworthiness or for lending

### Host permissions

None are requested at install. `<all_urls>` is declared as an **optional** host
permission, used solely by the opt-in cross-origin frame setting above.

### Privacy policy URL

```
https://palworks.github.io/openfullpage-site/#permissions
```

The wording of that policy lives in [`docs/PRIVACY.md`](../docs/PRIVACY.md), which
is the source of truth. The URL above is where it is published; keep the two in
step, and if the repository becomes public the raw file is an equally valid URL.

## Testing instructions for reviewers

```
No account, no sign-in and no configuration are needed.

1. Install and pin the extension.
2. Open any long page, for example https://developer.mozilla.org/en-US/docs/Web/CSS/position
3. Click the OpenFullPage toolbar button.
   The page scrolls itself to the bottom and back, and a result tab opens with
   the whole page as one image.
4. In the result tab, draw an arrow on the image, then click Save. Chrome will
   ask for the downloads permission at that point; this is expected, and the
   extension continues to work if you decline.

To verify the network claim: open DevTools on the result tab before step 3 and
watch the Network panel. It stays empty for the whole capture, because the
manifest sets connect-src 'none'.

The optional permission: open the extension's settings page and look at
"Advanced access". The webNavigation and all-sites permission is off by default.
Turning it on calls chrome.permissions.request; turning it off revokes it. It
only changes how much of a cross-origin iframe is captured. Nothing else in the
extension depends on it.

The upload button copies the image to the clipboard and opens the chosen image
host in a new tab so the user can paste it there. The extension itself performs
no upload and cannot: connect-src 'none' blocks all outbound requests.

Source code, including the tests that enforce all of the above:
https://github.com/PalWorks
```

## Store video

Not recorded. The store takes a YouTube URL, which needs a person to record and
publish, so this is the shot list rather than a file.

Sixty seconds, no voiceover, captions only. Screen recording at 1280x800.

| Time | Shot | Caption |
|---|---|---|
| 0:00 | A long article, scrolled slowly to show it does not fit on screen | Some pages do not fit on a screen |
| 0:06 | Click the toolbar button. The page scrolls itself, the icon fills | One click |
| 0:14 | The result tab opens with the whole page as one tall image | The whole page, in one image |
| 0:20 | Drag a box over a section, pick a fill colour and drop the opacity | Mark it up |
| 0:30 | Drag the redaction tool over an email address | Redaction removes the pixels, it does not cover them |
| 0:38 | Type a filename, choose PNG, save. The file appears in downloads | Save it, as PNG, JPEG, WebP or PDF |
| 0:44 | **Cut to DevTools, Network panel, empty, next to the capture running** | Nothing was sent anywhere |
| 0:52 | The manifest on screen, `connect-src 'none'` highlighted | Chrome enforces it. Not us |
| 0:57 | The mark, the name, the site address | openfullpage |

The cut at 0:44 is the point of the video. Everything before it is what every
extension in this category can show. Only the second half is ours.

## Before submitting

Listing:

- [ ] Confirm the SVG Repo icon licence on its own page, see [`NOTICE.md`](../NOTICE.md)
- [x] Set a support email that is not a personal address. `SUPPORT_EMAIL` in `src/ui/options.js` is `support@palworks.ai`
- [ ] Re-read the detailed description against the code, since it is the one claim
      a reviewer can check in five minutes and the whole product rests on it
- [ ] Regenerate the screenshots if any interface has moved:
      `node test/e2e/run.mjs --market --shots store/screenshots`

Release, from [`docs/PLAYBOOK.md`](../docs/PLAYBOOK.md):

- [ ] `VERSION`, `manifest.json` and `CHANGELOG.md` agree
- [ ] `node --test 'test/**/*.test.js'` clean
- [ ] `node test/e2e/run.mjs --edit` clean, including the rendered-page audit
- [ ] `node test/e2e/run.mjs --sites` clean
- [ ] Manual checks in [`docs/TESTING.md`](../docs/TESTING.md) done, including the
      `activeTab`-only path the harness cannot reach
- [ ] `./tools/pack.sh`, and upload `dist/openfullpage-<version>.zip` rather than a
      hand-made archive
- [ ] Release tag signed, and the zip SHA-256 recorded in the changelog
- [ ] Canary in [`GOVERNANCE.md`](../GOVERNANCE.md) re-dated
- [ ] Hardware-backed two factor confirmed on the publishing Google account
