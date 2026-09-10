# Limitations

Known bugs, technical debt and edges, so an agent does not rediscover them the
expensive way or "fix" something that is deliberate.

Status key: **open** (a real gap, unfixed), **by design** (a deliberate trade),
**watch** (fine today, will bite a specific future feature).

## Capture

| # | Limitation | Status |
|---|---|---|
| L1 | A page longer than the canvas limits is downscaled to 50% and then truncated. The user is told, which does not make it good | **open**, F10 is the fix |
| L2 | Cross origin frames contribute only their visible box unless the user opts into advanced access. `contentDocument` throws, so their height cannot be read at all | **by design** |
| L3 | The walk stops at `MAX_TILES` (400). A live blog appending faster than we photograph is bounded here | **by design** |
| L4 | `markSpecialElements()` calls `getComputedStyle` on every element in the document. On a 50,000 node page this is the slowest step before the walk begins | **open**, low priority |
| L5 | Chrome rate limits `captureVisibleTab`. The walk backs off and retries up to six times, so a slow page can take noticeably longer than its screenful count suggests | **by design** |
| L6 | Playing video is not paused during the walk, so a frame can differ between what was photographed and what the user saw | **closed** 2026-09-10, F2. Only what was playing is paused, and it is started again in the tidy-up |
| L7 | `chrome://` pages, the Web Store, and other extension pages cannot be captured. Chrome forbids it | **by design** |
| L27 | A page whose scripts never go quiet can leave `executeScript` pending forever. Every step across into a page now has a deadline, so the capture is delivered short rather than lost, but the underlying step is still Chrome's to resolve and there is no way to ask it for a partial answer | **by design**, D27 |
| L28 | A capture finished with Finish now, or ended by a stalled step, is trimmed to the last screenful taken. On a wide page a stall can still leave the final row short down its right-hand side; a deliberate stop cannot, because it only lands at the start of a row | **open**, low priority, D28 |
| L39 | `captureVisibleTab` hands back the last frame the compositor presented, not a photograph taken on demand, so a screenful could arrive that repeated the one before it: the page had scrolled, so the tile was placed at the new position, and the output repeated one screenful and lost the one that belonged there, silently | **closed** 2026-09-10, D56. Observed on a real news page. Two frames are waited for now, and a screenful identical to the one before it is photographed again after a forced repaint |
| L40 | The repair for L39 gives up after three retakes and keeps the screenful. Two screenfuls can be identical honestly, on a blank stretch, and the pixels cannot tell that apart from a stale frame, so the last word has to be one of the two | **by design**, D56 |

## The result tab and export

| # | Limitation | Status |
|---|---|---|
| L8 | The service worker holds every screenful as a base64 data URL until the result tab connects. Bounded today by the canvas limits, unbounded by design once multi part export exists | **watch**, blocking for F10 |
| L9 | `canvas.toBlob()` can resolve with `null` and nothing on the export path checks it. Unreachable in practice for PNG and JPEG; reachable the moment a format the browser cannot encode is offered. PDF does not go through `toBlob` and is unaffected | **closed** 2026-09-10, T2, D52. `encodeOrThrow` names the format and offers a way out |
| L32 | A PDF is one column at the capture's own width, with no scaling and no margins. It is the image as a document, not a reflowed one, so a very wide capture makes very wide pages | **by design**, D31 |
| L33 | PDF holds the uncompressed samples for one page at a time. A page of a 2213 pixel wide capture is about 25 MB of them for the moment before it is deflated, which is why the image is cut into pages before it is encoded rather than after | **by design**, D31 |
| L10 | Closing the result tab discards the capture and every annotation. Reloading it now asks first, closing it still does not: Chrome's `beforeunload` prompt is the only mechanism, and it is the same one | **open**, task T10 |
| L29 | Saving straight to a file needs the `downloads` permission to be granted already, because there is no click in that path to hang `chrome.permissions.request` on. If it is revoked in `chrome://extensions` afterwards, the capture opens the editor and says why instead | **by design**, D29 |
| L11 | The port protocol has no version field. A result tab left open across an extension update can receive messages from a newer worker | **closed** 2026-09-10, T11, D53. Exercised by `--stale` |
| L12 | `src/ui/result.js` is now 1,123 lines with more than a dozen module scope globals. It is the file every feature lands in, and it has roughly doubled since this limitation was first written | **open, and worse**, task T14 |

## Settings

| # | Limitation | Status |
|---|---|---|
| L13 | `sanitise()` silently discards any key not in `DEFAULTS`. A setting added to only one of the two is written nowhere, with no error | **by design**, but see task T3 for the test that makes it safe |
| L34 | Saving is read-modify-write over the whole settings object. Writes from one page are serialised, so overlapping saves in one tab are safe; two extension pages editing different settings in the same instant can still lose one | **open**, low priority, needs a per-key write to fix properly |
| L35 | An explicitly chosen theme cannot be applied before the first paint: the choice is in `chrome.storage`, which is asynchronous, and the CSP forbids the inline script that would otherwise stamp it. One frame of the system theme is visible | **by design**, D32 |

## The editor

| # | Limitation | Status |
|---|---|---|
| L14 | **The editor cannot be driven by keyboard.** Tools can be selected with single key shortcuts and the buttons are focusable, but every drawing, moving and resizing action is pointer only. A user who cannot use a pointer can pick a tool and then do nothing with it | **open**, real accessibility gap. The shape of the fix: arrow key nudging of a selected shape, which `moveShape` already supports |
| L15 | Toolbar buttons are 30 x 28px, below the 44px touch target guideline. Defensible on a desktop only extension | **by design**, and less pressing since the grouped toolbar cut 26 controls to 16 |
| L16 | There is no pixel eraser, and there will not be one: it would have to bake pixels into the base image, which breaks exact undo and the immutable original | **by design** |
| L42 | A redaction is the one shape that ignores the stroke opacity, and it has to be: an opacity it could take would be a way to read through it. Said twice in the code, in `drawShape` and in `drawPixelated`, so both have to be deleted before one can be made see-through | **by design**, D57 |
| L41 | **A text shape has no width of its own.** Its box is measured from the longest line, so editing a caption widens the box instead of wrapping into it, and the corner handles scale the point size rather than reflowing the text. There is nothing to drag that would set a wrap width, because the model has nowhere to keep one | **open**, F43 is the fix |
| L17 | Inline text entry positions its `<input>` once, from the canvas bounding box. Correct today because the canvas scrolls with the document. A zoom feature that puts the canvas in its own scrolling container will detach the input mid typing | **watch**, blocking for F6 |
| L22 | Text entry was a single-line `<input>`, so alignment had nothing to align | **closed** 2026-09-09, D39. The box is a textarea and the four alignments are in the inspector |
| L23 | The custom colour control is the operating system's picker. It looks different on macOS, Windows and Linux, which is the price of getting an eyedropper, keyboard support and a recent-colours list rather than building worse versions of all three | **by design**, D20 |
| L24 | The mark is teal and the editor interface is still indigo. Incoherent, and deliberately not fixed yet: recolouring the interface is a visible change and those need a before and after preview first | **open**, D22 |
| L37 | Committed text could not be re-edited: changing a word meant deleting the shape and typing it again | **closed** 2026-09-09, D39. Double click a text shape with the select tool |
| L38 | Text carried no resize handles, because `handlesFor` treated it like a numbered step | **closed** 2026-09-09, D39. Corner handles scale the point size, and the numbered step still has none because a fixed radius circle has nothing a corner could change |
| L18 | Undo history is capped at 60 states | **by design** |
| L30 | Exporting while a crop region is pending exports the uncropped image. The region is a proposal and applying it is one keystroke, but nothing stops a save in between | **by design**, D30 |
| L31 | A crop region can only be adjusted with the pointer. Arrow keys do not nudge its edges, which is the same gap as L14 and lands with the same fix | **open**, D30 |
| L36 | Exporting locks the canvas so a multi-page encode cannot photograph a repaint. Edits made during a long export are accepted by the model and drawn when it finishes, so the canvas can look frozen for a second or two on a very long PDF | **by design**, D31 |

## Project

| # | Limitation | Status |
|---|---|---|
| L19 | The canary line in `GOVERNANCE.md` is re-signed by hand at release time, and it has already drifted one release behind | **open**, task T5 makes it a test |
| L25 | The rendered-page audit covers contrast, overflow, broken images and heading order. It does not cover focus order, screen reader labelling or motion, so it is a floor rather than an accessibility pass | **open**, honest scope |
| L26 | Store screenshots are generated against the marketing site, so a change to that site changes the images. Regenerating them is one command and is on the release checklist | **by design** |
| L27 | A capture pauses anything playing and starts it again afterwards. Some players answer a pause by drawing a large play button over the video, so a capture of a page with a video may photograph that overlay rather than the frame that was showing. The alternative is a video photographed at a different moment in every screenful it spans, which is worse | **open**, the better of two |
| L28 | Media inside a cross-origin frame is not paused, because the extension cannot reach into one without the advanced access permission. Same-origin frames are covered | **by design**, follows the permission model |
| L20 | `tools/verify-crx` needs Go to build, and the end to end suite needs a real Chrome. The unit suite needs neither | **by design** |
| L21 | Chrome only. A Firefox or Safari port means a different manifest and a different verification story | **by design** |
