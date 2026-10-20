# Third-party notices

This project is MIT-licensed. Files by other authors keep their own terms;
the MIT licence on the surrounding project does not relicense them. Fonts and
scripts are vendored because the pages' content-security policy allows only
their own origin.

## Fonts

| file(s) | from | licence |
|---|---|---|
| `apps/code/native/public/fonts/CommitMono-400-Regular.otf` | [Commit Mono](https://commitmono.com) | MIT, [`apps/code/licenses/CommitMono-MIT.txt`](apps/code/licenses/CommitMono-MIT.txt) |
| `locker/public/store/fonts/iAWriterMonoS-Regular.ttf`, `iAWriterMonoS-Bold.ttf` | [iA Writer Mono S](https://github.com/iaolo/iA-Fonts), Information Architects, based on IBM Plex | OFL-1.1, [`locker/public/store/fonts/OFL.txt`](locker/public/store/fonts/OFL.txt) |
| `locker/public/store/fonts/inter-tight.woff2` | [Inter Tight](https://github.com/rsms/inter-tight) (from Google Fonts, `intertight/v9`, latin subset, variable weight 300–600), the Kinso concept Shop's text | OFL-1.1, [`locker/public/store/fonts/InterTight-OFL.txt`](locker/public/store/fonts/InterTight-OFL.txt) |
| `website/assets/fonts/omarchy-font.ttf` | [Omarchy Font](https://github.com/markcuda/Omarchy-Font) | MIT (below), Copyright © 2026 Mark Cuda |
| `website/fonts/SpecialElite-Regular.woff2` | Special Elite, Astigmatic | Apache-2.0, [`website/fonts/SpecialElite-LICENSE.txt`](website/fonts/SpecialElite-LICENSE.txt) |
| `website/fonts/CourierPrime-Regular.woff2` | [Courier Prime](https://github.com/quoteunquoteapps/CourierPrime) | OFL-1.1, [`website/fonts/CourierPrime-OFL.txt`](website/fonts/CourierPrime-OFL.txt) |
| `website/fonts/IBMPlexMono-Regular.woff2` | [IBM Plex Mono](https://github.com/IBM/plex) | OFL-1.1, [`website/fonts/IBMPlexMono-OFL.txt`](website/fonts/IBMPlexMono-OFL.txt) |
| `website/fonts/outfit-regular.woff2`, `outfit-medium.woff2` | [Outfit](https://github.com/Outfitio/Outfit-Fonts) (from google/fonts `ofl/outfit`, commit `67bc647ce1910e92f461bcc82aae30f21d21a9cc`), the launch page and native lock's text: weights 400 and 500, subset to Basic Latin and ’ “ ” … – — · •; kern/liga retained | OFL-1.1, [`website/fonts/Outfit-OFL.txt`](website/fonts/Outfit-OFL.txt) |
| `website/fonts/SpaceMono-Regular.woff2` | [Space Mono](https://github.com/googlefonts/spacemono) | OFL-1.1, [`website/fonts/SpaceMono-OFL.txt`](website/fonts/SpaceMono-OFL.txt) |
| `website/fonts/InstrumentSerif-Regular.woff2` | [Instrument Serif](https://github.com/Instrument/instrument-serif) | OFL-1.1, [`website/fonts/InstrumentSerif-OFL.txt`](website/fonts/InstrumentSerif-OFL.txt) |
| `website/fonts/EBGaramond-wght.woff2` | [EB Garamond](https://github.com/octaviopardo/EBGaramond12) | OFL-1.1, [`website/fonts/EBGaramond-OFL.txt`](website/fonts/EBGaramond-OFL.txt) |

The Omarchy Font's seven wordmark letters match Omarchy's `logo.svg`; the
rest are condensed from *Delta Corps Priest 1* by CoSMiC cHiLD, the FIGlet
font the wordmark grew from. Omarchy is by DHH and 37signals; its name and
wordmark remain theirs, and this project uses the letterforms to set its own
word.

## ttfx

`website/assets/js/wte/ttfx.js` and `ttfx.wasm`: terminal text effects from
[omacom-io/ttfx](https://github.com/omacom-io/ttfx), a `wasm-bindgen` build
taken from `https://omarchy.org/assets/js/wte/`. MIT (below), Copyright ©
2026 37signals / omacom-io, and Copyright © 2023 ChrisBuilds for
TerminalTextEffects, from which ttfx is ported. `website/blackhole/` is
written for this project after TerminalTextEffects' `blackhole` effect; it
copies no code from it.

## three.js

`website/vendor/three.module.js` and `three.core.js`: [three.js](https://threejs.org)
r186. MIT, Copyright © 2010-2026 three.js authors,
[`website/vendor/THREE-LICENSE`](website/vendor/THREE-LICENSE).

## T3 Code

The settled-thread lifecycle (`tabs.mjs`), the
conversation's layout (`public/js/gui-transcript.js`, `public/js/harness.js`,
`public/css/gui-transcript.css`) and the message and tool vocabulary
(`canonical.mjs`), under `apps/code/native/`, adapt patterns from
[T3 Code](https://github.com/pingdotgg/t3code) at commit
`aff9318bf46beaf05cc7155b428d3f0b8711efd2` (patterns only). MIT,
Copyright (c) 2026 T3 Tools Inc.,
[`apps/code/licenses/T3-Code-MIT.txt`](apps/code/licenses/T3-Code-MIT.txt).
The usage page (`apps/code/native/public/js/usage.js`, `usage-page.js` and
`public/css/imperfect.css`) adapts the desktop `UsagePage.tsx` information
architecture, `UsageLimits.tsx` / `LimitWindows` / `WindowBar`,
`UsageShareBar.tsx`, `UsageModelDialog.tsx`, the neutral token/cost type
palette in `usageBreakdown.ts`, the validated metric/period preference pattern
in `usagePagePreferences.ts`, and the `niceScale` and shape-preserving cubic curve calculations
from `UsageProviderChart.tsx`, under `apps/web/src/components/usage/`, plus
token/percent formatting from `packages/shared/src/usageFormat.ts`, at
commit `43f8a8de17a7ac1baa7a3cf36d681856de2d8add`. Those adapted portions
are MIT, Copyright (c) 2026 T3 Tools Inc.; the full permission notice is in
[`apps/code/licenses/T3-Code-MIT.txt`](apps/code/licenses/T3-Code-MIT.txt).
Banked Codex resets (`apps/code/native/codex-resets.mjs` and the Limits
confirmation in `usage.js`) adapt the GET/POST protocol, expiry filtering,
account-serial/idempotent redemption and explicit-confirmation patterns from
`apps/server/src/usage/cliproxyApi.ts`, `provider/Drivers/CodexDriver.ts` and
`UsageLimits.tsx` at the same `43f8a8de` commit, under that MIT notice.
No upstream icons, dependencies or brand assets are copied.
T3 has not sponsored this project.

## Lucide usage icon

The `CircleGauge` SVG in `apps/code/native/public/js/usage.js` is copied from
[Lucide 1.50.0](https://github.com/lucide-icons/lucide/blob/1.50.0/icons/circle-gauge.svg),
the icon imported by Paseo's `SidebarUsageIcon` in
[`left-sidebar.tsx`](https://github.com/getpaseo/paseo/blob/337e81a9c6d4551dbcede5930c21408776d06b1b/packages/app/src/components/left-sidebar.tsx#L462-L471).
Only its displayed size changes; its geometry and stroke attributes are unchanged.
ISC, Copyright (c) 2026 Lucide Icons and Contributors,
[`apps/code/licenses/Lucide-ISC.txt`](apps/code/licenses/Lucide-ISC.txt).
No Paseo implementation code is copied.

## CrackLib password dictionary

`locker/common-passwords.txt` is the unmodified `cracklib-small` dictionary from
[CrackLib 2.10.3](https://github.com/cracklib/cracklib/tree/v2.10.3), by the
CrackLib authors. The installed package declares LGPL-2.1; its separate terms
are retained in [`locker/licenses/LGPL-2.1.txt`](locker/licenses/LGPL-2.1.txt).
The plaintext dictionary is its editable source. Provenance and SHA-256 are in
[`locker/common-passwords.README.md`](locker/common-passwords.README.md).
No CrackLib executable/library code is vendored. This is an offline dictionary,
not a ranked breached-password list.

## Mac app identifiers in the launch

`website/mac/icons/dock-*.webp` are normalized app-identification artwork for
the Mac desktop sequence, not MIT-licensed application code. Finder, Safari,
System Settings and App Store retain the existing Mac Dock artwork.
Launchpad, Dock's native dark empty/full Trash and imperfect's own installed
app icon were extracted read-only from Noah's macOS Sequoia 15.8.1 Mac
(18 October 2026).
`website/macos/quicktime.webp` is QuickTime Player's app-identification artwork,
converted from the icon supplied from that same Mac; Apple retains its rights.
Notes and iMovie came from Apple's public
[Notes](https://support.apple.com/guide/notes/welcome/4.11/mac/15.0) and
[iMovie](https://support.apple.com/guide/imovie/welcome/mac) user guides.
Final Cut Pro's identification artwork came from
[Wikimedia](https://upload.wikimedia.org/wikipedia/en/9/9f/2015_Final_Cut_Pro_Logo.png).
Claude and ChatGPT retain their existing brand artwork. Apple, Anthropic and
OpenAI retain their respective artwork rights; no endorsement is implied.

## Not in this repository

The dependencies in `package.json` (Pi, the Claude Agent SDK, sherpa-onnx,
`ws`, Electron, Playwright) are installed by `npm ci`, and the mic's voice
model (NVIDIA Parakeet TDT 0.6B v2, CC-BY-4.0, as packaged by sherpa-onnx)
is fetched by `install.sh`. None of them is committed here; each keeps its
own licence.

## MIT licence

For the Omarchy Font and ttfx (three.js has its own copy), with the copyright lines above:

> Permission is hereby granted, free of charge, to any person obtaining a
> copy of this software and associated documentation files (the "Software"),
> to deal in the Software without restriction, including without limitation
> the rights to use, copy, modify, merge, publish, distribute, sublicense,
> and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in
> all copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
> FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.
