# face-js spike

Can Studio check "is this still the avatar's face" in pure JS/WASM, with no Python and no
native addons? This spike ports `spike/studio-api/face.py` (OpenCV 5.0.0 `FaceDetectorYN` with
YuNet 2023mar, then `FaceRecognizerSF` with SFace 2021dec: `alignCrop`, `feature`, cosine) to
TypeScript on `onnxruntime-web` 1.30.0 (WASM backend). It then measures parity against
`spike/studio-api/out/face.json`, speed, and the environments it runs in.

**Answer: yes.** Given the same pixels, the port reproduces OpenCV exactly. All remaining
differences come from the image decoder. `out/` is git-ignored; this README is the durable record.
All numbers below are from 2026-09-24 on an Apple M4 Max (14 cores).

## Layout

| file | role |
| --- | --- |
| `lib/decode.ts` | ffmpeg-static → BGR24; `bgr24` (swscale) or `libjpeg` (Y/Cb/Cr planes + libjpeg-turbo upsampling/colour tables in JS) |
| `lib/onnx-shape.ts` | rewrites YuNet's fixed input shape (see below) |
| `lib/yunet.ts` | `FaceDetectorYN` pre/post-processing and NMS |
| `lib/sface.ts` | similarity transform, `warpAffine` (float32 kernel of OpenCV 5.0), SFace forward, cosine |
| `lib/parity.ts`, `parity.ts` | parity report vs `face.json` |
| `run.ts` | CLI: all images → `out/face-js.json` + `out/parity.json` |
| `electron-check/` | Electron harness: utilityProcess run + hidden renderer with Chromium decoding |

Ported from OpenCV 5.0.0 sources: `objdetect/src/face_detect.cpp`, `face_recognize.cpp`,
`dnn/src/nms.inl.hpp` + `nms.cpp`, `core/types.hpp` (Rect `&`, `jaccardDistance`),
`imgproc/src/imgwarp.cpp` + `warp_kernels.simd.hpp`; for the `libjpeg` decoder,
libjpeg-turbo `jdsample.c` (`h2v2_fancy_upsample`) and `jdcolor.c`. The similarity transform
uses the closed form of the 2×2 Umeyama solution (rotation `atan2(A10−A01, A00+A11)`, scale
`hypot(…)/var`). This is mathematically identical to OpenCV's SVD branches.

## Running

Prerequisites: `spike/studio-api/out/{avatar,render,models}` and `face.json` from the
studio-api spike. Run everything from the repo root.

```sh
bun run spike/face-js/run.ts [--threads N] [--decoder bgr24|libjpeg] [--output path]
node spike/face-js/run.ts                    # Node with type stripping (tested 26.8)
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron spike/face-js/run.ts \
  --output spike/face-js/out/face-js.electron-node.json

# Electron: utilityProcess (ffmpeg decode) + renderer t1 and t4 (Chromium decode)
bun run spike/face-js/electron-check/build.mjs
node_modules/.bin/electron spike/face-js/electron-check/main.mjs
bun run spike/face-js/parity.ts spike/face-js/out/face-js.renderer-t1.json   # and -t4
```

## Parity vs face.json

83 images. Faces were found in every image, and the face count matches everywhere (83/83).
|Δcos| is compared on 81 images; the 2 self-matches with cos 1.0 are excluded.

| decoder | cosMaster max / mean | cosFront max / mean | Spearman (renders) | flips at 0.70 |
| --- | --- | --- | --- | --- |
| Chromium (renderer `createImageBitmap`) | 0.0001 / 0.00003 | 0.0002 / 0.00004 | 1.000 | 0 |
| ffmpeg `bgr24` (default) | 0.0295 / 0.0110 | 0.0241 / 0.0082 | 0.994 | 2 (B/travel-3 0.681→0.702, C/travel-2 0.699→0.713) |
| ffmpeg `libjpeg` | 0.0262 / 0.0042 | 0.0222 / 0.0039 | 0.999 | 1 (C/travel-2 0.699→0.705) |

With Chromium decoding, the head-ratio difference is 0. With ffmpeg it is max 0.015, from one
image (see below).

**The decoder is the only source of difference.** In a one-off diagnostic (the script is not in
the repo), `cv2.imread` pixels for 6 images (master, pack-front, a PNG, the three worst JPEGs)
were fed into the JS pipeline. Landmarks matched within 1.2e-4 px. The aligned 112×112 crop was
byte-identical. SFace features gave cos 1.000000.

- PNG through ffmpeg is bit-exact.
- JPEG through ffmpeg `bgr24` is about 83% byte-identical to OpenCV (mean |Δ| 0.16–0.19 levels).
- The `libjpeg` path is about 97% byte-identical (mean |Δ| 0.03–0.04). The rest is presumably
  FFmpeg's IDCT; this was not investigated.
- Chromium, like OpenCV, decodes with libjpeg-turbo, which is why parity is exact.
- A one-off check showed Electron `nativeImage.toBitmap()` is also 100% byte-identical to
  `cv2.imread` (3 JPEGs + 1 PNG).

SFace is sensitive to sub-pixel landmark jitter. With ffmpeg decoding, master's own feature is
only cos 0.990 against OpenCV's. In C/fitness-1 a different anchor wins the detection, and the
landmarks jump by 19 px. Decoder choice alone moves scores by ±0.01–0.03. Calibrate thresholds
with the exact decoder that runs in production.

Results are deterministic across runtimes: bun, Node, Electron node mode and utilityProcess
agree to 1e-6, and renderer t1 equals renderer t4.

## Environments and threading

| environment | works | notes |
| --- | --- | --- |
| bun 1.3.12 | yes | bun defines `self` without `crossOriginIsolated`, so ORT picks **1 thread**; `--threads 4` works |
| Node 26 / Electron 43 node mode (Node 24.18) | yes | `.ts` runs via type stripping; ORT defaults to min(4, cores/2) threads |
| Electron utilityProcess | yes | ORT's pthread workers keep the process alive after the work is done, so it needs `process.exit` or an explicit teardown (`run.ts` exits explicitly) |
| Electron renderer, 1 thread | yes | no extra setup |
| Electron renderer, 4 threads | yes | needs **COOP/COEP on the page**, **COEP on the worker script response**, and a bundle built from **`ort.wasm.min.mjs`** |

About the renderer bundle: the default `ort.bundle.min.mjs` starts its pthread workers from
`import.meta.url`, which means from our whole bundle, and the session hangs. `build.mjs` points
`onnxruntime-web` at `ort.wasm.min.mjs`, which also avoids the 28 MB JSEP wasm.

Harness quirks: a fresh `BrowserWindow` created right after destroying the previous one
sometimes failed its load with `ERR_FAILED`, so one window is reused. stdout written just before
`app.exit()` was lost, so the harness logs with `writeSync`.

## Timings

Median, detection + embedding, excluding decode and model load:

| | 720×1280 | 1584×2816 |
| --- | --- | --- |
| 1 thread (bun default, renderer t1) | 75–79 ms (detect 47–50, embed 28) | ~250 ms |
| 4 threads (bun `--threads 4`, Electron node, utilityProcess, renderer t4) | ~25 ms (detect 16–17, embed 8) | 80–91 ms |
| OpenCV Python, native, 14 threads (reference) | ~15 ms (detect 9.0, embed 5.9) | detect 36.5 |

- Decode at 720×1280 / 1584×2816: ffmpeg spawn ~19 / 110–125 ms; Chromium ~7 / 55 ms.
- Model load (both models): 130–140 ms in Node/bun, ~190–200 ms in the renderer (served over
  `app://`).
- The first image costs about 2× (warm-up).

## Installer payload

| asset | size | gzip |
| --- | --- | --- |
| `face_recognition_sface_2021dec.onnx` (Apache-2.0) | 38.7 MB | 35.9 MB |
| `ort-wasm-simd-threaded.wasm` | 14.2 MB | 3.7 MB |
| `face_detection_yunet_2023mar.onnx` (MIT) | 233 KB | |
| JS glue: `ort-wasm-simd-threaded.mjs` 24 KB + `ort.wasm.min.mjs` 50 KB (renderer) or `ort.node.min.mjs` 27 KB (Node) | ~75 KB | |

Total is about 53 MB. Packaging must exclude the other ORT wasm variants (jsep, asyncify, jspi,
about 72 MB in `node_modules`).

## YuNet input rewrite

`face_detection_yunet_2023mar.onnx` declares its input as `[1, 3, 640, 640]`. OpenCV runs it at
the image size padded to a multiple of 32, but onnxruntime rejects any other static dims.
`lib/onnx-shape.ts` rewrites the protobuf at load time:

- the input becomes `[1, 3, "height", "width"]`;
- the declared output shapes and the 94 `value_info` entries (recorded for 640×640) are dropped;
- every other byte is copied.

The graph itself is size-agnostic: Reshape targets are `[1, -1, C]` and Resize uses scales.
Studio could instead ship a pre-patched model.

## Calibration finding

cosMaster; OpenCV and the Chromium-decoded port give the same values:

- 76 same-person renders: min 0.466, median 0.697, max 0.911.
- 3 different people generated from the same description (candidate-1..3): 0.621–0.658.
- At 0.70 all impostors are rejected, with a 0.043 margin. But only **37/76** true renders pass,
  and **23/76** score below the best impostor.

The threshold separates impostors but rejects about half of the good frames.

Options for Stage 2c (no decision made):

- a lower threshold that catches only gross drift, e.g. a different person;
- a multi-reference gallery of already-accepted frames, scoring max or mean cos against it;
- a stronger embedding model, e.g. ArcFace-class, which also changes payload and speed;
- keep-best-of-N: generate several and keep the highest-scoring one instead of an absolute gate.

## Recommendation

Ship it. Decode with Chromium: renderer `createImageBitmap`, or `nativeImage.toBitmap()` in main,
then hand the pixels over. Run inference in the engine utilityProcess with 4 wasm threads. That
setup needs no COOP/COEP and gives exact OpenCV parity at ~25 ms per 720×1280 image.

Not yet verified: loading the wasm and onnx files from asar (or `asarUnpack`) in a packaged app,
and Windows.
