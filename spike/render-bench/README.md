# SP1: render technique, memory, colour

Stage 3 plan (`docs/studio/2026-09-29-stage-3-plan.md`), spike SP1. It picks the ffmpeg
technique for Ken Burns / pan clips, confirms the two-pass render design against a single
graph, sets the pass-1 intermediate and the final x264 preset, checks the colour chain
against a chart with a coloured RGBA sticker, and measures the peak RSS that feeds the
«Авто» concurrency formula (B1).

No production code changed. Everything here is a spike helper (`graphs.ts` is **not** the 3a.5
graph builder). Rendered media stays in `.cache/render-bench/` (gitignored); the measured
numbers are committed as JSON in `results/`.

## Run

```sh
bun install --frozen-lockfile
bun spike/render-bench/assets.ts     # chart.jpg, sticker.png, texture.jpg -> .cache/render-bench/assets
bun spike/render-bench/smooth.ts     # Q1a smoothness            -> results/smoothness.json
bun spike/render-bench/clips.ts clips 3        # Q1b time + peak RSS per clip kind
CAPS=1 TECHS=zp4,zp2 bun spike/render-bench/clips.ts clips-capped 3
bun spike/render-bench/timeline.ts zp4 3 timeline   # Q2 Q3 Q4: single vs two-pass, inters, presets
STRESS=1 bun spike/render-bench/timeline.ts zp4 3 stress   # 20 clips x 80 photos
CAPS=1 bun spike/render-bench/timeline.ts zp4 3 timeline-capped   # (and STRESS=1 ... stress-capped)
bun spike/render-bench/inter.ts 3    # Q3: sizes/times per 4 s clip
bun spike/render-bench/colour.ts     # Q5
bun spike/render-bench/parallel.ts 3 # Q6: N concurrent worst-case renders
bun spike/render-bench/extra.ts      # finals vs lossless; the «Авто» table
```

Binaries: `ffmpegPath()` from `studio/node/ffmpegBinary.ts` (ffmpeg-static, **6.0**, macOS arm64)
and `ffprobe-static` (**4.4**: no `pts_time` on frames, use `best_effort_timestamp_time`).
Peak RSS is `/usr/bin/time -l` "maximum resident set size" (macOS, bytes; shown here in MiB).

## Setup

- Machine: macOS arm64, **14 cores, 36 GiB**. Another agent was running work on it: the load
  average was 5-34 during the first passes and 5-12 during the re-run; the whole Q1 timing set
  was **re-run at the end** (`results/clips-rerun.json`) and agreed with the first run within
  about 10% (zp4 collage4: 3243 vs 3313 ms). Encoding is capped at `-threads 2`, so timings barely
  depend on load. Timings quoted below are medians of 3 runs from the re-run unless noted.
- Inputs: the three `render-*` face fixtures (720x1280 JPEG, `yuvj420p(pc, bt470bg)`), a generated
  chart JPEG (same pixel format, 24 patches + 2 uniform blocks), a 400x300 RGBA sticker
  (opaque row, alpha-128 row, alpha ramp) and a blurred-noise texture for the smoothness metric.
- Output profile everywhere: 1080x1920, 30 fps CFR, H.264 High `yuv420p` tv, BT.709 tags, AAC
  48 kHz stereo 192k; final encode CRF 20, `-maxrate 3500k -bufsize 7000k -g 60 -keyint_min 30
  -threads 2`. Pass-1 intermediate: x264 `ultrafast`, `-threads 2`, mkv.
- Collage layout used (12 px gap on black): c2 = two 1080x954; c3 = 1080x1106 over two
  534x802; c4 = four 534x954. Stagger step = `min(300 ms, dur/(n+1))` floored to a frame, each
  cell `fade=alpha=1` in then `overlay`. Every cell moves (Ken Burns 1.00 -> 1.10 toward
  (0.5, 0.38), or pan at 1.15).
- Mixed timeline (15.0 s = 450 frames): photo KB 4 s, collage3 3 s, photo pan 3 s, collage2 3 s,
  collage4 2 s; a sticker on 2-6 s; silent audio built with `anullsrc,atrim=end_sample`.

## Techniques compared

| Name | Graph |
|---|---|
| `zp1` / `zp2` / `zp4` | photo -> colour convert -> cover-crop -> `scale` x1/x2/x4 (lanczos) -> `zoompan` (`d=N`, one input frame) |
| `sc` / `sc2` / `sc4` | photo -> convert -> crop -> (x k canvas) -> `loop` -> per-frame `scale eval=frame` with `n` -> `crop` with `n` -> (down to cell). **Zoom only.** |
| `cv1` / `cv2` / `cv4` (+`e` = `crop exact=1`) | photo -> convert -> crop -> canvas at 1.15 x k -> `loop` -> `crop` x/y over `n` -> (down to cell). **Pan only**: `crop`'s w/h are evaluated once, so a canvas crop cannot zoom. |

## 1. Ken Burns / pan: smoothness, time, peak RSS

### Smoothness (`results/smoothness.json`, 4 s clip, filter output, no encode)

Metric: the horizontal displacement of two 200x200 strips (left and right of the focus row) between
consecutive full-resolution frames, measured to sub-pixel accuracy (SSD block match + parabola);
a quadratic fit removes the intended (smooth) motion, and the RMS / max residual is the judder **in
output pixels**. Texture and real photo agree to within 0.08 px, so the table shows the texture.
"stalls" = frames whose frame-to-frame difference is under half the median (a repeated picture).

| Technique | Ken Burns jitter rms / max (px) | stalls | Pan jitter rms / max (px) | note |
|---|---|---|---|---|
| zp1 | 1.08 / 3.46 (photo 4.79) | 1 | 1.67 / 2.24 | median frame diff = 0: **most frames are repeats**; unusable |
| zp2 | 0.41 / 1.06 (photo 1.19) | 0 | 0.43 / 0.51 | |
| **zp4** | **0.13 / 0.43** | 0 | **0.17 / 0.42** | |
| sc | 0.60 / 1.02 | 17 | (= cv1) | visible stalls |
| sc2 | 0.18 / 0.78 | 5 | | a few stalls |
| sc4 | 0.13 / 0.39 | 0 | | 2 GiB RSS, see below |
| cv1 | | | 0.48 / 0.64 | steps alternate 1 and 2 px |
| cv2 | | | 0.48 / 0.65 | **same as cv1**: `crop` rounds x to an even value for 4:2:0 |
| cv2e | | | 0.22 / 0.36 | with `exact=1` |
| cv4e | | | 0.13 / 0.15 | best pan |

Reading: judder is the integer snap of the crop/zoom window measured in output pixels, so it falls
with the canvas scale. About 0.25 px rms with no stall is clean; 0.4 px and above (zp2) is a
faint shimmer; 0.5 px and above (cv1, sc, zp1) is visible on a slow move.

### Time per 4 s clip and peak RSS (median of 3; MiB; pass-1 encode CRF 8 ultrafast included)

Default ffmpeg threads (14-core Mac):

| Kind | zp1 | zp2 | **zp4** | sc2 | sc4 | cv2e (pan) | cv4e (pan) |
|---|---|---|---|---|---|---|---|
| photo KB | 687 ms / 133 | 777 / 158 | **989 / 192** | 2149 / 868 | 4773 / 1996 | | |
| photo pan | 638 / 129 | 752 / 157 | **954 / 190** | | | 679 / 190 | 819 / 270 |
| collage 2 KB | 748 / 202 | 955 / 233 | **1295 / 276** | 3213 / 510 | 6828 / 1900 | | |
| collage 3 KB | 850 / 261 | 1340 / 309 | **2431 / 418** | 3996 / 547 | 7654 / 2185 | | |
| collage 4 KB | 908 / 317 | 1441 / 396 | **3313 / 540** | 4326 / 573 | 9244 / 1419 | | |
| collage 4 pan | 843 / 311 | 1334 / 398 | **2953 / 539** | | | 865 / 398 | 1040 / 497 |

`sc*` (per-frame `scale eval=frame`) is 2.8-4.8x slower than zoompan at equal smoothness (sc2 vs zp2, sc4 vs zp4) and takes
0.5-2.2 GiB. `cv*` is the fastest pan (about 3x faster than zp4 on collages), but it cannot zoom.

With `-filter_threads 2 -filter_complex_threads 2` (`results/clips-capped.json`), same time (within 3%), RSS
about halves and no longer scales with the host's core count (`results/parallel.json`: collage4 zp4, 567 -> 303 MiB):

| Kind (zp4) | photo KB | photo pan | c2 | c3 | c4 KB | c4 pan |
|---|---|---|---|---|---|---|
| ms / MiB, capped | 918 / 109 | 886 / 113 | 1233 / 154 | 2059 / 222 | 3215 / 303 | 2721 / 304 |

Four concurrent worst-case clips took the same wall time as one (3.3 s vs 3.2 s, 14 cores).

**Recommendation: `zp4`**, one technique for both KB and pan. Best smoothness of the
single-technique options at 0.13-0.17 px rms, 1.0-3.3 s per 4 s clip (collage 4 is the slow kind, 3.3 s),
peak 190-540 MiB (or 110-305 with the thread caps). `zp2` is cheaper (395 MiB, 1.4 s on collage 4)
but 3x jerkier. `cv4e` is the optional fast path for pan only (1.0 s vs 3.0 s, 497 vs 539 MiB, same
0.13 px); it is not worth a second code path.

Cap for big sources: the 4x upscale is applied to the 720x1280 photos. An own upload of 4000x6000
must **not** be scaled 4x (a 16000x24000 frame). Scale to a fixed canvas of about 2880x5120 (the
size measured here) or leave larger sources as they are.

## 2. Single graph vs two-pass (`results/timeline.json`, `stress.json`, `*-capped.json`)

15 s mixed timeline (11 photo inputs) and a stress timeline at the plan's caps (20 collage4 clips
of 0.7 s = 80 photo inputs, 14 s), zp4, final encode `medium`, median of 3:

| | single graph | two-pass (CRF 8) |
|---|---|---|
| 15 s mixed: total time | 12.1 s | 15.7 s (pass 1 6.0 s + pass 2 9.7 s) |
| 15 s mixed: peak RSS | **1552 MiB** | **640 MiB** (pass 1 max 533, pass 2 640) |
| stress (80 photos): total time | 19.4 s | 23.2 s (15.7 + 7.5) |
| stress (80 photos): peak RSS | **8774 MiB** | **687 MiB** |
| with filter thread caps: mixed / stress RSS | 967 / 4870 MiB | 633 / 685 MiB |

The single graph's memory grows with the number of inputs (1.5 GiB at 11 photos, 8.8 GiB at 80).
Two-pass costs about 30% more time and is bounded by the largest clip. **Two-pass is confirmed.**

**Pass 2 is frame-exact** (`facts` in the JSON): concat demuxer over the mkv list with
`-protocol_whitelist file`, the sticker overlay, the silent audio, final encode.

- 450 video frames for the 15 s mixed timeline (420 for the stress one, from 20 x 21 frames).
- pts deltas 33.333-33.334 ms (CFR at 30 fps).
- ffprobe: `h264 High yuv420p`, `color_range=tv`, `color_space/transfer/primaries=bt709`,
  AAC LC 48000 Hz 2 ch; container and stream duration 15.000000.
- Per-frame SSIM two-pass vs single graph: mean 0.99986 and min 0.981 with `qp0` (min is a cut
  frame), so content and cut positions are aligned.
- 3 pass-2 runs with `-threads 2` produced byte-identical files (`deterministic: true`) on this Mac.

Graph facts the builder (3a.5) must follow:

- **Tag frames before `zscale`** (SP3), and here also after the swscale conversion: `setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv`.
- **Always `-r 30 -fps_mode cfr`** on the encode. Without it ffmpeg took the image demuxer's 25 fps
  and dropped frames (the 102-frame clip in an early run).
- **Repeating a still: `loop=loop=N-1:size=1,settb=1/30,setpts=N`.** `setpts=N/(30*TB)` on the image
  demuxer's 1/25 time base truncates to duplicate pts.
- **Collage overlays: no `eof_action=endall` on the cells.** A cell ending together with the black
  `color=...:d=T` base dropped the last frame (119 instead of 120). Use the default (repeat) and let the
  base give the exact length. The sticker/APNG overlay on the whole timeline does want `endall`
  (SP3) with the sticker input longer than the timeline (`-t total+1`); that gave exactly 450 frames.
- **Do not assert the container duration after an AAC concat copy** (SP3). Pass 2 here builds the
  audio inside the graph, so stream and container both read 15.000000, but the assertion should still
  be on video frames.
- `crop` rounds x/y to even for 4:2:0; add `exact=1` where sub-pixel-ish steps matter.

## 3. Pass-1 intermediate: `-qp 0` vs CRF 8 vs CRF 10 (`results/inter.json`, `timeline.json`)

x264 `ultrafast`, 4 s clips, zp4, median of 3. Size (MiB) / time (ms):

| Clip | `-qp 0` | CRF 8 | CRF 10 |
|---|---|---|---|
| photo KB | 79.1 / 1084 | 33.4 / 973 | 25.4 / 917 |
| photo pan | 45.9 / 886 | 25.4 / 915 | 21.9 / 895 |
| collage 3 | 77.0 / 2092 | 35.3 / 2111 | 27.4 / 2098 |
| collage 4 | 71.1 / 3240 | 40.3 / 3258 | 30.8 / 3278 |
| 15 s mixed timeline (total) | 258.7 | 120.1 | 94.7 |

The plan's 93 MB per 4 s for `-qp 0` is an upper bound here (46-79). The intermediate setting does
not change time (zoompan dominates) or RSS.

Quality of the FINAL encode (medium, CRF 20; mixed timeline; `results/timeline.json`,
`results/finals-vs-lossless.json`):

| Intermediate | SSIM final vs single-graph final | vs the qp0-based final | SSIM of the decoded intermediate vs lossless | SSIM of the final vs the LOSSLESS clips |
|---|---|---|---|---|
| single graph (reference) | 1 | | | 0.97961 |
| `-qp 0` | **0.99986** | 1 | 1 | 0.97958 |
| CRF 8 | **0.99119** | 0.99123 | 0.99691 | 0.97866 |
| CRF 10 | 0.99088 | 0.99092 | 0.99598 | 0.97845 |
| CRF 8, stress timeline | 0.98992 | | | |

Reading:

- CRF 8 passes the bar (>= 0.99) on the mixed timeline (0.9912) and misses it by 0.0001 on the
  stress one (0.9899); CRF 10 is 0.9909.
- The bar itself is the problem: two independent CRF 20 encodes of *slightly different* input differ
  by encoder noise, whatever the input's fidelity. Only a bit-identical input (`-qp 0`) gets to
  0.9999.
- Against the lossless clips, CRF 8 costs 0.0009 SSIM (0.97866 vs 0.97961 single graph) and CRF 10
  0.0012, both invisible next to the CRF 20 encode's own 0.9796.
- The final at CRF 20 sits near the 3500k cap (3.2-3.3 Mbit/s on this synthetic 4-cell content),
  so the VBV limit, not CRF, sets its quality.

**Recommendation: keep CRF 8** (`-preset ultrafast`): half of `-qp 0`'s size (120 vs 259 MiB per 15 s,
about 480 MiB for four parallel renders instead of 1 GiB), same time. CRF 10 saves another 21% but
gives no reason to leave the plan. **Reword the acceptance bar**: "SSIM(final) against the lossless
render is within 0.002 of the single-graph final" (measured 0.0009), rather than "0.99 against a
single-pass encode".

## 4. x264 preset for the final encode (15 s mixed timeline, from CRF 8 intermediates; median of 3)

| Preset | Pass-2 time | Size | Bitrate | SSIM vs lossless | Peak RSS |
|---|---|---|---|---|---|
| fast | 7.6 s | 5.89 MiB | 3291 kbit/s | 0.97867 | 568 MiB |
| **medium** | **9.7 s** | 5.76 MiB | 3220 | 0.97866 | 638 |
| slow | 15.0 s | 5.47 MiB | 3057 | 0.97877 | 712 |

`slow` is 54% slower than `medium` for 5% less size and no SSIM gain (the VBV cap binds);
`fast` is 22% faster for 2% more size. **Recommendation: `medium`** (the plan's default; no reason to
go to `slow`). All three are deterministic across repeated runs. The plan's timeout
`max(90 s, 30 x total s)` is 450 s for a 15 s render against a measured 15.7 s.

## 5. Colour: full -> limited range and 601 -> 709 (`results/colour.json`)

The chart JPEG (`yuvj420p pc bt470bg`) is scaled to 1080x1920 with the sticker over a uniform block.
The output is decoded as raw `yuv420p` planes with **no** conversion, and 26 chart patches plus 8
sticker patches (opaque and alpha 128, blended with the block colour) are compared with the expected
limited-range BT.709 Y'CbCr computed from their RGB (patch means, 8-bit code values).

| Chain | max abs deviation Y / Cb / Cr | worst group |
|---|---|---|
| **explicit** (below), lossless encode | **0.96 / 1.60 / 1.54** | chart 1.54, sticker opaque **0.48**, sticker alpha-128 1.02 |
| explicit + final encode (CRF 20, 3500k) | 0.96 / 1.60 / 1.54 | sticker opaque 0.48 |
| explicit, photo via `zscale` | 0.78 / 1.02 / 0.85 | |
| **TRAP: sticker left to the auto scaler** | **14.6 / 8.9 / 4.8** | opaque sticker 14.6, alpha-128 sticker 7.2 |
| **TRAP: photo only `format=yuv420p`** | **27.6 / 12.3 / 7.7** | chart 27.6 (full-range values labelled limited) |

The residual of the explicit chain is the source's own 8-bit quantisation: the chart JPEG
round-trips with up to 1 RGB level of error, which is 1.5 chroma codes; the PNG sticker path
(no JPEG) is within 0.5 code (rounding). The final encode adds nothing measurable on patch means.

The chain:

```
photo:   scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,
         format=yuv420p,
         setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv
sticker: format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p
         then overlay=...:format=yuv420
encode:  -pix_fmt yuv420p -colorspace bt709 -color_primaries bt709 -color_trc bt709 -color_range tv
```

Without the explicit sticker conversion the sticker's red (220,40,40) reads 13.8 codes too bright
in Y and 8.9 codes off in Cb (its green is 14.6 codes too dark): the 601 trap is real and large. `zscale` also works for photos, if the
frames are tagged first (`setparams=colorspace=bt470bg:...:range=pc`), with the same accuracy.

## 6. Peak RSS for «Авто»: `min(clamp(floor((cores-1)/2),1,4), max(1, floor(0.25 x totalmem / peakRSS)))`

Peak RSS per stage (MiB, median-of-3 runs; the max of the three is shown):

| Stage | default threads | with `-filter_threads 2 -filter_complex_threads 2` |
|---|---|---|
| pass 1 photo (KB / pan) | 192 / 190 | 109 / 113 |
| pass 1 collage 2 | 276 | 154 |
| pass 1 collage 3 | 418 | 222 |
| pass 1 collage 4 (KB / pan) | 540 / 539 | 303 / 304 |
| pass 2, 15 s, 5 clips, `medium` | 640 | 636 |
| pass 2, 20 clips / 80 photos | 687 | 685 |
| pass 2 with `qp0` inputs (worst seen) | 688 | 686 |

A job runs its passes one after another, so **a job's peak is its pass 2** (about 640-690 MiB), not
its biggest clip. The thread caps roughly halve pass 1 but leave pass 2 unchanged.

**Recommended constant: `peakRSS = 768 MiB`** for every job kind (worst measured 688 MiB plus about 10% for other content and the Windows build). Also set
the two filter-thread caps (no cost, and pass-1 RSS stops depending on the core count).

What the formula gives with 768 MiB (`results/finals-vs-lossless.json`):

| Machine | cores term | RAM term | «Авто» |
|---|---|---|---|
| this Mac (14 cores, 36 GiB) | 4 | 12 | **4** |
| 16 GiB, 8 cores | 3 | 5 | **3** |
| 16 GiB, 4 cores | 1 | 5 | **1** |
| 8 GiB, 8 cores | 3 | 2 | **2** |
| 8 GiB, 4 cores | 1 | 2 | **1** |

Concurrency costs nothing on time up to 4 jobs on this Mac (batch of 4 = 3.3 s, same as one), so
the cores term is the safe one.

## Recommendation

| Item | Choice |
|---|---|
| Technique | **`zoompan` on a 4x lanczos upscale** of the cover-cropped photo (`zp4`), for KB and pan, photo and collage cells alike. Cap the canvas at about 2880x5120 for large own photos. |
| Pipeline | **Two-pass confirmed.** Single graph: 1.5 GiB at 11 photos, 8.8 GiB at 80. Two-pass: 640-690 MiB at any size, +30% time, frame-exact (450/450 frames, CFR 33.333 ms, per-frame SSIM min 0.981 at a cut). |
| Intermediate | **CRF 8 `ultrafast`** (25-40 MiB per 4 s clip; 120 MiB per 15 s). SSIM 0.9912 vs single-graph final on the mixed timeline, 0.9899 on the 80-photo stress; against lossless the loss is 0.0009. Reword the bar as above. |
| Final preset | **`medium`** (9.7 s for a 15 s timeline, 5.76 MiB). |
| Colour chain | Photo: swscale pc/601 -> tv/709 + BT.709 tags; sticker/overlay: explicit `scale=out_color_matrix=bt709:out_range=tv` to `yuva420p` before `overlay`; encoder tags bt709/tv. Max deviation 1.6 code values (source quantisation), sticker 0.5; without the explicit step up to 14.6 (Y) / 8.9 (Cb). |
| peakRSS | **768 MiB** per job; `-filter_threads 2 -filter_complex_threads 2` on every ffmpeg call. «Авто» = 4 on this Mac, 3 on 16 GiB/8 cores, 2 on 8 GiB/8 cores. |

## Not covered by this run

- Windows: no Windows run here (the SP3 dispatch workflow is macOS and Windows for facts only). The
  6.1.1 build's RSS and speed need one run of `clips.ts`/`timeline.ts` on the runner.
- `creation_time` / `mvhd` contents, the iPhone HEVC HLG import, and the `estimateBytes` table
  beyond the sizes above (final ≈ 3.0-3.3 Mbit/s on busy content, capped at 3500k).
- Determinism was checked only across repeated runs on this Mac, not across machines.
