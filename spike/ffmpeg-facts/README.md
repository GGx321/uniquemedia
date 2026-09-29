# SP3: per-platform ffmpeg facts

Stage 3 plan (`docs/studio/2026-09-29-stage-3-plan.md`), spike SP3. Studio ships the
`ffmpeg-static` binary, and that binary differs by platform (macOS arm64 reports 6.0;
Windows x64 is expected to be 6.1.1 from gyan.dev). This spike records what each build
actually supports, so the render pipeline (3a.5), text, music and own-video import
(3f.3a) are built on facts rather than on the macOS build alone.

## Run

```sh
bun spike/ffmpeg-facts/probe.ts [report.json]
```

The default report name is `ffmpeg-facts-<platform>-<arch>.json`. The binary is resolved
through `studio/node/ffmpegBinary.ts` (`ffmpegPath()`), exactly as Studio does.
`ffprobe-static` measures the smoke outputs; without it the probe falls back to
`ffmpeg -f null`. Exit code is non-zero if a REQUIRED item is missing or a smoke fails.

In CI: Actions, "studio-ffmpeg-facts", "Run workflow" (dispatch-only, macOS and Windows).
Each job uploads its JSON as an artifact.

## What it checks

| Group | Items | Required |
|---|---|---|
| Header | `-version` first line, `-buildconf` flags (parsed), `-L` licence text, GPL and nonfree flags, `-hwaccels` | recorded |
| Filters | zoompan, overlay, fade, xfade, concat, fps, transpose, zscale, tonemap, colorspace, ebur128, volume, aresample, apad, atrim, anullsrc, scale, crop, pad, format, setsar, setpts, trim, loudnorm, alimiter, split | yes |
| Filters (record) | drawtext, acrossfade, amix, aformat, afade, atempo, hstack | no |
| Demuxers | concat, mov, matroska, gif, apng, image2, mp3, aac, wav, flac, ogg | yes |
| Decoders | h264, hevc, vp9, av1, prores, png, mjpeg, gif, apng, webp, mp3, aac, aac_latm, flac, alac, pcm_s16le, vorbis, opus | yes |
| Encoders | libx264, aac, png | yes |
| Encoders (record) | h264_videotoolbox, h264_nvenc, h264_qsv, h264_amf, h264_mf, ffv1, libx264rgb | no |

`drawtext` is recorded only: text is rasterised by Studio, not by ffmpeg. `aac` decodes
HE-AAC; `aac_latm` is listed for completeness.

Smokes (each timed; a failure fails the run):

1. Main graph: two 1 s `testsrc2` clips through `zoompan`, `xfade` (0.4 s), `overlay`,
   plus `sine` through `ebur128`, `aresample`, `apad`, `atrim`; encoded `libx264` + `aac`.
   Asserts 1.6 s and exactly 48 frames.
2. Concat demuxer with `-protocol_whitelist file`, stream copy, of two copies of (1).
3. HDR (PQ, tagged) `zscale` + `tonemap` chain down to BT.709.
4. `colorspace` filter.
5. `fps`, `transpose`, `scale`, `crop`, `pad`, `setsar`, `setpts`, `trim`, `fade`, `split`.
6. `anullsrc`, `volume`, `loudnorm`, `alimiter`.
7. PNG with alpha, APNG encode, APNG demux and decode.
8. Informational only: any hardware H.264 encoder the build lists is tried once.

## Findings worth carrying into the plan

- **The macOS build is `--enable-gpl --enable-nonfree`** (libx264, libx265, and others).
  Its own `-L` output says it "is not legally redistributable". This is a licence and
  distribution question for the Studio installer, independent of filter support.
- **`zscale` needs colour-tagged input.** Untagged frames fail with `code 3074: no path
  between colorspaces`. The 3f.3a tonemap chain must tag its input
  (`setparams=colorspace=...:color_primaries=...:color_trc=...:range=...`) or be fed
  tagged frames straight from the decoder.
- `overlay` outlives the main graph when the overlay source is longer. Use
  `eof_action=endall` (or `shortest=1`) so the output length stays exact (invariant 20).
- A stream-copied concat of AAC clips reports ~22 ms over the sum (encoder priming):
  3.222 s for 2 x 1.6 s. Do not assert exact container durations after a concat copy.

## Results

### macOS arm64 (run locally, 2026-09-29)

- `ffmpeg version 6.0`, binary from `ffmpeg-static`; `ffprobe-static` available.
- Licence: GPL, nonfree (see above). Hwaccels: `videotoolbox`.
- Filters: every required filter present, including `zscale`, `tonemap`, `colorspace`
  (`--enable-libzimg`); `drawtext` present.
- Demuxers: all 11 present. Decoders: all 18 present. Encoders: `libx264`, `aac`, `png`,
  `h264_videotoolbox`, `ffv1`, `libx264rgb` present; `h264_nvenc`, `h264_qsv`,
  `h264_amf`, `h264_mf` absent (expected on macOS).
- Smokes: all pass. Main graph 67 ms (1.600 s, 48 frames), concat 13 ms, tonemap 15 ms,
  `h264_videotoolbox` 125 ms.
- Missing required items: none.

### Windows x64 (CI run 36512693978, 2026-09-29)

- `-version`: `ffmpeg version 6.1.1-essentials_build-www.gyan.dev`.
- Licence: GPL v3, **not** nonfree, so it is redistributable under the GPL's terms (source offer,
  licence text). The macOS 6.0 build is nonfree and says it is not legally redistributable.
- Hwaccels: `cuda`, `dxva2`, `qsv`, `d3d11va`.
- Missing required items: none. Filters, demuxers and decoders: all present.
- Encoders: `libx264`, `aac`, `png`, `ffv1`, `libx264rgb`, plus hardware `h264_nvenc`,
  `h264_qsv`, `h264_amf`, `h264_mf`; `h264_videotoolbox` absent (expected).
- Smokes: all pass. Main graph 197 ms, concat copy 32 ms, tagged PQ `zscale`+`tonemap` to
  BT.709 35 ms, `colorspace` 23 ms, geometry chain 30 ms, audio chain 33 ms, PNG with alpha
  24 ms, APNG encode 63 ms, APNG demux+decode 21 ms. (The CI macOS run: main graph 188 ms.)
- Differences from macOS: version 6.1.1 vs 6.0; GPL v3 vs GPL + nonfree; hardware encoders
  differ as listed. No difference in the filters, demuxers or decoders Stage 3 requires.

### Consequences for the Stage 3 plan

- Every filter, demuxer, decoder and encoder the plan requires exists on both platforms.
- The four findings above (`zscale` needs tagged input, `overlay` `eof_action=endall`,
  AAC concat priming, licence) go into the plan.
- Licence: fine for the owner's personal use. Before any public distribution of an installer,
  the macOS binary must be replaced by a redistributable (non-nonfree) build, and both
  installers need the GPL obligations met (tracked with the third-party notices backlog item).
- Stage 4 performance work can consider the Windows hardware encoders next to VideoToolbox.
