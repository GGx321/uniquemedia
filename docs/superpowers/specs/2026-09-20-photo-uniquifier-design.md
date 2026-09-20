# Photo uniquifier — design

Extends the existing video uniquifier to still images. The goal is unchanged:
produce N copies that are perceptually far enough from the original (and from
each other) while staying invisible to the eye.

## What carries over unchanged

- `src/core/pdq/` — PDQ is a still-image hash to begin with; video hashes frames.
- `src/core/filters.ts` — every spatial fragment applies to a single frame as-is.
- `src/core/pipeline.ts` — retry/auto-strengthen, verification and the
  inter-copy uniqueness post-pass are media-agnostic once generic over the
  recipe type.
- `src/core/deviceProfile.ts` — model/iOS/city/GPS/date generation. Only the
  tags written differ (EXIF instead of QuickTime keys).

## What is different, and why

A photo has no temporal axis. Segmented speed, CFR normalisation and the
fps/gop/preset spread — which carry most of the fingerprint shift for video —
have no equivalent. The remaining levers are spatial, plus the JPEG encode.

### Measured: what actually moves PDQ

Bench: `scratchpad/photo-calibrate.ts`, PDQ hamming distance from the original,
SSIM as a visibility proxy (meaningless for geometric ops — they move every
pixel while the eye sees nothing, so those rows are judged by looking).

Two synthetic extremes, 1440x1080:

| Variant | textured (mandelbrot) | smooth (gradient) |
|---|---|---|
| re-encode only | 2 | 2 |
| noise alls=10 | 2 | 42 |
| noise alls=24 | 0 | 36 |
| eq subtle | 0 | 30 |
| hue 6 | 2 | 22 |
| curves | 2 | 30 |
| unsharp / gblur | 0–2 | 2 |
| zoom 3% | 26 | 40 |
| zoom 5% | 44 | 48 |
| pan crop 2% | 44 | 60 |
| rotate 0.3° | 12 | 88 |
| lenscorrection k1=0.015 | 8 | 82 |
| vignette (default) | 18 | 72 |
| vignette off-centre | 34* | 108* |

\* **Retracted.** These two rows measured an artefact, not an effect. ffmpeg's
`vignette` returns 0 beyond `hypot(w/2, h/2)` from its centre, so moving the
centre punches a patch of pure black into the corner — a 3% offset blacks out
~3100 pixels. The high distances were that black patch. Measured again with the
artefact removed (pad, vignette, crop back): 4 on texture, 10 on gradient. A
centred vignette scores 6/12, i.e. barely distinguishable from doing nothing.

Two findings drive the design:

1. **PDQ is close to invariant under noise, brightness, contrast and tone
   curves on detailed content** — by construction, since it bins DCT
   coefficients against their median. The video sampler leans on noise
   (`PARAMS.noise.dev = 14`); for photos that is mostly wasted quality. On the
   textured sample `noise alls=24` scored 0 while pushing the file from 101 KB
   to 271 KB and SSIM down to 0.78.
2. **Sensitivity is strongly content-dependent** — the same operation scores
   2 on texture and 42 on a gradient. No fixed parameter set is right for all
   photos.

### Consequences

- Lead with geometry — the off-centre crop window (`pancrop`) carries the whole
  load on detailed content. Micro-rotation and lens distortion contribute a
  little; vignette, once its black-corner artefact is removed, contributes
  4-10 bits and is no longer a primary lever.
- Keep tone and noise in the recipe, but small: they contribute on smooth
  content, they cost little there, and they keep copies apart from each other.
- What keeps copies apart from EACH OTHER is the pan/window draw: two copies
  whose crop windows sit in different parts of the frame differ far more than
  two copies that differ only in tone. Vignette parameters still vary per copy,
  but they are a garnish, not the mechanism.
- **Start soft and let the pipeline escalate.** The existing auto-strengthen
  loop (`intensity *= 1.4` on a missed target, up to `maxAttempts`) is exactly
  the right answer to content-dependence: an easy photo passes on attempt one,
  a hard one climbs until it clears the target. Tuning the baseline aggressive
  enough for the worst case would needlessly damage the easy ones.
- The default `targetDistance` cannot be copied from video (38). It must be
  calibrated on real photographs — the synthetic extremes bracket the range but
  do not represent it.

## Geometry needs a cover step

`rotate` widens the canvas (`ow=rotw(a)`) and `lenscorrection` pulls the image
away from the edges. Video hides the resulting black wedges behind its export
over-zoom; a photo has no such cover, and black pixels appeared at 0.15°, i.e.
at baseline intensity. The graph therefore inserts a computed `crop,scale` cover
step right after the geometry. Measured clean-crop factors (1440x1080): rotate
0.15° -> 0.996, 0.3° -> 0.992, 0.6° -> 0.988, lens k1=0.01 -> 0.988, k1=0.04 ->
0.964, both at maximum -> 0.954.

## Platform survival

A platform compares what its own pipeline produced, not the uploaded file, so
the shift has to survive a downscale-and-re-encode. Measured against a 1080-wide
JPEG re-encode of both sides: pan crop 44 -> 44, vignette 34 -> 34, the combined
recipe 40 -> 38. Geometric edits survive because they change frame content
rather than its encoding. Note that on smooth content the re-encode alone moves
the original by 26 — PDQ is unstable there to begin with.

## Metric caveat

`extractGrayFrames` downsamples with ffmpeg's `scale=64:64` and hashes that.
Reference PDQ uses a Jarosz blur decimation instead. The distances above are
therefore internally consistent (and consistent with the video path, which
ships on the same proxy) but are not guaranteed to track a platform's own PDQ
implementation exactly.

## Encode

JPEG via ffmpeg's mjpeg encoder: `-q:v` in 3..7 and `-pix_fmt` alternating
between `yuvj420p` and `yuvj444p`. Both quantisation tables and chroma
subsampling are part of a file's signature, and neither is visible at these
settings.

HEIC input is out of scope for the first pass: the bundled ffmpeg has no HEIF
demuxer (verified against `-formats`). macOS can convert via `sips`; Windows
would need another path.

## EXIF identity

Photos carry a much richer device fingerprint than video, and it is free of
visual cost. Notes from the research pass:

- `LensModel` follows `iPhone <Model> back <dual wide|triple> camera <f>mm f/<N>`.
  "Fusion" is marketing only and never appears in EXIF.
- The Pro-tier main lens reports `6.765mm` on current iOS; `6.86mm` is correct
  only for 14 Pro/Pro Max on iOS ≤ 17.3.
- `ColorSpace` is typically `Uncalibrated` (0xFFFF), not sRGB — iOS captures are
  Display P3 and put the real profile in the ICC block.
- `HostComputer` is present straight out of the Camera app and duplicates
  `Model`.
- `SubSecTime*` are 3-digit; `OffsetTime*` carry the local UTC offset and must
  agree with the city/timezone the profile already picks.
- Default output resolution is not the sensor resolution: 14 Pro/Pro Max
  default to 4032x3024, and 15-series onward to 5712x4284.

Unverified and to be treated as such: the exact focal length for iPhone 15 /
15 Plus and the base iPhone 17 (inferred from the 16 pattern).

## Container-level tells (follow-up)

The EXIF block can be made to look like an iPhone capture while the JPEG
container still says otherwise. ffmpeg's mjpeg encoder writes a JFIF APP0
segment (`JFIFVersion 1.02`, `ResolutionUnit None`, `XResolution 1`) and stamps
`Lavc60.3.100` into the JPEG comment. An iPhone capture has no JFIF segment at
all, and carries `XResolution 72` / `ResolutionUnit inches` in EXIF IFD0
instead.

Verified fix (exiftool, one pass, output still decodes):

```
-JFIF:all=                    # drop the APP0 segment entirely
-Comment=                     # drop the encoder signature
-EXIF:XResolution=72 -EXIF:YResolution=72 -EXIF:ResolutionUnit#=2
```

The `#` suffix is not optional. Writing PrintConv tags in their human form
corrupts them silently: `-EXIF:Orientation=1` stores 3 ("Rotate 180"), and
`ExposureProgram`, `WhiteBalance`, `MeteringMode` and `Flash` are dropped with
"not in PrintConv". Only the raw form `-EXIF:Tag#=value` writes them correctly.

## Media kind detection

"No duration means it is a still" does not hold: a JPEG read through ffmpeg's
`image2` demuxer reports `duration: 0.040000` (one frame at a nominal 25fps).
Only PNG (`png_pipe`) reports none. Detection keys on an image codec plus a
duration under half a second.

HEIC never reaches ffprobe usefully — it fails with "moov atom not found". The
HEIF `ftyp` brand is read from the file header before probing, so the error can
name the real problem.

## Measured on real content

A 1080x1920 Instagram story: flat black background, high-contrast graphics, text
sitting at the frame edges. The first non-synthetic sample, and it moved two
decisions.

| variant | PDQ | SSIM |
|---|---|---|
| re-encode only | 0 | 0.976 |
| noise alls=10 | 0 | 0.733 |
| noise alls=24 | 2 | 0.552 |
| eq subtle | 0 | 0.651 |
| hue 6 / unsharp / curves | 0 | — |
| vignette | 12 | 0.929 |
| zoom 5% | 40 | geo |
| pan crop 2% | 64 | geo |
| pan crop 4% | 82 | geo |

Tone and noise are not merely weak here — they are actively harmful. On a flat
background `noise` is plainly visible (SSIM 0.73 for zero hash movement) and
`eq` costs more structure than anything it buys.

### Edge content forbids cropping

`pancrop` cost the copy its last glyphs: the original reads "NEVER GONNA MAKE
IT." and the copy "NEVER GONNA MAKE I". Distance was 54 and every check passed,
because a hash distance cannot see that a word lost a letter. Crop depth against
what it buys, on this image:

| window | offset | lost px, worst edge | PDQ |
|---|---|---|---|
| 0.99 | max | 19 | 20 |
| 0.98 | max | 38 | 38 |
| 0.97 | max | 58 | 52 |
| 0.95 | max | 96 | 82 |

The shipped window (0.945-0.965 with full pan) was discarding up to 96 px to
reach distances the target did not require.

Padding instead of cropping — scale down slightly, pad back to size with an
offset — moves the hash comparably while losing nothing:

| scale | offset | PDQ | content lost |
|---|---|---|---|
| 0.97 | max | 46 | none |
| 0.96 | max | 62 | none |
| 0.94 | max | 92 | none |

Which one is right depends on the frame, not on the medium: padding is
invisible when the outer band is uniform and obvious when the content runs to
the edge. Hence `edgeMode` with an automatic default driven by edge dispersion
measured on the 64x64 buffer the pipeline already extracts.

### `brightness` lifts pure black

A rendered copy measured `mean 7.07` on a background patch that was `0.00` in
the source. `eq`'s `brightness` is additive, so it moves the black point; on an
AMOLED phone — where stories are actually viewed — that reads as a glowing dark
grey rather than black. `contrast`, `gamma` and `saturation` are multiplicative
and leave zero at zero (measured: 0, 2 and 0 respectively against brightness's
5). Since tone contributes nothing to the hash on real content, photo recipes
drop `brightness` entirely. Video keeps it — that path is shipped and pinned.
