# Image model choice: OpenRouter Image API research (2026-10-05)

Scope: which OpenRouter image models Studio can offer in Settings, how our
request maps onto each, and what each costs. Research only: every call below
was a free, public GET (`/images/models`, `/images/models/<id>/endpoints`,
the docs). No paid request was made.

Sources: `GET https://openrouter.ai/api/v1/images/models` (57 models),
`GET .../images/models/<id>/endpoints` for each of them, and the docs page
"Image Generation" (`/docs/guides/overview/multimodal/image-generation.md`).
Fixtures of the real bodies are saved under `studio/engine/imageModels/fixtures/`
and `studio/engine/money/fixtures/`.

## 1. The request we send today

`studio/engine/openrouter/image.ts`, `POST /images`:

```
{ model, prompt, resolution: "1K", aspect_ratio: "9:16",
  quality?: "low" | "medium",                       // only when the route has one
  input_references?: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,..." } }] }
```

No `n` (the Image API default is one image), no `size`, no `seed`. The master
portrait is the only reference (one entry) for photo runs; avatar candidates
send none.

## 2. What the API exposes per model

`/images/models` lists `supported_parameters` as a typed union across
endpoints (`enum`, `range`, `boolean` descriptors); `/endpoints` gives the
definitive set per provider endpoint plus `pricing` lines. An absent key means
the endpoint does not accept that parameter. Pricing lines have a `unit` of
`image`, `megapixel` or `token`, and an optional `variant` tier (`1k`, `2k`,
`low_1k`, `high_resolution`, ...).

The parameters that matter to us:

| Parameter | Shape | Notes |
| - | - | - |
| `resolution` | enum, e.g. `1K`, `2K`, `4K` | absent on token-priced families (openai, mai, gemini-2.5, recraft, flux.2): they take size from the aspect ratio |
| `aspect_ratio` | enum | `9:16` is listed by every model we considered |
| `quality` | enum | only `x-ai/grok-imagine-image-2.0` (`low`, `medium`) among per-image priced models; `openai/gpt-image-*` have `auto/low/medium/high` but are token priced |
| `n` | range | we never send it |
| `input_references` | range, min 0, max 1..16 | the reference-image slot; `max >= 1` means a reference is accepted |

## 3. Which models work with our request

A model is selectable when ALL of these hold, checked on the definitive
per-endpoint record (every endpoint, not the union):

1. input modalities include `image`, output is image only;
2. `resolution` lists `1K` and `aspect_ratio` lists `9:16`, so the request above
   is valid as sent;
3. `input_references.max >= 1`, so the master portrait is accepted;
4. every pricing line is per **image** (`unit: "image"`) and a billable we
   can bound (`output_image`, `input_image`). That keeps the worst case an
   exact integer in micro-dollars, which the reserve/settle ledger needs.

Result on 2026-10-05, 10 models. Prices are USD per image at 1K; "ref" is the
price of one input (reference) image, charged on top.

| Model | 1K output | ref | Quality knob | Max refs | Notes |
| - | - | - | - | - | - |
| `x-ai/grok-imagine-image-2.0` | low 0.040, medium 0.060 | 0.010 | `low`, `medium` | 3 | today's default; in the 2026-09-24 spike |
| `x-ai/grok-imagine-image-quality` | 0.050 | 0.010 | none | 3 | in the spike price table; no `quality` parameter: it must not be sent |
| `bytedance-seed/seedream-5-0-pro` | 0.045 | 0.003 | none | 14 | today's moderation fallback; in the spike |
| `bytedance-seed/seedream-5-0-flash` | 0.018 | 0 | none | 14 | cheapest; not spiked |
| `bytedance-seed/seedream-4.5` | 0.040 | 0 | none | 14 | not spiked |
| `qwen/qwen-image-3` | 0.030 | 0.003 | none | 4 | not spiked |
| `qwen/qwen-image-3-pro` | 0.040 | 0.003 | none | 4 | not spiked |
| `black-forest-labs/flux-3-image` | 0.048 | 0 | none | 10 | tiers `768`, `1k`, `1.5k`, `2k`, `4k`; not spiked |
| `sourceful/riverflow-v2.5-fast` | 0.019 | 0 | none | 4 | extra `background`, `output_format` parameters (unused); not spiked |
| `sourceful/riverflow-v2.5-pro` | 0.130 | 0 | none | 10 | same; not spiked |

"In the spike" means the model is in the 2026-09-24 price table (the Stage 1
spike). Every model accepts a reference by the API's own description, but
whether the others hold an identity as well is untested; the UI marks the ones
outside that table "не проверена". Only the owner approves a paid comparison.

### Parameter mapping needed

None per family beyond one rule: send `quality` only to a model whose
endpoint lists it (today only grok-imagine-image-2.0). Everything else in the
request is accepted as is by all ten models: `resolution: "1K"`,
`aspect_ratio: "9:16"`, `input_references` with a JPEG data URL, no `n`.

Today `runRoute` sends `quality: "low"` to any model that is not Seedream.
With a catalogue that is wrong for `grok-imagine-image-quality`, `flux`,
`qwen` and the rest (no such parameter), so the chosen quality is stored as
`null` for a model without the knob and the route sends nothing.

One pricing detail: the tiers `768` and `1.5k` (flux) were not recognised by
`imageOutputMicros`, which then priced the model at its dearest tier ($0.607,
the 4K one). They are recognised now, so flux is priced at its 1K tier.

## 4. Excluded, and why

| Models | Reason |
| - | - |
| `openai/gpt-image-*`, `openai/gpt-5*-image*`, `microsoft/mai-image-*`, `google/gemini-*-image*`, `inclusionai/*` | priced per **token** (`unit: "token"`). The cost of one image depends on the prompt and the output size, so there is no exact per-image worst case for the ledger. No `resolution` parameter either. A follow-up could bound them by a measured token ceiling; not done here |
| `black-forest-labs/flux.2-*` | priced per **megapixel**, no `resolution` parameter |
| `krea/krea-2-*`, `meta/muse-image` | no pricing lines in the endpoints record (price unknown): never selectable; reference max is 1 and meant as a style reference |
| `recraft/*` | no `resolution` parameter; the reference slot is a style reference, not an identity one; `input_reference` is a per-request fee for the styles variants |
| `sourceful/riverflow-v2-*` | bills `input_reference` and `input_font` lines, which the price parser refuses by design (an unbounded line is not a worst case) |
| `bytedance-seed/seedream-5-0-lite` | `resolution` is `2K`, `4K` only: no 1K |

## 5. Decisions that follow

- The catalogue is built from `/images/models` (names, structural pre-filter)
  and `/endpoints` (definitive parameters and prices), filtered by section 3,
  cached in memory, and refreshed after 30 minutes (1 minute while it is a
  fallback). A model whose endpoints record cannot be fetched or parsed is not
  listed, which is the answer to "a model whose price cannot be fetched is not
  selectable".
- The bundled fallback list (used when the model list itself cannot be fetched)
  is exactly the models of the dated price table (`FALLBACK_IMAGE` in
  `money/prices.ts`: grok-imagine-image-2.0, grok-imagine-image-quality,
  seedream-5-0-pro). It uses those dated prices, so a run on any of them
  still has a price when the endpoints GET fails. A model outside that table
  is never priced from a made-up number: with no live price a run on it is
  refused with PRICE_UNAVAILABLE before anything is sent, as today.
- Quality is stored as `low` | `medium` | `null`. `null` means the model has no
  quality knob. Existing settings files get `low`, so today's behaviour with
  the default model is unchanged.
- Estimates and the run cap already price every attempt from the route's
  `{ model, quality, refs }` through the price book, so choosing a model and a
  quality changes "Ожидаемая" and the cap with no further money code.
- The moderation fallback stays Seedream 5.0 Pro (`quality: null`).
