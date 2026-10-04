# Video fixtures (Stage 3, 3f.3a)

Test inputs for the own-video importer (`../../../videoImporter.ts`), its box walker (`../../videoProbe.ts`) and the packaged smoke. They are
pinned by size and sha256 in `index.ts` and verified by `fixtures.test.ts`. Import the paths from `index.ts`; do not hard-code them.

They are **committed**, not generated in the tests, because the encoders that made them (libx265 and prores_ks) are not among the encoders the
CI facts probe requires on both platforms (SP3 lists libx264, aac and png). The tests only need the DECODERS (hevc, h264, prores), which SP3
requires and found on macOS 6.0 and Windows 6.1.1. `generate.ts` makes them again on a machine whose bundled ffmpeg has the encoders (the macOS
build does) and prints the numbers `index.ts` pins; the output is deterministic (single-threaded encoders, bit-exact flags), so a second run
gives the same sha256.

Every clip is a few frames of one of two things: the **colour chart** below, or a flat picture. All are 3 to 14 frames and at most 17 KB.

## The chart

192 x 96 pixels, 24 patches of 32 x 24 (6 across, 4 down), every edge on an even pixel so 4:2:0 chroma is clean. Row by row: twelve greys
(non-linear signal 0.04 to 0.95), then twelve colours kept clear of the gamut's edge. The patch signals are in `../chart.ts` (`CHART_PATCHES`).
The HLG clips carry them as BT.2020 HLG signals (0.75 is HLG's reference white); the SDR clips as BT.709 gamma signals. They are written as raw
Y'CbCr frames by `generate.ts` (no source filter whose output differs between ffmpeg builds), so each patch's codes are exact; decoding the
HEVC fixture without any conversion gives every patch's mean to the code.

## The files

| File | What | Used for |
| --- | --- | --- |
| `hevc-hlg-chart.mp4` | HEVC Main 10, `hvc1`, BT.2020 / ARIB STD-B67 / BT.2020nc tagged, the chart, 3 frames, `moov` after `mdat` | the HLG proof (invariant 36); the base for the Dolby Vision 8.4 (`dvcC`, `dvvC`) and PQ variants, which tests make by editing its boxes (`../mp4Patch.ts`) |
| `h264-sdr-chart.mp4` | H.264 BT.709, the chart, 5 frames, an AAC track, and every kind of metadata a phone writes (title, GPS `location`, creation time, a handler name) | SDR identity within 2 codes; that audio and metadata are dropped; the base for the four rotations (the matrix is edited in a copy) |
| `h264-vfr.mp4` | H.264, a test pattern, 14 frames at 30 fps, then 10 fps, then 30 fps again (timescale 600) | variable frame rate becomes a constant 30 fps |
| `prores-hq-chart.mov` | ProRes 422 HQ (`apch`), 10-bit 4:2:2, the chart, 3 frames, QuickTime's `nclc` colour box | ProRes through the same chain |
| `hevc-hlg-rotated-vfr.mov` | HEVC HLG chart, variable rate (as above), a quarter turn in `tkhd` (an iPhone held upright) | the all-in-one proof, and the packaged smoke's clip |
| `hevc-hlg-flat-4k.mp4` | HEVC HLG, flat grey, 4096 x 2160, 3 frames | a real 4K decode under `-max_alloc` and `-max_pixels`, and the fit to 1080 wide |

Two more are hostile layouts made with a real encoder:

| File | What | Used for |
| --- | --- | --- |
| `mpeg4-then-h264-two-video-tracks.mp4` | MPEG-4 Part 2 320 x 240 first, H.264 64 x 64 second, moov after mdat | the track-bypass tests: a test patches the first track's `hdlr` or moves it out of `moov`, and ffmpeg still sees it |
| `h264-sps-4224x2176-claims-1080p.mp4` | H.264 whose bitstream is 4224 x 2176 (past 4K) under a `tkhd` and sample entry that say 1920 x 1080 | that `-max_pixels` stops a decode the headers lied about |

And the ones real editors and encoders make (review round 2): edit lists.

| File | What | Used for |
| --- | --- | --- |
| `h264-copy-trim-ss0.5.mp4`, `-ss1.0`, `-ss1.9` | a 10 s clip with a keyframe every 2 s, cut with `-c copy` at 0.5 / 1.0 / 1.9 s for 3 s: 105 / 120 / 147 samples, an `elst` of 3.000 s from 0.5 / 1.0 / 1.9 s in | the picture is the EDIT's length (90 frames at 30 fps), not the samples' |
| `h264-bframes.mp4`, `hevc-bframes.mp4` | x264 / x265 B-frames in MP4: a `ctts` and an `elst` of the clip's own length from media time 1024 of 15360 | the count is the samples' (60), and an edit that starts a little way in is not a trim |

What ffmpeg 6.0 does with them, measured: it honours the edit list (the trims come out at 90 frames, not 105, 120 or 147; with a `ctts` and its
compensating edit the count is the samples'; an empty edit before the segment adds no frames; an edit longer than the samples plays all the
samples; one shorter cuts them). The importer's frame check is built from that (`expectedFrames`, `../../videoPlan.ts`).

Hostile and truncated box trees are not files: the tests build them byte by byte (`../mp4VideoBuilder.ts`) and fuzz them.

## What the HLG clip proves (invariant 36, "where the chart allows")

SP1 did not cover an iPhone HEVC HLG clip, so this one is the first proof of that path. The mezzanine's chart is decoded to raw planes (no
conversion but the pixel format) and each patch's mean is compared with `hlgToSdrBt709` (`../chart.ts`), a model of the chain whose formulas are the
standards' (the BT.2100 inverse OETF, BT.2087's primaries matrix, Hable's curve, BT.1886) but whose three constants were FITTED to ffmpeg's own
output, found by measuring the chain stage by stage on macOS ffmpeg 6.0. So the check proves that the chain does what a model with those
constants says on every patch (the neutrals stay neutral, the hue is kept, the order and the gamut clip are right); it is not a proof from first
principles that the constants are the right look:

- zimg lights HLG **per channel**, display = 10 x E^1.2 (a 1000 nit peak over the 100 nit reference, the BT.2100 system gamma), not with a
  luminance-weighted gain: the second reading is wrong by up to 7 codes on the colour patches;
- `tonemap` takes the brightest channel, curves it with Hable, divides by `hable(10)` (ffmpeg's default peak when a frame carries none) and
  scales all three channels alike, so the hue is kept (measured: the three channels' ratio is identical to six digits);
- the BT.709 output is a plain 1/2.4 power (BT.1886), which is how zimg encodes display-referred light.

Measured on macOS arm64, ffmpeg 6.0 (the worst patch, then the mean over the 24):

| Clip | Worst Y / Cb / Cr (codes) | Mean Y / Cb / Cr |
| --- | --- | --- |
| HEVC HLG against the model | 1.00 / 0.95 / 1.00 | 0.09 / 0.10 / 0.17 |
| H.264 SDR against its own codes | 0.08 / 0.08 / 0.08 | 0.00 / 0.01 / 0.01 |
| ProRes 422 HQ against its own codes | 1.00 / 1.00 / 0.83 | 0.16 / 0.17 / 0.09 |

The bar is 2 codes. Patches whose BT.709 light would be negative (green, cyan, red and others lie outside BT.709's gamut) are clipped at zero in
both the chain and the model, and agree.
