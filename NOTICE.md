# NOTICE

OpenFullPage is a Manifest V3 port and hardening of
[**full-page-screen-capture-chrome-extension**](https://github.com/mrcoles/full-page-screen-capture-chrome-extension)
by **Peter Coles**, used under the MIT License.

That project later became the basis of a commercial extension under different
ownership. This repository is an independent derivative of the MIT-licensed work
above and of nothing else: it is **not** affiliated with, endorsed by, or derived
from any commercial successor, and inherits none of its branding, artwork,
accounts, analytics, or network code. `test/lib/scan.js` fails the build if the
extension name ever reuses that mark, and `tools/icon-design.mjs` records the
clean-room reasoning behind our own.

The combined work is licensed **GPL-3.0-only** (see [LICENSE](LICENSE)). MIT is
GPL-compatible, so the original terms below continue to govern the portions
derived from it, and must be retained in any redistribution.


## Original work: MIT License

    The MIT License

    Copyright (c) 2012,2013 Peter Coles (http://mrcoles.com/)

    Permission is hereby granted, free of charge, to any person obtaining a copy
    of this software and associated documentation files (the "Software"), to deal
    in the Software without restriction, including without limitation the rights
    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
    copies of the Software, and to permit persons to whom the Software is
    furnished to do so, subject to the following conditions:

    The above copyright notice and this permission notice shall be included in
    all copies or substantial portions of the Software.

    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
    THE SOFTWARE.


## Third-party code

**None.** OpenFullPage has zero runtime dependencies and no build step. There
is no `node_modules`, no lockfile, and no bundled library.

## Third party artwork

The settings gear in the editor toolbar is redrawn from
[gear-setting-settings](https://www.svgrepo.com/svg/422526/gear-setting-settings)
on SVG Repo. The icon's own page, checked on 2026-09-13, reads "LICENSE: CC0
License", with SVG Repo as the uploader and the collection given as SVG Vector.
CC0 requires no attribution; it is credited here anyway, and the original file is
kept at `public/gear-setting-settings-svgrepo-com.svg` as provenance. `public/` is
not part of the shipped package.

An earlier draft of this notice took the CC0 status from SVG Repo's general
[licensing page](https://www.svgrepo.com/page/licensing/), because the icon page
itself answered HTTP 429 at the time. It has since been read directly. Everything
else in the interface, including the extension icon, is drawn from geometry in
`tools/icon-design.mjs`.

