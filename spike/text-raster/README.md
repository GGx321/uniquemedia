# Text rasterising spike (Studio Stage 3, SP2)

Question: can on-video text (captions with emoji, five fonts, three styles) be rasterised by
`@resvg/resvg-wasm` inside the Studio engine `utilityProcess`, and how? Plan reference:
`docs/studio/2026-09-29-stage-3-plan.md` (Text / Fonts and emoji / Caption rules rows, invariants 17, 19,
22, SP2, critique notes A3 and N14).

**Verdict: GO, with one plan change.** resvg-wasm 2.6.2 loads, lays out and renders text from disk and from
inside an asar, deterministically and identically under bun and Electron's Node 24. It **cannot draw any
Noto Color Emoji variant** (COLRv1 and CBDT both render nothing), so emoji must be composited as bitmaps
that the engine reads out of the CBDT font itself. That is proven here and costs about 1 ms per layer.

## Run

```
cd spike/text-raster && bun install        # @resvg/resvg-wasm 2.6.2 exact, own package.json, root untouched
bun fetch-fonts.ts                          # OFL sources -> ../../.cache/text-raster/src (gitignored)
bun make-static.ts                          # variable TTF -> static weights via fontTools (needs uvx)
bun smoke.ts && ./run-electron.sh smoke.ts  # Q1
bun samples.ts                              # Q2 contact sheet -> .cache/text-raster/out/sheet.png
bun emoji-probe.ts && bun cbdt-probe.ts     # Q3
bun bench.ts && ./run-electron.sh bench.ts  # Q3 determinism + Q4 cost/accuracy, both runtimes
bun escape.ts && ./run-electron.sh escape.ts# Q5 (48 checks)
bun asar-test.ts                            # Q1 asar
bun sizes.ts                                # Q6
```

`run-electron.sh` bundles a script to ESM (Electron's Node cannot run `.ts`) and runs it with
`ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron`. No production code and no root `package.json` or
lockfile change; nothing outside this folder is touched (the fonts and PNGs live in the gitignored `.cache/`).

## 1. Load and render from disk (no fetch)

- `@resvg/resvg-wasm` **2.6.2** (latest 2.6.x; 2.6.0 and 2.6.1 not tested), MPL-2.0, `index_bg.wasm`
  2,478,606 B. It bundles resvg core with **ttf-parser 0.18.1, fontdb 0.14.1, rustybuzz 0.7.0** (read
  from the wasm's embedded source paths), which explains the emoji result below.
- Loaded exactly as the jsquash/ORT wasm are today (`studio/engine/decode/`): `readFileSync` the `.wasm`,
  `WebAssembly.compile(bytes)`, `initWasm(module)`. No `fetch`, no network, no WASI imports.
- Works under **bun 1.3.12** and **Electron Node v24.18.0**: read + compile + init 5 ms (bun) / 32 ms
  (Electron, once per process); first render 29 ms in Electron, then 2-7 ms per simple render.
- Byte-identical PNGs between bun and Electron for all 5 fonts (`smoke.ts`, same sha256 prefixes).
- **Inside app.asar:** `asar-test.ts` packs the wasm, a TTF and the bundled reader into a real `app.asar`
  and runs it under Electron's Node: `initWasm` from `readFileSync("…app.asar/assets/index_bg.wasm")`
  and the font from the asar both work (35 ms). This is the same mechanism the face models and ORT rely
  on, so no `asarUnpack` is needed and the asar integrity check keeps covering the wasm. **Not tested:** the
  fused packaged app (`runAsNode` off, integrity validation on) and `utilityProcess` itself; the 3b packaged
  smoke still has to prove those, but nothing here depends on either.
- Fonts are passed as `fontBuffers` (`loadSystemFonts` is off; no fontconfig, no system fonts).

## 2. The five fonts, three styles

All OFL 1.1, from the Google Fonts repository (Manrope, Playfair Display, Oswald, Caveat are variable there,
PT Mono is a static TTF). Static instances at the plan's weights (Manrope 800, Playfair Display 600, Oswald
600, Caveat 600, PT Mono 400) were cut with fontTools' `varLib.instancer`. resvg 0.3x does not instantiate
variable fonts, so statics are required, as the plan says.

| Font | Copyright line | RFN | Static size |
|---|---|---|---|
| Manrope | 2018 The Manrope Project Authors | none | 98,080 B |
| Playfair Display | 2017 The Playfair Display Project Authors | **"Playfair Display"** | 195,004 B |
| Oswald | 2016 The Oswald Project Authors | none | 88,904 B |
| PT Mono | 2011 ParaType Ltd. | **"PT Sans", "PT Serif", "PT Mono", "ParaType"** | 185,912 B (unmodified) |
| Caveat | 2014 The Caveat Project Authors | none | 266,980 B |
| Noto Color Emoji | 2021 Google Inc. | none | see 3 |

**Licence watch item for 3b.2:** OFL forbids reusing a Reserved Font Name on a *Modified Version*. Cutting
a static instance with fontTools is arguably a modification, which matters for Playfair Display (RFN).
Manrope, Oswald and Caveat have no RFN; PT Mono ships unmodified. For Playfair, take the official static
TTF that Google Fonts publishes (its download zip's `static/` folder) instead of a self-cut instance.
I could not fetch that zip from a script here, so it is open. All six `OFL.txt` files were fetched and
belong next to the binaries.

Visual check (`samples.ts` -> `.cache/text-raster/out/sheet.png`, 15 layers on a mid-blue background): all
15 combinations render correctly. Pill = white rounded box with #111 text, outline = white text with a
black round-joined stroke (`paint-order` stroke first, so the fill is not eaten), shadow = white text with a
blurred offset shadow via an SVG filter. Kerning is correct (`AV To Ty`), weights select the right face,
`font-weight` 800/600 match the instance's `usWeightClass`. Layer PNGs are tight-cropped to the box.

## 3. Emoji

Tested with resvg-wasm 2.6.2, each font alone, `font-family="Noto Color Emoji"`, text `🌴✨👍`
(`emoji-probe.ts`; sources are noto-emoji release **v2.051**, OFL 1.1):

| Variant | File | Size | Result in resvg-wasm 2.6.2 |
|---|---|---|---|
| CBDT bitmap | `NotoColorEmoji.ttf` | 10,673,480 B | **blank** (786 B PNG, background only) |
| COLRv1 vector | `Noto-COLRv1.ttf` | 4,991,984 B | **blank** |
| Google Fonts repo file (COLRv1 + OT-SVG + glyf) | `NotoColorEmoji-Regular.ttf` | 25,332,736 B | **blank** |

Mixed into a normal caption the emoji fall back to the text font's `.notdef` tofu boxes. So neither format
renders, and the plan's "COLRv1 preferred, CBDT as the fallback" cannot be executed with any 2.6.x
resvg-wasm. The vendored ttf-parser 0.18 predates colour-glyph painting. (Newer resvg releases do it, but
the newest `@resvg/resvg-wasm` on npm is 2.7.0-alpha; not pinning an alpha.)

**Working approach (proven):** the CBDT font is just a container of one 136x128 PNG per emoji.
`cbdt.ts` (~150 lines, no dependencies) reads it directly:

- code points -> glyph id through `cmap` (format 12);
- ZWJ sequences, skin tones, flags, keycaps -> a small GSUB **ligature (type 4)** pass over every lookup;
  `post` is format 3 in this font, so glyph names are not available;
- glyph id -> PNG through `CBLC` (index formats 1 and 3) and `CBDT` (image format 17).

Result: 3,985 bitmaps, 10,543,900 B of PNG, index built in 4.4 ms. `escape.ts` checks that a ZWJ family
(👩‍👩‍👧), ZWJ profession with skin tone (🧑🏽‍💻), skin tone (👍🏽), flag (🇺🇦), keycap (1️⃣), VS16 heart (❤️) and
rainbow flag (🏳️‍🌈) each resolve to exactly one bitmap, and that an emoji the font lacks is refused rather than
dropped. `has(cps)` is exactly the coverage predicate the caption rules and the invariant 22 test need.
The engine lays each emoji out as an inline square (height 1.15 em, advance = width) and embeds the PNG in
the SVG. Rendered sample: `sheet.png` shows 🌴 ✨ 👩‍👩‍👧 👍🏽 crisp in all 15 combinations (drawn from a 128 px bitmap
at about 64 px, so always a downscale).

**Plan deviation to accept:** resvg-wasm 2.6.2 resolves only `data:` image hrefs (`imagesToResolve()` is
always empty; `resolveImage` is a no-op for anything else). So the SVG contains `<image href="data:image/png;base64,…">`
for emoji. Invariant 17 ("no external resources or `href`s") should read: *no href that is derived from
user text; the only hrefs are `data:image/png` URIs built by the engine from the bundled emoji font.* User
text still enters only as escaped character data (section 5), and resvg has no file or network access in
this build.

**Determinism.** The same caption rendered 20 times, per style, gives **1 distinct hash** each (pill
`4ceb5a97f94486e0`, outline `6b416dceafd4f2e4`, shadow `53776254e55e1af8`), and the fingerprint over
15 font x style layers is identical between bun and Electron Node (`5c996c795344026e`). The emoji come
from bundled bytes, so macOS and Windows agree by construction; a Windows run of `bench.ts` should confirm
the same fingerprint (wasm arithmetic is IEEE-deterministic, but this has only been run on macOS arm64).

## 4. Layout: measure and wrap (A3)

`layout.ts`: split into words (`Intl.Segmenter` graphemes, emoji detected by
`\p{Extended_Pictographic}|\p{Regional_Indicator}|U+20E3` and confirmed against the font), measure each
text run once at 100 px and scale linearly, pick the balanced 1- or 2-line split that minimises the widest
line, and if the widest line exceeds 86% of the frame shrink the font size proportionally (up to 3 passes).
Two measurers were compared:

- **resvg bbox loop** (`Resvg#getBBox()` on a one-`<text>` SVG, sentinel `|…|` so edge spaces count). It
  measures with the very shaper that draws, so it cannot drift.
- **Pure-JS `hmtx` sum** (`sfnt.ts`, ~70 lines, also gives `hhea` ascent/descent for baselines and the
  `cmap` for invariant 22). No kerning or shaping: **0-3.6% too wide** on English (PT Mono 0%, Playfair up to
  3.6% on strings with `AV To Ty`, Caveat about 2%), always larger than reality, so it never overflows, but it
  cannot be the drawn width.

Verified fit: the layout width and resvg's own bbox of the finished layer agree within 0-18 px (18 for PT
Mono where the layout counts the trailing bearing); all 20 font x caption cases (including a 60-char
unbreakable word that shrinks the size to 25-44 px) end at or below 86% of 1080 (929 px), at most 2 lines.

Cost (median of 15, per layer, warm process, Electron Node numbers within 10% of bun):

| Caption | Graphemes | Layout, bbox loop, cold | Layout, warm cache | Layout, JS metrics | SVG | Rasterise |
|---|---|---|---|---|---|---|
| "Beach day" | 9 | 0.24-0.33 ms (6 measures) | 0.00 | 0.01 | 0.00 | 1.2 ms |
| 2 lines, no emoji | 40 | 0.8 ms (16) | 0.01 | 0.01 | 0.01 | 3.9-4.0 ms |
| 2 lines with 🌴✨ | 50 | 1.0 ms (20) | 0.01 | 0.02 | 0.02 | 6.9-7.7 ms |
| 2 lines, 65 chars | 65 | 1.6-1.8 ms (26) | 0.01 | 0.03 | 0.02 | 7.0-7.3 ms |

So a layer costs about **1-2 ms to lay out and 1-8 ms to rasterise** (the emoji base64 decode dominates the
top rows). Do not rasterise a whole 1080x1920 frame per layer: that is 32 ms, versus about 7 ms for the
tight box (the box PNG is 830x163 and the engine positions it in the video graph).
The first render in a fresh process is slower (about 30 ms in Electron, JIT + wasm warm-up).

**Recommendation: the bbox loop** for the final layout (exact, at most 26 measurements for 65 characters,
under 2 ms, cached per word), with the `hmtx` reader kept only for baselines and the cmap coverage test.
No opentype.js (MIT, 3.6 MB unpacked) or fontkit (MIT, 5.6 MB unpacked) is needed, and they would add a
third width source that drifts from resvg's shaper.

Not covered: right-to-left and complex scripts (English-only by the plan), a `letter-spacing` control, and
line breaking inside an over-long word (it shrinks instead, so a single 60-char word is rendered small).

## 5. SVG escaping

`escape.ts` (48 checks, all pass, under bun and under Electron): `<`, `>`, `&`, `"`, `'`, `&lt;`, `]]>`,
`<!--`, `<?xml` render as glyphs. A hostile caption
`<b>&amp; "q" 'x' </text><rect width="9999" …/><image href="file:///etc/passwd"/>` produces exactly the
template's one `<rect>` and zero `<image>` elements and the escaped character data (`&lt;/text&gt;&lt;rect`).
Every emoji case above is one bitmap. Two facts for the caption rules and the engine:

- A raw control character (`U+0001`) makes resvg **throw** "non-XML character" (XML 1.0). The caption
  charset refuses those before layout; the engine must also treat a resvg throw as a hard failure, not
  fall back to unescaped output.
- Text is emitted one `<text>` per word or run, `xml:space="preserve"` (needed for runs with edge spaces).

## 6. Installer delta (`sizes.ts`)

| Asset | Raw | deflate-9 |
|---|---|---|
| resvg-wasm `index_bg.wasm` | 2,478,606 | 957,018 |
| 5 static text TTFs | 834,880 | 428,883 |
| Noto Color Emoji CBDT (v2.051) | 10,673,480 | 9,946,875 |
| **Total** | **13,986,966 (13.34 MiB)** | **11,332,776 (10.81 MiB)** |

Plus the small resvg JS glue that electron-vite bundles (~17 KB) and six `OFL.txt` (~26 KB). Estimated
delta **+11 to +13.5 MiB** (the emoji PNGs do not compress, DMG/NSIS compress the rest). Against the
current installers: mac 174 -> about **185-188 MiB**, win 155 -> about **166-169 MiB**, both under the
**220 MiB** budget with 30+ MiB headroom. If the budget ever binds, the emoji font can be repacked to only the
bitmaps the caption rules allow, or the PNGs quantised; not needed now.
The COLRv1 file (5.0 MB) is not shipped because it cannot be rendered.

## Recommendation

**GO**, pinning `@resvg/resvg-wasm` at exactly **`2.6.2`**, as a devDependency bundled into `out-studio`
with `index_bg.wasm` copied next to it (N11) and loaded from inside the asar as above. Approach:

1. Engine owns layout (`layout.ts` shape): grapheme tokenising, resvg bbox measurement at 100 px, balanced
   two-line split, shrink to 86% of the frame width, resolved layout stored in the spec.
2. Fixed SVG template, user text as escaped character data only, one `<text>` per run, fonts as
   `fontBuffers` (no system fonts).
3. **Emoji as CBDT bitmaps read by the engine** (`cbdt.ts`), never through resvg's text path. Ship
   **`NotoColorEmoji.ttf` CBDT v2.051 (10.67 MB)**, not COLRv1. Update plan text: "SP2 picks COLRv1 or CBDT"
   becomes "CBDT, read by the engine; resvg 2.6.2 renders neither", and invariant 17 as worded in section 3.
   `cbdt.ts` `has()` is the emoji coverage predicate for the caption rules and the invariant 22 test.
4. `montages.textPreview` returns the same PNG (about 7 ms), so preview and render cannot drift.

Open items for the implementing slices: (a) obtain official static Playfair Display (RFN) rather than a
self-instanced file, and record sha256s in the manifest; (b) run the packaged smoke (fuses on,
`utilityProcess`) and `bench.ts` on Windows to confirm the fingerprint `5c996c795344026e`; (c) property
test `cbdt.ts` against the full Unicode emoji test file (`emoji-test.txt`) once the coverage list is
frozen, since the GSUB pass here is a simplification (type 4 lookups applied in lookup order, no
feature/script filtering); (d) decide the emoji advance/vertical alignment with the designer (1.15 em box,
baseline offset 0.82 is a first guess); (e) 2.6.0 and 2.6.1 were not compared, only 2.6.2.

## Files

`common.ts` wasm/font loading, SVG helpers | `layout.ts` tokenise, measure, wrap, SVG template |
`cbdt.ts` emoji bitmap reader | `sfnt.ts` metrics/cmap reader | `smoke.ts`, `samples.ts`, `emoji-probe.ts`,
`cbdt-probe.ts`, `image-probe.ts`, `bench.ts`, `escape.ts`, `asar-test.ts` + `asar-reader.ts`, `sizes.ts`
| `fetch-fonts.ts`, `make-static.ts`, `list-sources.ts`, `probe-emoji-sources.ts` | `run-electron.sh`.
