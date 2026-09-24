# Studio API spike

A throwaway harness for measuring OpenRouter image models before building
"Studio". Studio needs one recurring, consistent character across many
everyday scenes. For each model config, the spike measures:

- **identity hold**: SFace cosine of each render's face against the master
  and pack-front faces, plus head size (face box height / image height)
- **refusals**: overall, and for the Glamour category at each spice level
- **latency, cost per ok image, and the returned pixel sizes**
- **age safety**: a vision LLM check that every render clearly shows an adult
- **provenance metadata**: C2PA, XMP and IPTC `DigitalSourceType` markers in
  the returned files, and whether a plain MP4 re-encode drops them

Nothing here is imported by the app. Every file stays under `spike/studio-api/`,
and all outputs go to `spike/studio-api/out/` (git-ignored).

## Setup

```sh
bun install                      # zod is a devDependency
python3 -m venv spike/studio-api/out/venv
spike/studio-api/out/venv/bin/pip install opencv-python-headless numpy
```

Tested with Python 3.14.7, opencv-python-headless 5.0.0.93 and numpy 2.5.3,
which ship cp314/abi3 wheels. If a future Python has no wheels, create the
venv from an older interpreter instead:
`uv venv --python 3.12 spike/studio-api/out/venv && uv pip install --python spike/studio-api/out/venv/bin/python opencv-python-headless numpy`.

`OPENROUTER_API_KEY` comes from the repo-root `.env`, which bun loads
automatically, so **run every command from the repo root**. The key is never
printed. Error output shows only the HTTP status and message, cut to 500
characters.

## Run order

```sh
R="bun run spike/studio-api/run.ts"
$R candidates                          # 4 portrait candidates -> out/avatar/candidate-1..4.*
#   look at them and pick one
$R pack --master spike/studio-api/out/avatar/candidate-2.png   # master + pack-front + pack-body
$R scenes                              # 25 slots + 1 writer call -> out/scenes.json
$R render --config all                 # A..E -> out/render/<config>/<slotId>.*
$R age                                 # adult check -> out/age.jsonl
spike/studio-api/out/venv/bin/python spike/studio-api/face.py   # -> out/face.json
$R meta                                # free: exiftool + MP4 re-encode -> out/meta/
$R report                              # free: out/report.html + markdown summary
```

`render --config` also accepts a single config or a list, e.g. `--config A` or
`--config C,E`; the list is case-insensitive and de-duplicated. `--limit N` is
a canary: only the first N slots of each config are eligible. Rerunning with
the same N never sends more, and raising N extends the run.

| config | model | res | refs | slots |
| --- | --- | --- | --- | --- |
| A | x-ai/grok-imagine-image-quality | 1K | master | all 25 |
| B | x-ai/grok-imagine-image-2.0, quality low | 1K | master | all 25 |
| C | bytedance-seed/seedream-5-0-pro | 1K | master | all 25 |
| D | x-ai/grok-imagine-image-quality | 1K | master, pack-front | slots 1-2 of each category (10) |
| E | x-ai/grok-imagine-image-quality | 2K | master | slot 1 of each category (5) |

All renders use aspect 9:16. When a request carries two references (D), the
prompt refers to "the reference photos". Before a reference image is sent, it is
downscaled to at most 1024 px on its long side as a JPEG. The copy is cached in
`out/refs/`.

## Dry run

Every command takes `--dry-run`. A dry run prints each planned request (job
id, model, resolution, quality, reference count, aspect, the first 100 prompt
characters and the worst-case cost), then the total worst case and whether it
fits under the cap. It makes no network call and writes nothing. It also works
without `OPENROUTER_API_KEY`: the HTTP client stays disabled until a non-dry
paid command turns it on.

`render --dry-run` needs `out/scenes.json`. To preview the prompts without
calling the LLM, build it offline with `scenes --fake-writer`, which fills the
scene fields straight from the slot fields. The file is marked `fake: true`,
and `render` refuses it outside `--dry-run`. Delete it before the real
`scenes` run.

## Money safety

- **Cap**: set it with `--cap <usd>` or `SPIKE_CAP_USD`; the default is `7.00`.
  A request starts only while `ledger spent + in-flight worst cases + this
  request's worst case <= cap`. Once the cap is hit, no new jobs are scheduled.
  The render jobs left over are recorded as `skipped_cap`.
- **Ledger**: `out/ledger.jsonl` is append-only, with one line per billed
  response: `{ jobId, model, costMicros, at }`. Costs are integer
  micro-dollars. When `usage.cost` is missing, the line records the worst case
  with `estimated: true`. A billed response is recorded before its body is
  validated, so a malformed success still counts toward the cap.
- **Worst cases** come from a hardcoded price table in `lib/config.ts`: the
  output price plus refs × the input-image price. Chat calls are capped with
  `max_tokens` so that $0.03 (writer) and $0.005 (age check) are real ceilings.
- **Idempotency**: every job has a deterministic id (`avatar:candidate-1`,
  `A:home-3`, `scenes:writer`, `age:<file>`). A job is skipped without a
  request when its output exists **or** when the ledger already holds a
  billed line for its id. Billed jobs with no output are listed as
  `billed_no_file` for manual recovery and are never bought again. A second
  writer call needs `scenes --force` and gets the id `scenes:writer#2`. Outputs are written to a temp file in
  the same directory, then renamed into place. `scenes` refuses to replace an
  existing `scenes.json` unless you pass `--force`, and refuses even with
  `--force` while `out/render/` holds files. `pack` refuses to replace a
  master that has different bytes.
- **Fatal stop**: the run stops scheduling, finishes what is in flight and
  exits non-zero on any of these: a billed 2xx that cannot be used (body is
  not JSON, fails the schema, or its image cannot be decoded or written), a
  bill above the job's worst case, a local failure, or HTTP 401/402. The
  unusable body is saved to `out/raw/<jobId>.json` (the response body only,
  never headers). Chat bodies (writer, age) are always saved there before they
  are validated.
- **Balance reconcile**: before and after every paid command, the free
  `GET /api/v1/credits` gives the remaining balance. The delta is printed next
  to the ledger delta; OpenRouter usage can lag by a minute.
- **Retries**: only on 429/500/502/503/504, at most 2, with exponential
  backoff plus jitter. `Retry-After` is honoured, but a wait over 120 s counts
  as a failure. 400/401/402/403/422 are never retried and are recorded as
  `refused`, and a 401 or 402 stops the run. Each request has a 180 s timeout;
  a timeout is recorded as `timeout` and is not retried.
- **One paid command at a time**: `out/.run.lock` stops two processes from
  spending against the same ledger at once. The lock is created atomically,
  and the ledger is read only after it is held. A lock left behind by a dead
  process is taken over under a second exclusive file.
- Render and age checks run 4 requests at a time.

## Worst-case cost

| step | worst case |
| --- | --- |
| candidates (4 × $0.05) | $0.20 |
| pack (2 × ($0.05 + $0.01)) | $0.12 |
| scenes writer | ~$0.03 |
| A (25 × $0.06) | $1.50 |
| B (25 × $0.05) | $1.25 |
| C (25 × $0.048) | $1.20 |
| D (10 × $0.07) | $0.70 |
| E (5 × $0.08) | $0.40 |
| age (90 renders × $0.005) | ≤ $0.45 |
| **total** | **≈ $5.85** |

The age step also checks the 7 avatar images, which adds up to $0.035 and
brings the total to ≈ $5.89. Refusals and errors are not billed, so the real
spend is usually lower. The ledger holds the actual figures.

## Outputs (`spike/studio-api/out/`)

| path | content |
| --- | --- |
| `avatar/` | `candidate-1..4`, `master` (a copy of the pick), `pack-front`, `pack-body` |
| `render/<config>/<slotId>.<ext>` | renders; the extension follows the returned bytes |
| `scenes.json` | slots, the writer's output, the assembled prompts, the writer's cost and latency |
| `results.jsonl` | one line per image attempt outcome, with status, HTTP status, cost, latency, pixel size and `promptSha` |
| `ledger.jsonl` | billed responses |
| `raw/` | response bodies: unusable image responses, every writer and age answer |
| `age.jsonl` | `{ file, adult, confidence, reason, costMicros, latencyMs }` |
| `face.json` | per image: `faces`, `headRatio`, `cosMaster`, `cosFront` |
| `meta/` | exiftool JSON for the images and for their 3 s MP4 re-encodes |
| `report.html` | a static report: summary table, avatar strip and a grid per config |
| `refs/`, `models/`, `venv/` | downscaled references, YuNet/SFace ONNX models, the Python venv |

`face.py --image <path>` analyses only the given images and merges them into
`--output`. `face.py --help` lists all options. The models are downloaded once
from opencv_zoo, and each download is checked to be a real ONNX file rather
than a Git LFS pointer. The YuNet score threshold is 0.7 rather than the 0.9
sample default, so three-quarter faces are kept.

## Planner rules

- Each location lists the times of day and the activities it allows, and a
  slot draws both only from those lists. Selfie and mirror slots never get
  two-handed activities, because one hand holds the phone. "studio lighting"
  counts as a time and is passed to the writer unchanged.
- A mirror shot lands only on a mirror location. After the shots are shuffled,
  a misplaced mirror shot swaps with a non-mirror shot that sits on a mirror
  location. If no such slot is left, it becomes a selfie.
- Photoshoot uses its own shot deck: 3 × photographer, 2 × candid.

## Testing note

- `SPIKE_API_BASE` points the client at a local mock server for testing, and
  only `http://127.0.0.1:<port>` or `http://localhost:<port>` are accepted.

## Results (2026-09-24)

These figures come from one real run. `out/` is git-ignored, so this section is
the only durable record of it. Unless noted, every number below was read from
`out/results.jsonl`, `face.json`, `age.jsonl`, `ledger.jsonl`, `scenes.json`
and `meta/`.

### Per config

Every render is 9:16 and uses the same 25-slot plan, the same master
(`candidate-4`) and one prompt per slot. Refusals are not billed, so $/photo is
the billed cost divided by the ok images. Cosine is SFace similarity to the
master's face, measured over ok images; YuNet found a face in every ok image.

| cfg | model | $/photo | ok / refused of n | cos mean / median / min | cos ≥ 0.70 | mean latency |
| --- | --- | --- | --- | --- | --- | --- |
| A | grok-imagine-image-quality, 1K, master | $0.060 | 19 / 6 of 25 | 0.692 / 0.724 / 0.556 | 10 / 19 | 7.3 s |
| B | grok-imagine-image-2.0 low, 1K, master | $0.050 | 20 / 5 of 25 | 0.771 / 0.756 / 0.626 | 14 / 20 | 7.9 s |
| C | seedream-5-0-pro, 1K, master | $0.045 | 24 / 1 of 25 | 0.649 / 0.651 / 0.466 | 6 / 24 | 33.6 s (median 29.1, max 105.5) |
| D | grok-imagine-image-quality, 1K, master + pack-front | $0.070 | 8 / 2 of 10 | 0.721 / 0.708 / 0.608 | 5 / 8 | 7.3 s |
| E | grok-imagine-image-quality, 2K, master | $0.080 | 5 / 0 of 5 | 0.670 / 0.678 / 0.544 | 2 / 5 | 14.6 s |

On the 8 slots that A, B and D all rendered, the mean cosine was A 0.696,
D 0.721 and B 0.795. On the 5 slots that A and E share, it was A 0.729 and
E 0.670. So a second reference adds little, and 2K does not help identity.

### Identity threshold

The three candidates not chosen came from the same text descriptor. Against
the master they score 0.621, 0.648 and 0.658. The SFace same-person threshold
of 0.363 therefore passes every render, and even different people built from
the same description. The working threshold is about **0.70**. For
reference, pack-front scores 0.865 and pack-body 0.724.

### Refusals

Every refusal was a 400 content-moderation block ("xAI blocked this request" /
"Seedream blocked this request"). Grok, given a face reference, refuses
revealing outfits:

- **A**: travel-2 (swimsuit + sarong), glamour-2 (satin slip dress, spice 1),
  glamour-3 (bikini, spice 2), glamour-5 (silk robe over lingerie, spice 3),
  fitness-3 (leggings + sports bra), fitness-4 (matching athletic set)
- **B**: the same as A except fitness-4
- **D** (renders only slots 1–2): travel-2, glamour-2
- **E** (renders only slot 1): none
- **C** (Seedream): only glamour-3 (bikini)

Glamour-1 (mini skirt + cropped top) and glamour-4 (corset top) passed on all
three models.

### Pixel sizes

The returned sizes were:

- 1K 9:16: 720×1280 JPEG
- 2K 9:16: 1584×2816 PNG
- 1K 3:4: 864×1152 JPEG (candidates, master, pack-front)

"1K" is therefore about 0.9 MP, not 1024 px on the long side.

### Age check

83 of 83 images were judged adult: 76 ok renders plus 7 avatar images. The
minimum confidence was 0.85. Each check cost $0.0014 on average ($0.0010–0.0020)
and took about 4.2 s.

### Metadata

Every Grok image (A, B, D, E, master) and every Seedream image (C) carries a
C2PA manifest in JUMBF: action `c2pa.created`, DigitalSourceType
`trainedAlgorithmicMedia`, plus the vendor.

- Grok images name "Grok Imagine" as the software agent and "SpaceXAI" as
  the author.
- Seedream images name "BytePlus_ModelArk" as the agent, with model name
  `dola-seedream-5-0-pro`.

The 3 s ffmpeg MP4 re-encode (`-map_metadata -1`) keeps only
`Encoder=Lavf60.3.100` and `CompressorName=Lavc60.3.100 libx264`.

### Writer

The writer (grok-4.3) made one call: $0.0112, 35.2 s, `finish_reason: stop`.
It has two issues:

- **It ignores that one hand holds the phone.** In 5 of 8 selfie and mirror
  slots the action occupies both hands, for example travel-2 "holding a cup
  of coffee with both hands" and fitness-4 "hands pulling her ponytail
  tighter". The planner's one-handed activity filter does not survive the
  rewrite.
- **It writes fragments rather than sentences**, for example wardrobe
  "oversized cream knit sweater, loose fit". Scenes run 31–51 words (mean
  39.4), against the 40–70 requested.

### Spend

The ledger totals **$4.6290** over 166 billed lines, none of them estimated
and no job id repeated:

| step | spend |
| --- | --- |
| avatar | $0.3200 |
| writer | $0.0112 |
| A | $1.1400 |
| B | $1.0000 |
| C | $1.0800 |
| D | $0.5600 |
| E | $0.4000 |
| age | $0.1178 |

The OpenRouter balance delta printed by each paid command matched the ledger
delta. That comes from the console output of the run and is not stored in
`out/`.

### Decision

- The default is `x-ai/grok-imagine-image-2.0`, quality low, 1K, one
  reference (master). It had the best identity hold (cos mean 0.771, 14 of 20
  ≥ 0.70), the lowest Grok price ($0.050) and about 8 s latency.
- Revealing scenes (swimwear, lingerie, slip dress, sports bra) are refused
  by Grok when a face reference is attached. They go to another provider,
  which is still to be chosen.
