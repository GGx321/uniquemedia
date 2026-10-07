# Studio — custom categories, custom scenes and scene review before paying

Status: r2 (2026-10-05). **CS.1 is built** (see "CS.1 as built" under the task list);
everything else is still to do. Base: `main` 3a9cd498.
r2: revised after a fresh-context critic review (opus) — writer phase parametrised (not reused
unmodified), pool text length bounds for the writer's ceiling, per-set mutex and a pre-issued run id
against double approval, gave-up chunks no longer block later ones, phase-2 plan fields moved out of
phase 1, category commands serialised, missed category consumers added.

The owner asked (2026-10-05), in Russian: what is the difference between a scene and a category (can one
category hold several scenes?), and could Studio generate his own categories, and scenes too, from a
prompt. The dead «Сцены на проверку» switch on the generate card (being removed on
`feat/studio-min-clip-100ms`) was meant to let him review the scenes before the images are paid for.

This plan has three parts, delivered in two phases:

1. **Custom categories by prompt** — phase 1.
2. **Custom scenes by prompt** — phase 2.
3. **Scene review before paying for images** (the switch, working) — phase 2.

---

## 1. Category vs scene (the answer to the question)

- A **category** is a theme with a *pool*: 5–7 places (each with the times of day it fits and 2–3
  things she can do there), 3–5 outfits, and a *shot deck* (who takes the photo: friend, selfie,
  mirror, candid, photographer). There are five fixed ones today.
- A **scene** is one photo's recipe, drawn from one category's pool: one place + time + activity +
  outfit + shot + pose. The writer model turns it into one English sentence; the assembler turns the
  sentence into one image prompt; one image call makes one photo.
- So yes: one category gives many scenes. A run of 20 photos over 5 categories is 4 scenes per
  category, all different (the planner draws without repeats until a pool runs out).

---

## 2. How it works today (facts, with file references)

### Categories

- Contract: `SceneCategory = z.enum(["home", "travel", "shoot", "glam", "fit"])` —
  `studio/shared/engine/state.ts:672`. Used by `RunRequest.categories` (`state.ts:682-687`, 1..5,
  unique) and by `PhotoSummary.category` (`state.ts:753`).
- Engine names differ: `CATEGORIES = ["home", "travel", "photoshoot", "glamour", "fitness"]`
  (`studio/engine/scenes/types.ts:8`); the two are mapped in `studio/engine/runs/plan.ts:54-77`
  (`sceneCategory` / `contractCategory`).
- Russian labels: `CATEGORY_LABEL` in `studio/renderer/screens/photos/runForm.ts:33`; the renderer
  mirrors the planner's split in `photosPerCategory` (`runForm.ts:46`).
- The generate card renders the five chips from `SceneCategory.options`
  (`studio/renderer/screens/photos/GenerateCard.tsx:306-333`) plus a one-line glamour note (`:332`).

### Pools and their rules

- `studio/engine/scenes/pools.ts`: `Activity {text, twoHanded}`, `Place {name, times, activities,
  mirror?}`, `Pool {locations, outfits, shotDeck}` (`:25-51`); the default deck (2 friend, selfie,
  mirror, candid) and the photoshoot deck (3 photographer, 2 candid) (`:54-56`); `POOLS` (`:64-249`).
- Validated by zod at import (`validatePools()`, `:314-323`): `PoolSchema` (`:300-309`) — at least
  one location and outfit; every location has a one-handed activity (`:281-291`); a deck with
  `mirror` needs a mirror location; outfits are plain ASCII, carry no `REVEALING_WORDS`
  (`studio/engine/scenes/words.ts:9`) and no youth words; place names and activities carry no youth
  words (`PromptText`, `:275`, via `youthWords(text, "descriptor")`).
- These are the Stage 2 rules as built ("Revealing outfits" decision,
  `docs/studio/2026-09-24-stage-2-plan.md:27`: Grok refuses revealing outfits with a face reference).

### Planner → writer → assembler

- **Planner** (`studio/engine/scenes/planner.ts`): `plan({seed, count, categories, excludePairs,
  poses})` (`:24-41`, `:251`). Categories in canonical order, `count` split evenly with the
  remainder to the earliest (`distribute`, `:58`). Each category draws on its own rng sub-stream
  (`categorySeed(seed, category)`, `:111`; pose on `poseSeed`, `:124`), so editing one pool never
  changes another category's draws. Locations, outfits and shots come from bags (no repeat until
  exhausted); mirror shots only on mirror places (`placeMirrorShots`, `:136`); two-handed activities
  never on selfie/mirror; the avatar's recent (location, outfit) pairs are avoided
  (`Library.recentPairs`, `RECENT_PAIRS = 40`, `studio/engine/engine.ts:281`). The run's seed is
  derived from its id (`seedOf`, `engine.ts:284`).
- **Slot schema**: `PlanSlotSchema` (`studio/engine/scenes/schema.ts:58-74`): slotIndex, category,
  location, timeOfDay, activity, outfit, shot, pose, `attemptIdBase` (`slot-N`), `repeatedPair`;
  selfie/mirror must be front or three-quarter. `ScenePlanSchema` version 1 (`:80`).
- **Writer** (`studio/engine/scenes/writer.ts`): a paid chat call per chunk of 25 slots
  (`chunkSlots`, `:39`), strict JSON `{scenes:[{slotIndex, sentence}]}`. System prompt `:111-129`;
  slot shown as category label (`CATEGORY_LABEL`, `:84`), location, time, shot, pose, outfit,
  activity (`:131`). `readWriterAnswer` (`:335`) refuses: not JSON, empty, missing/unknown/duplicate
  slots, a two-handed action in a selfie/mirror, youth words, revealing words, a sentence that
  contradicts a back/profile pose. Re-asks feed back fixed reasons only, never the model's rejected
  text (`:157-200`).
- **Writer money**: `WRITER_CALL` (`studio/engine/money/estimate.ts:96-104`): grok-4.3, 14K input /
  8K output ceiling (≈ $0.0375 per call at the fallback prices), 25 slots per call, 2 answered
  attempts per chunk; `writerWorstMicros` (`:176`) = chunks × 2 × ceiling.
- **Writer phase** (`studio/engine/runs/writerPhase.ts:160`): chunk by chunk, starts each chunk at
  its first id the ledger does not hold, journals every accepted chunk before the next
  (`onChunk`), stops (resumable) on an unanswered attempt, ends the chunk "exhausted" after 2
  rejected answers or a moderation refusal — and the **first** chunk that cannot be written ends
  the whole phase (`:171`). Its call shape is hard-wired: `writerMessages`, `WRITER_JSON_SCHEMA`,
  `WRITER_CALL.maxTokens/inputTokens` (`:97-100`) and `WRITER_CALL.maxAttempts` (`:124`, `:150`).
- **Writer prompt floor**: the reserve of an attempt is never below the prompt's own floor
  (`promptTokenFloor`, bytes, `studio/engine/openrouter/chat.ts:77`). A full 25-slot chunk of the
  built-in pools with the worst refusal measures ≈ 11.1K against the 14K ceiling; the longest
  built-in pool text is 44 chars. Longer pool texts push the floor over the ceiling (critic's
  measurement: 120-char texts → ≈ 18.2K, a reserve of ≈ $0.0427 against an estimated $0.0375).
- **Assembler** (`studio/engine/scenes/assembler.ts:140`): pure; binding anchor + descriptor
  (`promptSubject`) + shot phrase + pose phrase + the sentence + realism suffix (editorial for
  photoshoot, phone otherwise, `:147`) + constraints. It re-checks the sentence for youth and
  revealing words and throws `AssemblerRefusalError` (`:141-144`) — the last gate before money.

### Runs and money

- `runs.estimate` / `runs.start` / `runs.cancel` / `runs.estimateResume` / `runs.resume` /
  `runs.list` — `studio/shared/engine/commands.ts:304-322`; handlers `engine.ts:1355-1410`.
- `#startRun` (`engine.ts:1837-1895`): key, ledger, library, runnable avatar, master, gates,
  prices → `runEstimate` → `PRICE_CHANGED` check → monthly room → free master preflight → plan
  (with recent pairs) → `buildRunPlan` → `runs/<runId>/plan.json` (`Library.createRun`) → job.
- `runEstimate` (`studio/engine/runs/plan.ts:111`): expected = count × image + writer typical;
  worst (= the run's **cap for its whole life**) = count × 3 attempts × dearest model of the route
  (+ age checks when on) + writer worst. 20 photos: ≈ $1.01 expected, $3.075 worst.
- `RunPlanSchema` (`plan.ts:169-204`): pre-allocated attempt ids per slot (3 paid + 2 spare) and per
  writer chunk (`${runId}:writer-${chunk}#N`); refines: slot count = request count, writer chunks
  cover every slot once, ids never repeat, cap ≤ planned worst.
- Journal (`studio/engine/runs/journal.ts:48-83`, append-only): `job`, `writer` (a chunk's
  sentences), `prompts` (all prompts, written before the first image), `attempt`, `slot`.
  `foldRun` (`:151`) rebuilds state from plan + journal + ledger + committed photos.
- `runJob.ts` (`studio/engine/runs/runJob.ts:21-56` header): master → gate prep → `promptsOf`
  (`:389`: writer phase, then the assembler over today's descriptor, prompts journaled) → slots in
  parallel through the network pool. History append per photo (`:715`); the sidecar's category is
  the contract name (`:642`).
- `remaining.ts:64` prices a resume (unwritten writer chunks + open slots, never above the cap).
- One-off paid text jobs follow the descriptor pattern: estimate command (free) → paid command with
  `acceptedWorstMicros` → scope `{ avatarJobId: jobId }` with its own cap → up to 2 attempts with
  fixed feedback (`studio/engine/avatars/descriptorJob.ts:58`, `engine.ts:2306` `#rewriteDescriptor`);
  synchronous, with a deadline in `studio/engine/control.ts:260-279`.

### Library and photos

- Runs live at `<library>/runs/<runId>/{plan.json, journal.jsonl}`; montage drafts per avatar at
  `avatars/<id>/montages/<montageId>.json` (atomic rewrite); own media library-wide at `media/`
  (`studio/engine/library/layout.ts`). The survey (`library/survey.ts:178-236`) only walks known
  folders and ignores unknown ones.
- `Library.createRun` (`library/library.ts:1048-1060`) writes the run folder under
  `runExclusive("run:<dir>")` and refuses an existing one (`run-exists`).
- Other category consumers in the renderer: the montage photo bin's facets
  (`studio/renderer/screens/montage/bin.ts:5` local `PhotoCategory` type, `:65-69` built from
  `SceneCategory.options`) and its labels (`montage/PhotoBin.tsx:110`); the gallery
  (`photos/Gallery.tsx:45`) and the viewer (`photos/PhotoViewer.tsx:91`); the sidebar job counts
  (`renderer/engine/renderJobs.ts:86`).
- A photo sidecar stores `source.category` as a free non-empty string
  (`library/schemas.ts:63-74`, `z.object`). `photoSummaryFrom` (`library/photoRecords.ts`) parses it
  into `PhotoSummary`, so **an unknown category today makes the photo vanish from the gallery**
  (counted in `skippedTotal`).

### UI and design

- `ScenesColumn.tsx:282-287` says it outright: "the contract has no scene plan to show before or
  while a run draws". «Пересоставить» is disabled (`:344`); the scene list is a «скоро» placeholder
  (`:392`). The switch was `GenerateCard.tsx:402-412` (being removed now).
- The mockup (`.omc/stage3/design/canvas/Photos.dc.html`) already draws the target: the «Сцены»
  column with numbered scene cards (category tag, shot tag, English text, status, «Изменить» and
  «Перегенерировать» icon buttons), «Пересоставить» in the header, a price row «Сцены ≈ $…», and the
  «Сцены на проверку» switch with **review ON by default** (`review: s.review === undefined ? true`).
- Stage 2 recorded the gap: T8b decisions (`docs/studio/2026-09-24-stage-2-plan.md:515`) and the
  Stage 2 backlog ("a scene preview before paying").

### Owner rules that bind this plan

- Personal-use app; no self-built content gates (memory: no-self-built-content-guards). Existing
  Stage 2 rules stay **as built** and are **reused, not extended**: the pool schema, the writer's
  answer rules, the assembler's last re-check. Owner text goes to the providers, which apply their
  own policies. No new filter, no new paid safety call, no attestation step.
- Paid real-API canaries need his explicit approval each time.

---

## 3. Key decisions (with the alternatives)

### D1. Where scene review lives — a **scene set** document, not a paused run

| Option | Pros | Cons |
|---|---|---|
| **R2 (chosen): a separate, persisted "scene set"** per avatar (planned scenes + their texts), edited freely, then turned into a normal run on approval | The run state machine (plan, journal, fold, remaining, resume — the most-reviewed money code) changes only at two named points: the writer phase is parametrised (call shape, messages) so a scene set can drive it, and a plan may carry pre-written sentences with no writer chunks (all-or-nothing). `remaining.ts` needs no change. Adding and removing scenes is a plain document edit. The run's cap is fixed once, at approval, for exactly the approved scenes — "the cap is never raised" stays true. Restart-safe by construction (a file on disk). | A new job kind and a new set of commands; two price acceptances (scenes, then photos) — which is the point. |
| R1: review inside the run (a new run state "awaiting approval", edits as journal events) | One object; the writer's spend sits in the run's own cap | `plan.json` is immutable (invariant 6), so **adding** a scene needs plan mutation or pre-allocated spare slots; the cap fixed at start cannot fund added scenes without raising it; removed slots need a new end status that `runs.list`, `remaining.ts` and the resume math must learn. Edits in 6+ money files — the architecture resisting. |
| R0: review only in the renderer | Small | Lost on restart; the paid writer output must be persisted anyway. Invalid. |

### D2. Custom categories are **per library**, shared by all avatars

Pools describe places and outfits, not a person, and all avatars are adult women; one «Кофейни
Парижа» serves every avatar. Stored at `<library>/categories/<categoryId>.json` (like `media/`).
Per-avatar would make the owner recreate (and pay for) the same category per avatar.

### D3. A category is referenced by a **prefixed id** next to the five built-ins

`CategoryRef = SceneCategory | CustomCategoryId` (`cat-<id>`). Every existing `plan.json`,
request and sidecar stays valid as is (the five strings keep their meaning). An object form
(`{kind, id}`) would break today's `plan.json` files.

### D4. Invalid generated pool → **salvage, then retry with feedback**

The pool call returns JSON in the built-in shape. If some items break `PoolSchema` (say one outfit
carries a revealing word), drop those items when what is left still meets the minimums (no paid
retry needed). Otherwise ask once more with fixed reasons (zod paths and our own messages, plus the
offending words — ours to name — never the model's other text), like the descriptor job. Two
rejected answers → `POOL_REJECTED` (new code, Russian: «Модель дважды вернула неподходящий набор —
переформулируйте описание»).

### D5. Custom scenes: an **idea through the writer** (paid) or **text as is** (free)

- «По описанию»: the owner writes an idea in any language (≤ 500 chars) and a count 1..5; the writer
  realises it as English sentences under its usual rules (one hand holds the phone in a selfie,
  match the pose, …). Cheap (≈ $0.002 typical).
- «Как есть»: the owner's own English sentence goes straight to the assembler (free).
- Editing any scene's text is free and verbatim (straight to the assembler).

### D6. Review-time writer calls run as a background **"scenes" job**, each with its own price

Composing 100 scenes is 4 chunks in sequence — too long for a synchronous command — and rewrites
should be cancellable and survive a window close. All writer work (compose, continue, rewrite, idea)
is one job kind with progress and cancel. Each paid action shows its own worst case and is accepted
by a click, like every paid action in the app.

All writer work in v1 uses the **existing `WRITER_CALL` shape** (14K in / 8K out, 2 attempts —
already measured and pinned), and a review-time write targets **at most 5 scenes**. Trade-off: a
single-scene rewrite shows «≈ $0.002 · до $0.08» — the cap of a whole chunk for a tiny action. A
smaller shape was considered and dropped for v1: its output ceiling cannot be pinned without real
calls (grok's reasoning tokens count as output; too low a ceiling truncates the JSON and wastes a
paid attempt). Revisit after the canary has measured real token use (follow-up).

### D7. The pool generation call is **synchronous**, like the descriptor

One chat call, ≤ 2 attempts, bounded by a deadline in `control.ts` built the same way as
`avatars.rewriteDescriptor`'s. No job kind needed.

---

## 4. Design

### 4.1 Custom categories

**Create.** In the generate card, after the five chips, a «+ Своя» chip opens a dialog: name
(1..40 chars, any script, UI only), description (1..500 chars, any script), the price
(«≈ $0.006 · до $0.05», from `categories.estimate`), «Создать». The engine:

1. Serialised: one category write at a time (a flag like `#importing`, `IN_FLIGHT` for a second
   `create`/`regenerate`), counted in `#paidCommands` so a library switch is refused meanwhile; the
   limit check happens under that flag. Then checks like `#rewriteDescriptor`: usable key, ledger,
   library, accepted worst (`PRICE_CHANGED`), monthly room, the category limit (50 per library,
   `VALIDATION`).
2. Scope `{ avatarJobId: jobId }` — the ledger's existing shape, so the ledger format does not change
   (a new scope variant would make an older build fail to read the ledger). Cap = the accepted worst.
3. Pool call (`POOL_CALL` on the settings' text model, `reasoningEffort: "low"`, strict JSON schema
   mirroring `PoolSchema`): system prompt with the rules of the built-in pools and one built-in pool
   as an example of shape; user message = name + description. It returns:
   - `label` — 1..4 English words, ≤ 24 chars (what the writer is told the category is);
   - `locations` — 5..7, each with 1..3 `times` from the built-in vocabulary (morning, midday,
     golden hour, evening, night, studio lighting), 2..4 activities with `twoHanded`, `mirror`;
   - `outfits` — 3..6; `shotDeck` — exactly 5 shots.
4. Validation = `PoolSchema` **as built** + technical bounds: every text that feeds a prompt is a
   `PoolText` (shared contract: printable ASCII, **no `"` and no `\`**, no edge space, **≤ 35 chars** =
   `POOL_TEXT_MAX`; a quote or a backslash costs two bytes once the slots go out as JSON, and the
   reserve is priced on bytes) so a full 25-slot writer chunk of a custom pool stays at least 200
   tokens under `WRITER_CALL`'s 14K input ceiling with the worst refusal (pinned by a test, 241
   tokens of margin as built); `times` are `TimeOfDay` (same rule, ≤ 15 chars); the counts above.
   `label` is a `CategoryLabel` (same rule, ≤ 24 chars). The pool call's JSON schema and
   `readPoolAnswer` must apply these exact schemas (reuse `PoolText`, `TimeOfDay`, `CategoryLabel`;
   do not re-declare them), and the salvage rule drops an item that fails them. Hand mechanics: `twoHanded ||= isTwoHanded(text)`
   (`writer.ts:263`), so an activity the model mislabels («with both hands») never lands on a
   selfie and burns both writer attempts — the phone-in-hand rule as built, not a content gate.
   Salvage, then retry (D4).
5. Style: **editorial** when the deck holds ≥ 3 `photographer` (as the built-in photoshoot),
   otherwise **phone** — a derived rule, no extra field for the model to get wrong.
6. Writes `<library>/categories/<categoryId>.json` atomically (temp + fsync + rename),
   `schemaVersion: 1`; emits `category.changed`; answers the category. If the write fails, the paid
   pool is kept in `raw/` and the error names where (as `#rewriteDescriptor` does,
   `engine.ts:2346-2355`).

**Manage.** A «Мои категории» sheet (from the chips row): per category the name, description and the
pool read-only (places with times/activities, outfits, shot mix as the mockup's shot legend), and:
- rename (free);
- remove a place or an outfit (free; refused below the minimums);
  (free changes of a category whose regeneration is in flight answer `IN_FLIGHT`);
- «Пересоздать» with an edited description (paid, same call; same id, new pool);
- delete (free, with a confirm). Photos keep their label (the sidecar carries a snapshot of the name,
  below); a plan already written is self-contained (below).

**Use.** The chips row shows built-ins first (canonical order), then custom categories (creation
order). Runs accept them with review on or off. One shared pure function in `studio/shared/engine`
(`orderCategories` + `splitCount`) replaces the planner's `distribute` order rule and the renderer's
mirror (`runForm.ts:46`), so the per-chip counts can never drift from the engine's split.

**Planner.** `planWithPools` takes pools by ref. A custom category draws on
`subSeed(seed, "<categoryId>")`, so **every built-in plan for a given seed stays byte-identical**
(pinned against fixtures taken from today's `main`). Slots of a custom category carry its ref.

**Self-contained plans.** A `plan.json` (and a scene set) stores a snapshot of every custom
category it uses: `{ref, name, label, style}`. A resume or a writer chunk never reads the category
library, so renaming, regenerating or deleting a category never changes a run in flight.

**Writer and assembler.** Built-in slots: byte-identical messages and prompts (existing pins). Custom
slots: the writer sees the snapshot's English `label` as the category; the assembler picks the
realism suffix from the snapshot's `style`.

**The writer phase is parametrised (phase 1).** `runWriterPhase` takes its call shape
(`{maxTokens, inputTokens, maxAttempts}`) and a `messages(slots, feedback)` builder from the caller
instead of hard-wiring `WRITER_CALL` and `writerMessages` (`writerPhase.ts:97-100, :124, :150`); a run
passes exactly today's values plus a label resolver built from the plan's snapshot, so a custom
label reaches `slotForWriter` (`writer.ts:131-134`). Pinned: every request body of a built-in run is
byte-identical to today's. Phase 2 reuses the same function for scene sets (compose, rewrite, idea).

**Photos.** `PhotoSummary.category` widens to `PhotoCategory = SceneCategory | CustomCategoryId |
"own"` plus `categoryName?: string` (present for custom and own). The sidecar gains an optional
`categoryName` written at commit from the plan's snapshot (the sidecar schema is a non-strict
`z.object`, so older builds strip it; `SIDECAR_SCHEMA_VERSION` stays 1). Gallery and viewer show
`categoryName ?? CATEGORY_LABEL[category]`. The montage photo bin builds its facets from the
categories its photos actually carry (built-ins first, then custom and own by label) instead of
`SceneCategory.options` (`montage/bin.ts:65-69`, `PhotoBin.tsx:110`); its local `PhotoCategory`
type (`bin.ts:5`) is renamed so it no longer shadows the new contract type.

### 4.2 Scene sets and review

**The switch.** «Сцены на проверку» on the generate card, real now. Default **ON** (the mockup's
default), remembered per machine in the renderer's local storage (a per-viewer convenience, read and
written inside try/catch). OFF = today's path, unchanged (`runs.start`, writer inside the run).

**Lifecycle of a scene set** (`avatars/<avatarId>/scenes/<sceneSetId>.json`, atomic rewrite,
`schemaVersion: 1`, a `revision` that grows on every change; at most **one open set per avatar**):

```
compose ──► writing ──(job done)──► ready ──(runs.startFromScenes)──► used (read-only, names its run)
               │  ▲                   │  ▲
   cancel /    │  │ scenes.write      │  │ scenes.write (rewrite / idea) — a job, back to ready
   crash       ▼  │ {unwritten}       ▼  │
             stopped                 (free edits: text, remove, restore, add own text)
any state but used, with no job running ──(discard)──► deleted
```

- `stopped` is derived: status `writing` with no live job (a cancel, a crash, an engine restart).
- **The set's run id is issued at compose** and stored in the set file. `used` ⇔ the folder
  `runs/<thatRunId>/` exists. `Library.createRun` already refuses an existing run folder under its
  own lock (`run-exists`), so a set can never become two runs, whatever crashes or races — no scan
  of other runs' `plan.json` (an unreadable plan cannot hide a use), no two-phase write.
- **One mutex per set** (`runExclusive("scenes:<sceneSetId>")`): every mutation of the file — free
  edits, discard, a job's `onChunk`/write record, and the final step of an approval — runs under
  it, and every free edit carries the `revision` it was made on (`SCENES_CHANGED` when it moved), so
  two edits can never lose one another.

**Compose.** With the switch ON the card's button reads «Составить N сцен · до $X» (X = writer worst
for N, e.g. 20 → $0.075) with a faint line «весь запуск ≈ $1.01 · до $3.08» (today's `runs.estimate`).
`scenes.compose` runs the same checks as `runs.start` minus the image-side ones (no master
preflight, no gates — nothing visual is paid yet), plans with the same planner (seed from the set id,
recent pairs avoided), pre-allocates writer chunk ids `${sceneSetId}:writer-${chunk}#N` **in the
file before the first call**, and launches a `scenes` job. The job drives the parametrised
`runWriterPhase` **one pending chunk at a time**: an accepted chunk is written into the set (under
the set's mutex) before the next is asked; a chunk that gave up (two rejected answers, or a
moderation refusal) is marked `gave-up` and the job **goes on with the next chunk** (the run's own
writer phase stops the whole phase at the first one, `writerPhase.ts:171`; a set must not let one
bad chunk block the others forever); an unanswered attempt (429, 5xx, network) stops the job,
resumable. Count 0 is allowed and free: an empty set for own scenes only.

**Review** (the «Сцены» column, the mockup's cards):

| Action | Cost | Effect |
|---|---|---|
| Edit text (pencil) | free | verbatim; checked at once by the assembler's own rule (below) |
| Remove / restore | free | removed scenes are kept greyed until approval, so a mis-click is undone |
| «Другая сцена» (⟳) on a planned scene | paid (`scenes.write` rewrite, `redraw: true`, 1..5 scenes) | a fresh place/outfit/activity from the same category + a new sentence (below) |
| ⟳ on an own scene | paid (rewrite) | a new sentence for the same idea |
| «+ Своя сцена» → «По описанию» | paid (`scenes.write` idea, count 1..5, shot or auto) | k own scenes written from the idea |
| «+ Своя сцена» → «Как есть» | free | one own scene: the owner's English text, shot (default «Подруга снимает»), pose (default «Анфас»; selfie/mirror allow only front/three-quarter) |
| «Пересоставить» | discard (free) + compose (paid) | asks first, naming what the open set already cost |
| Continue a stopped set | paid (`scenes.write` unwritten) | writes only the chunks not in the file, from their next unused ids |

A chunk whose answers were rejected twice leaves its scenes «не составлена»: the owner can remove,
rewrite or type them.

**Redraw, precisely.** The new place/outfit/activity/time/pose is drawn deterministically from (set
seed, scene id, write number `k`) out of the category's **current** pool, avoiding places and
outfits already in the set where it can, and stored in the write record **before** the call (a
crash-resume of the same write draws nothing new). The scene shows the new place only together with
its accepted sentence; a write that fails leaves the scene exactly as it was. A redraw refreshes
the set's snapshot (`label`, `style`) of that category; scenes written earlier keep their text. A
deleted category → redraw refused free (`NOT_FOUND`); a plain rewrite still works.

**Edit-time check (not a new rule).** `assembleSlot` already refuses a sentence with a youth or a
revealing word and fails the whole run with `INTERNAL`. The check moves into one exported function
(`sentenceProblems`) that the assembler keeps calling, and `scenes.edit` calls it too, so the owner
sees «слово "bikini" не пройдёт в промт» at once, for free, instead of a failed run. Plus technical
bounds: 1..600 chars, one line, no control chars. A Cyrillic text is accepted (verbatim is his call)
with a hint offering «По описанию» to have it written in English.

**Approve.** With a ready set, the main button reads «Отрисовать M фото · до $Y», M = active scenes
with text, priced by `runs.estimateFromScenes {sceneSetId, revision}` — `estimateRun` with M photos
and **no writer term** (all texts exist); re-asked on every `scenes.changed`. Removing a scene lowers
Y at once; adding raises it. `runs.startFromScenes {sceneSetId, revision, acceptedWorstMicros}`:

1. Free refusals first: `SCENES_CHANGED` (new code) when the revision moved (another window
   edited); `VALIDATION` when an active scene has no text, or none / more than 100 are active;
   `IN_FLIGHT` while a scenes job runs; refused when the set is already used.
2. Then exactly `#startRun`'s checks (key, ledger, master, gates, age-check mode captured, prices,
   `PRICE_CHANGED`, monthly room, free master preflight) — these await for up to
   price fetch + 2 × `REFERENCE_TIMEOUT_MS`, without holding the set's mutex.
3. **Last step, under the set's mutex:** re-read the set and compare its revision again (an edit or
   a discard that landed during step 2 → `SCENES_CHANGED` / `NOT_FOUND`, nothing written), then
   `createRun` under the set's pre-issued run id. Edits arriving after this point see the set used
   and are refused, so nothing the owner sees can differ from what is drawn.
4. `plan.json` from the active scenes in order: slots `slot-1..slot-M`, each with its pre-written
   `sentence`; `writerChunks: []`; `sceneSetId`; the category snapshot; **cap = the accepted
   images-only worst**, fixed for the run's life. Plan invariant: `sceneSetId` present ⇔ every slot
   has a sentence ⇔ `writerChunks` is empty — never a mixed plan.
5. The run is a normal run from here: `promptsOf` assembles from the plan's sentences (the
   assembler's re-check still runs), journals the prompts before the first image; cancel, resume,
   `runs.list` and `remaining.ts` work unchanged (no writer chunks to price).

**Own scenes in a run.** A slot with `kind: "own"`: no location/time/activity/outfit, category
`"own"` («Своя сцена»), a shot and pose (so the shot phrase, the pose phrase and the pose-aware
face gate work as for any slot), no history append (there is no (location, outfit) pair).

**Money summary for a reviewed 20-photo run (fallback prices):** compose ≈ $0.009, cap $0.075; then
images ≈ $1.00, cap $3.00 for 20 (≈ $0.90 / $2.70 for 18 after two removals). Total worst equals
today's $3.075 when nothing is added; the owner accepts each part separately. Each ⟳ or «По
описанию» during review: ≈ $0.002, cap $0.075 (one writer chunk, two attempts).

### 4.3 Concurrency, restart, cancel

- One paid job per avatar at a time (`#claimAvatar`): a compose/write job blocks a run start and
  vice versa; free edits are refused (`IN_FLIGHT`) only for the set whose job runs.
- Every mutation of a set file goes through the set's mutex with a revision check (4.2).
- A scenes job counts in `#paidCommands`: a library switch is refused while it runs.
- In the sidebar's job counts a scenes job counts with the photo-side jobs (`renderJobs.ts:86`).
- Cancel (`scenes.cancel`): aborts the call in flight (its reserve stays at worst until reconciled,
  as today); chunks already written stay; the set reads `stopped`.
- Engine crash mid-compose: open reserve → the existing reconcile flow; on restart the set reads
  `stopped`; «Дописать» passes only the pending chunks and uses their next unused ids (the ledger
  is never asked to resend an id); gave-up chunks are not retried (the owner rewrites those scenes).
- Restart during review: nothing is in flight; the set is on disk; the Photos screen reads it with
  `scenes.get` on mount.
- Edits after approval: refused (the set is `used`). Discard during a job: refused (cancel first).
- Avatar deletion (`feat/studio-delete-avatar`, in flight): the avatar's `scenes/` folder goes to the
  Trash with it; deletion is refused while a scenes job runs (same as a run).

### 4.4 Content rules — what applies, and nothing more

| Text | Goes to | Rules (all existing, as built) |
|---|---|---|
| Category name | the UI only | length 1..40 (technical) |
| Category description | the pool call only | length 1..500 (technical); the provider decides |
| Generated pool | every planned prompt | `PoolSchema` as built + ASCII/length/count bounds (technical) |
| Writer sentences (compose, rewrite, idea) | the prompt | `readWriterAnswer` as built |
| Scene idea | the writer call only | length 1..500 (technical); the provider decides |
| Owner's edited / own text | the prompt | the assembler's existing re-check, shown at edit time; length/one line (technical) |

A provider moderation refusal of the owner's own text is `MODERATION_REFUSED` (existing code, free).
A beach category will still have no swimwear: that is the Stage 2 "Revealing outfits" decision,
unchanged here. The avatar's vibe never reaches any of the new calls (canary test below).

---

## 5. Contract additions (protocol v5 stays open: additive, Studio unreleased)

New file `studio/shared/engine/categories.ts` and `scenes.ts`; exported from `index.ts`.

**Types.** `CustomCategoryId` (`^cat-[a-z0-9-]{8,59}$`); `CategoryRef = SceneCategory |
CustomCategoryId`; `PhotoCategory = CategoryRef | "own"`; `CategorySummary {categoryId, name,
description, label, style, pool {locations, outfits, shotDeck}, model, createdAt, updatedAt}`;
`SceneSetView {sceneSetId, avatarId, createdAt, revision, status, runId|null (named once used), poses, spentMicros,
scenes ≤ 200}`; `SceneView {sceneId, origin: planned|own, category: PhotoCategory,
categoryName|null, shot, pose, place {location, timeOfDay, activity, outfit}|null, idea|null,
text|null, edited, removed, unwritten: pending|gave-up|null}`. `RunRequest.categories` widens to
`CategoryRef[]` (1..20, unique). `PhotoSummary.category` → `PhotoCategory` + `categoryName?`.

**Commands.**

| Command | Payload → result | Paid |
|---|---|---|
| `categories.list` | `{}` → `{categories ≤ 50, unreadable: Count}` | free |
| `categories.estimate` | `{}` → `Estimate` | free |
| `categories.create` | `{name, description, acceptedWorstMicros}` → `{category}` | yes, sync |
| `categories.regenerate` | `{categoryId, description, acceptedWorstMicros}` → `{category}` | yes, sync |
| `categories.update` | `{categoryId, name?, removeLocations?, removeOutfits?}` → `{category}` | free |
| `categories.delete` | `{categoryId}` → `{categoryId}` | free |
| `scenes.estimateCompose` | `ComposeRequest {avatarId, count 0..100, categories, poses}` → `{estimate}` | free |
| `scenes.compose` | `ComposeRequest + acceptedWorstMicros` → `{sceneSetId, jobId \| null}` | yes, job |
| `scenes.get` | `{avatarId}` → `{sceneSet \| null}` (the open set) | free |
| `scenes.edit` | `{sceneSetId, revision, op}` → `{sceneSet}` or `{problem}`; ops `text`, `remove`, `restore`, `addOwn {text, shot, pose}` | free |
| `scenes.estimateWrite` | `{sceneSetId, target}` → `{estimate}` | free |
| `scenes.write` | `{sceneSetId, revision, target, acceptedWorstMicros}` → `{jobId}`; targets `unwritten`, `rewrite {sceneIds 1..5, redraw}`, `idea {idea, count 1..5, shot \| null}` | yes, job |
| `scenes.cancel` | `{sceneSetId}` → `{sceneSetId}` | free |
| `scenes.discard` | `{sceneSetId}` → `{sceneSetId}` | free |
| `runs.estimateFromScenes` | `{sceneSetId, revision}` → `{estimate}` | free |
| `runs.startFromScenes` | `{sceneSetId, revision, acceptedWorstMicros}` → `{runId, jobId}` | yes |

`scenes.edit`'s `{problem}` is a normal result (`reason: empty | too-long | not-one-line |
youth-word | revealing-word`, `words`), so the UI names the word in Russian; the refusal changes
nothing.

**Events.** `category.changed` (`upserted {category}` | `removed {categoryId}`); `scenes.changed`
(`upserted {sceneSet}` | `removed {sceneSetId, avatarId}`). Windows fetch `categories.list` /
`scenes.get` on mount and on a library switch, then follow the events (the `media.*` pattern).

**Job kind `scenes`.** Ref `{kind: "scenes", jobId, sceneSetId, avatarId}`; `done/total` = scenes
written / scenes this job writes; result `{kind: "scenes", sceneSetId, avatarId, written,
unwritten}`. In `JobState`, `JobProgress`, `JobFailed`, `JobCancelled`, `JobResult`, the snapshot
and the renderer store (`trackScenesJob`, like `trackRunJob`).

**Error codes.** `POOL_REJECTED`, `SCENES_CHANGED` (with Russian texts in `errorMessagesRu.ts`).
Everything else reuses `NOT_FOUND`, `VALIDATION`, `IN_FLIGHT`, `PRICE_CHANGED`,
`MODERATION_REFUSED`, `RECONCILE_REQUIRED`.

**Deadlines** (`control.ts`): `categories.create`/`regenerate` = price fetch + 2 × `MAX_ATTEMPT_MS` +
slack (the descriptor's formula); estimates = price fetch + 15 s; compose/write/startFromScenes
answer as soon as the job is launched (`runs.start`'s formula).

## 6. Persisted data and backward compatibility

| Data | Change | Compatibility |
|---|---|---|
| `<library>/categories/<id>.json` | new, `schemaVersion: 1`, atomic | older builds never look there (the survey walks known folders only); a newer `schemaVersion` is refused and kept, not quarantined |
| `avatars/<id>/scenes/<setId>.json` | new, `schemaVersion: 1`, atomic, holds its pre-issued run id | same; the survey moves crash temps in both new folders |
| `runs/<id>/plan.json` | phase 1, additive: slot category widened to custom refs, top-level `categories?` snapshot. Phase 2, additive: slot `sentence?`, an own-slot variant, top-level `sceneSetId?`, `request` optional when `sceneSetId` is set; invariant `sceneSetId` ⇔ every slot has a sentence ⇔ `writerChunks: []` | today's files parse unchanged — pinned by a fixture written by `main` 3a9cd498 that must parse, fold and price a resume |
| `journal.jsonl` | none | — |
| `ledger.jsonl` | none (scope `{avatarJobId}` reused) | — |
| photo sidecar | optional `categoryName` | non-strict object: older builds strip it; an older build skips a custom-category photo from its gallery (counted, not lost) |
| renderer local storage | the switch position | try/catch; default ON when unreadable |

## 7. Money constants (provisional — each measured and pinned in its task)

| Call | Shape (ceiling) | Worst per attempt | × attempts | Typical |
|---|---|---|---|---|
| `POOL_CALL` (new) | ~10K in / 4K out | ≈ $0.0225 | 2 → ≈ $0.045 | ≈ $0.006 |
| `WRITER_CALL` (unchanged; compose, continue, rewrite, idea) | 14K / 8K | $0.0375 | 2 per chunk → $0.075 | 106 + 130 tokens per scene |

Every input ceiling must cover the reserve's own prompt floor (`promptTokenFloor`, bytes) for the
worst plausible prompt, with headroom — otherwise the reserve exceeds the accepted worst and the
job's own cap refuses it. Pins, parametrised the way `scenes/writer.test.ts` pins `WRITER_CALL`:

- `POOL_CALL`: a 500-char **Cyrillic** description (2 bytes per char) + the worst pool feedback;
- `WRITER_CALL`, phase 1: a full 25-slot chunk of a custom pool with every text at its 35-char
  bound (plain printable ASCII), the time of day at 15, the label at 24 + the worst refusal (words
  clipped to 6 x 16 bytes) ≤ 14K minus a 200-token margin;
- `WRITER_CALL`, phase 2: the worst review-time write — 5 own scenes each carrying a 500-char
  Cyrillic idea, or 5 redrawn custom slots — + the worst refusal ≤ 14K.

---

## 8. Tasks

Owner rules for every row: one executor per task, a separate reviewer in a fresh context after it,
max 3 fix rounds (memory: review-round-limit), a whole-slice review at the end. Logic, schemas and
money go through `oh-my-claudecode:test-engineer` (test first, red for the intended reason). UI goes
to `oh-my-claudecode:designer` on **opus**, against the Claude Design canvas
(`.omc/stage3/design/canvas/Photos.dc.html`, Components). Filesystem/process changes need the
Windows + macOS CI dispatch before merge (CI rule). Each task updates the docs for its own part
(`docs/studio/` — the Stage 2 money model lists every cap, and invariant 6 describes the writer only
inside a run; both must name the new calls and the scene set's own id rule).

| # | Task | Owner | Depends on | Size |
|---|---|---|---|---|
| CS.0 | Design: extend the Photos artboard (states below) | designer (opus) | — | M |
| CS.1 | Custom-category pipeline: contract widening, shared split, planner by ref, parametrised writer phase, snapshot, labels in every consumer (no new commands) | test-engineer (sonnet), review opus | — | L — **built** |
| CS.2 | Custom categories: store, pool call, commands, events, mock | test-engineer (sonnet), review opus (money) | CS.1 | M |
| CS.3 | Categories UI: chips, create dialog, «Мои категории» sheet | designer (opus) | CS.0, CS.2 | M |
| — | **Phase 1 ships here** (custom categories with today's runs); local build for the owner | — | — | — |
| CS.4a | Scene sets, core: store, `scenes` job kind, compose / continue / cancel / edit / discard, per-set mutex, pre-issued run id, mock | test-engineer (sonnet), review opus (money, state) | CS.1 | L |
| CS.4b | Scene sets, writes: rewrite, redraw, «По описанию» | test-engineer (sonnet), review opus (money) | CS.4a | M |
| CS.5 | Runs from a scene set: plan fields for pre-written slots, estimate/start, approval race | test-engineer (sonnet), review opus (money) | CS.4a | M |
| CS.6 | Review UI: the switch, the «Сцены» column, approve | designer (opus) | CS.0, CS.4b, CS.5 | L |
| CS.7 | Whole-slice review (opus) + E2E + docs + local build + paid canary (owner's approval) | code-reviewer (opus), verifier | all | M |

Order: CS.0 ∥ CS.1 → CS.2 → CS.3 (phase 1) → CS.4a → (CS.4b ∥ CS.5) → CS.6 → CS.7. CS.2 and CS.4a
both depend only on CS.1 and could overlap, but both touch `commands.ts`, `events.ts`, `state.ts`,
`errorMessagesRu.ts`, `mockEngine.ts` and the golden → merge CS.2 first. CS.4b and CS.5 touch
different engine files; merge CS.5 first. Everything in phase 2 lands after
`feat/studio-min-clip-100ms` (removes the old switch) and `feat/studio-delete-avatar` (CS.4a adds
the avatar's `scenes/` folder to what goes to the Trash and refuses deletion while a scenes job
runs).

### CS.0 — Design (designer, opus)

Extend `Photos.dc.html` (and Components where a new piece appears) in the same visual language:
the «+ Своя» chip and custom chips; the create dialog (form / generating / preview of the pool /
`POOL_REJECTED` / `PRICE_CHANGED`); the «Мои категории» sheet; the switch ON/OFF and the button's two
modes (compose, approve) with their prices; the «Сцены» column states (composing with progress,
ready list, a scene being rewritten, «не составлена», removed/greyed, add-own form with both modes,
stopped with «Дописать», used/locked, empty set); the gallery and montage-bin label for custom/own.
**Accept:** every state above drawn at 1200 and 1440 wide; CHANGES.md lists them in Russian; the
owner reviews at the end of each phase (Stage 3 rule: build against local artboards).

### CS.1 — Custom-category pipeline (test-engineer)

Scope (phase 1 only — nothing for scene sets yet):
- contract: `CustomCategoryId`, `CategoryRef` in `RunRequest.categories`, `PhotoCategory`
  (custom + `"own"`, so the renderer changes once) and `categoryName?` on `PhotoSummary`;
- the shared `orderCategories`/`splitCount`, used by the planner and by `runForm.ts`;
- `planWithPools` by ref, a custom category on `subSeed(seed, ref)`;
- `runWriterPhase` parametrised (call shape, messages builder) with a run passing today's values;
  the label resolver from the plan's snapshot;
- assembler style from the snapshot; `sentenceProblems` exported (the assembler keeps calling it);
- `RunPlanSchema`: category refs + the top-level `categories` snapshot only;
- `runJob` writes `categoryName` into the sidecar; `photoSummaryFrom` lists custom photos;
- every renderer consumer of a category: `runForm.ts`, `GenerateCard.tsx` (chips stay built-in until
  CS.3), `Gallery.tsx:45`, `PhotoViewer.tsx:91`, `montage/bin.ts:5,65-69`, `PhotoBin.tsx:110`, the
  mock engine.
Tests first:
- planner: with built-in categories only, every plan for a fixture set of seeds × subsets of the
  five equals fixtures produced from `main` 3a9cd498 byte for byte; a built-in category given the
  same number of slots draws the same slots (slot indexes aside) whether or not custom categories
  are in the request; a custom category draws only from its own pool on `subSeed(seed, ref)`;
- shared split: `splitCount` equals the planner's distribution for counts 1..100 × category lists
  (property test); the renderer's chip counts use it;
- writer phase: every request body of a built-in run (messages, schema, ceilings, ids) is
  byte-identical to today's; a custom slot's message names the snapshot's label;
- `WRITER_CALL` floor pin: a full 25-slot chunk of a custom pool at the 35/24-char bounds + the worst
  refusal ≤ 14K input tokens minus a 200-token margin;
- schema: `main`'s `plan.json` fixture parses, folds and prices a resume unchanged; a plan naming a
  custom ref without a snapshot entry is refused;
- assembler: built-in prompts byte-identical (existing pins); custom style used;
- `photos.list` lists a custom photo with `categoryName`; an unknown string is still skipped and
  counted; the montage bin shows a custom facet with its label.
Review notes (opus): determinism of built-in seeds; the money diff limited to `writerPhase.ts`
(parametrised, same values), `plan.ts` (refs, snapshot) and `runJob.ts` (label) — `estimate.ts` and
`remaining.ts` untouched.

#### CS.1 as built (2026-10-05, branch `feat/studio-custom-categories-pipeline`)

What shipped, per area. No new command, no new paid call, no new event; protocol v5 stays open and additive; the parity
golden is untouched (CS.1 adds no command).

- **Contract** (`studio/shared/engine/categories.ts`, new; exported from `index.ts`): `SceneCategory` moved here from
  `state.ts` (still exported from `shared/engine`), `CustomCategoryId`, `CategoryRef`, `PhotoCategory` (`+ "own"`),
  `CategoryStyle`, `CategorySnapshot {ref, name, label, style}`, `CategoryName` (1..40), `CategoryLabel` (1..24 printable
  ASCII), `isCustomCategory`, `orderCategories`, `splitCount`, and the constants `MAX_RUN_CATEGORIES` (20),
  `CATEGORY_LABEL_MAX` (24), `CATEGORY_NAME_MAX` (40), `POOL_TEXT_MAX`. `CustomCategoryId` is typed as the template
  `` `cat-${string}` `` (checked against `^cat-[a-z0-9-]{8,59}$`), not `string`: a plain `string` would have collapsed
  `CategoryRef` to `string` and every `Record<CategoryRef, …>` lookup with it. `RunRequest.categories` is
  `CategoryRef[]` (1..20, unique); `PhotoSummary.category` is `PhotoCategory`, plus `categoryName?` (refused on a built-in
  category: the renderer owns those names).
- **Shared split**: `orderCategories` (built-ins canonical, then custom in the order given, each once) and `splitCount`
  (even split, the remainder one each to the earliest) are the one rule the planner and the renderer both call.
  `planner.ts`'s private `distribute`/`orderedCategories` and the renderer's and mock's copies are gone.
- **Planner** (`scenes/planner.ts`, `scenes/categories.ts`, new): `PlanInput.categories` takes planner names and custom ids;
  `planWithPools(input, pools: Record<string, Pool>)` looks each category's pool up by ref (a missing pool is a
  `RangeError`); a custom category draws on `categorySeed(seed, ref)` and `poseSeed(seed, ref)`, i.e. `subSeed(seed, ref)`.
  `PlanSlotSchema.category` is `PlannerCategorySchema` (built-in names or a custom id).
- **Writer phase** (`runs/writerPhase.ts`): `WriterPhase` takes `call {maxTokens, inputTokens, maxAttempts}` and
  `messages(slots, feedback)`; `runs/plan.ts`'s `runWriterConfig(snapshots)` is what a run passes: exactly `WRITER_CALL`'s
  values and `writerMessages` with a label resolver built from the plan's snapshot. `writerMessages(slots, refusal,
  labelOf)` names a custom slot by the snapshot's English `label`; a custom slot with no snapshot entry throws instead of
  being sent under a made-up name.
- **Assembler** (`scenes/assembler.ts`): `assembleSlot/assembleRun` take the plan's snapshots; the realism suffix comes from
  `categoryStyleOf` (photoshoot editorial, other built-ins phone, custom: the snapshot's style). `sentenceProblems(sentence)`
  is exported and is what the assembler's last gate calls (same messages as before).
- **Plan schema** (`RunPlanSchema`): optional top-level `categories` (snapshot entries, unique); every custom ref the request
  or a slot names must have an entry. `buildRunPlan` writes the key only when there are entries, so a built-in run's
  `plan.json` is the document main wrote. `sceneCategory`/`contractCategory` stay in `plan.ts` and delegate to
  `scenes/categories.ts`.
- **Sidecar and listing**: `GeneratedSourceSchema` gains optional `categoryName` (non-strict object: older builds strip it;
  `SIDECAR_SCHEMA_VERSION` stays 1). `runJob` writes the snapshot's **name** (the owner's own wording) there for a custom
  slot and nothing for a built-in one. `photoSummaryFrom` passes `categoryName` through only for a custom or own category,
  so a stray label on a built-in photo never makes it vanish; an unknown string is still skipped and counted.
- **Engine commands**: the contract now accepts custom refs, but there is no category library until CS.2, so
  `runs.estimate` and `runs.start` answer `NOT_FOUND` (free, naming the ref) for any custom ref, right after the avatar
  check and before a price is fetched, a reserve made or a folder written. CS.2 replaces that one check with a lookup. The mock
  does the same in the same order.
- **Renderer**: `runForm.ts` (`photosPerCategory` is `splitCount`; `runRequest` uses `orderCategories`;
  `photoCategoryLabel` names a photo's category: built-in by `CATEGORY_LABEL`, custom or own by the label its photo kept, with
  the fallbacks «Своя категория» / «Своя сцена»), `Gallery.tsx`, `PhotoViewer.tsx`, `montage/bin.ts` (its local
  `PhotoCategory` type is now `BinCategory`; facets come from the categories the photos carry: built-ins first, then custom
  and own by label, each shown by the label of its newest photo, each `{category, label, count}`) and `PhotoBin.tsx`.
  `GenerateCard.tsx` is untouched: its chips stay the five built-ins until CS.3. The mock's split is `splitCount`.

Deviations from the plan, measured: **`POOL_TEXT_MAX` is 35, not 48.** The pin is built by hand for the worst chunk a custom
category can send under the rules a pool and a plan are held to: 25 slots, every place, activity and outfit at the bound (plain
printable ASCII, no `"` and no `\`, so one byte each and never escaped by the JSON the slots go out as), a 15-char time of day, an
all-photographer deck, the widest pose label, a 24-char label, the widest slot indices (a 100-photo run's last chunk, slots
76..100), and the worst refusal (every reason, 160 distinct hostile words of exactly 16 bytes in four widest kinds; the pin
asserts that the feedback then carries exactly 6 words of exactly 16 bytes per reason). With the refusal words bounded to 6
words of 16 bytes each (case-insensitive dedupe, clipped on character boundaries) the floor is 13759 tokens at 35 chars: a
margin of 241 tokens under `WRITER_CALL.inputTokens` = 14000. The pin requires a margin of 200; at 36 chars the margin is 166,
so 35 is the largest bound that keeps it (the pin asserts both). The pin is a superset of the worst that can actually be sent:
a refusal cannot be both not-json and empty, a two-handed problem only comes from a selfie or mirror slot and a pose
contradiction only from a back or profile slot, and the reachable worst measures 13449 tokens, so no run over-spends today.
Raising `REFUSAL_WORDS_MAX` far enough turns the pin red (checked). A first cut measured 40 as fitting with 106 tokens of headroom, but that pin was not the worst:
a quote costs two bytes (a label of 24 quotes, or pool texts of quotes, went over the ceiling) and the refusal's words, the
model's own text, were unbounded. `WRITER_CALL`, `estimate.ts` and `remaining.ts` are untouched.

Behaviour change accepted with it: a re-ask after a rejected answer now tells at most 6 offending words, each clipped to 16
bytes and each spelling told once (the first spelling seen), where it told every word as the model wrote it. The first attempt's
messages, and every retry told only fixed reasons, are byte-identical to main (the fixtures cover them).

Also as built: `PlanSlotSchema` holds a custom slot's `location`, `activity`, `outfit` to `PoolText` and its `timeOfDay` to
`TimeOfDay`, so a hand-edited `plan.json` cannot grow the writer's prompt past its reserve on a resume (built-in slots are
not held to it: their plans must keep parsing). `CategoryName` is held to the avatar name's rules (no control, invisible or
bidi characters, not blank), and `photoSummaryFrom` drops a sidecar `categoryName` the contract would refuse (the photo stays
listed). The sidecar field is `categoryName`: it holds the owner's name (`snapshot.name`), not the writer's English `label`.

CS.2 requirements this adds: pool texts are `PoolText`, times `TimeOfDay` and labels `CategoryLabel` (see section 4.1 step 4);
**category names are unique per library, compared case-insensitively after trim**, because two categories with one name are
indistinguishable in the montage bin's filter (`montage/bin.ts` shows a category by its name). CS.3 requirement: the custom
chips are in creation order, not in the order they were clicked (`runForm.ts` `runRequest` keeps the form's order for custom
ids, and the form appends in click order, so the chips row must sort by creation order before it builds the form).

Tests, all written first and run red for the intended reason: byte-identical built-in plans (a digest per subset of the five
categories over 6 seeds x 5 counts x with and without poses and recent pairs, `scenes/fixtures/planner-main-3a9cd498.json`),
byte-identical writer messages, request bodies, attempt ids and reserves of a built-in run
(`runs/fixtures/writer-main-3a9cd498.json`), a `plan.json` fixture written by main that parses unchanged, folds and prices a
resume (`runs/fixtures/plan-main-3a9cd498.json`), the shared split against the planner for every count 1..100, the floor pin,
snapshot refusals, the sidecar and listing, the montage bin facets, and the engine and mock refusals. All fixtures were
generated from unmodified code at `main` 3a9cd498 before any change.

Verification at the end of CS.1: `tsc` clean for `studio/` and `studio/shared/`; the full Studio suite in three shards,
6368 + 5550 + 6170 = 18088 tests passing, 0 failing (after fix round 2) (the face parity test skips without the local model cache, as before);
the Windows and macOS CI dispatch is recorded in the task's report.

### CS.2 — Custom categories engine (test-engineer)

Scope: `library/categories.ts` store + layout constant + survey temps; `scenes/poolGen.ts` (prompt,
JSON schema, `readPoolAnswer` with salvage and the `twoHanded` normalisation, `POOL_CALL`);
`scenes/categoryJob.ts` (2-attempt loop like `descriptorJob`); the six `categories.*` commands and
`category.changed`; serialisation (`IN_FLIGHT` flag, `#paidCommands`); paid pool kept in `raw/` on a
failed write; `control.ts` deadlines; `runs.estimate`/`runs.start` accept custom refs (unknown or
deleted → `NOT_FOUND` before any price fetch or spend); `POOL_REJECTED` with its Russian text; mock
engine (deterministic pool from the name) + mock tests; free commands in the parity golden;
`mockOpenRouter.ts` answers the `scene_pool` schema; the smoke creates a category and runs 5 photos
with it.
Tests first:
- `readPoolAnswer`: valid → pool; salvageable → pool without the bad items; below minimums → refusal
  with fixed reasons and our own words only; texts over 35 chars, with a `"` or a `\`, or non-ASCII refused or salvaged;
  a «both hands» activity marked one-handed comes out `twoHanded: true`; a moderation refusal is
  final and free; an empty answer counts as answered; two rejections → `POOL_REJECTED`;
- money: estimate = 2 × ceiling at today's prices; `PRICE_CHANGED` above the accepted worst; monthly
  room; reserve before send, settle after; cap = accepted worst; `AUTH_INVALID` marks the key;
  `POOL_CALL`'s floor pin (500 Cyrillic chars, worst feedback);
- serialisation: a second create/regenerate while one runs → `IN_FLIGHT`, nothing reserved; a library
  switch during one is refused; the 50 limit cannot be passed by two concurrent creates;
- store: atomic create/rename/remove-item/regenerate/delete; list order (createdAt, id); an
  unreadable file is counted, not fatal; a newer `schemaVersion` is refused and kept; a failed write
  keeps the paid pool in `raw/`;
- canary (`engine.canary.test.ts`): the avatar vibe marker never appears in a pool-call body.
Review notes (opus): the scope reuse (`avatarJobId`) and that the ledger format is unchanged; the
salvage rule never keeps an item that breaks `PoolSchema`.

#### CS.2 built (2026-10-06, branch `feat/studio-custom-categories-engine`)

What shipped. Protocol v5 stays open and additive.

- **Contract**: `categories.list` (`{categories, unreadable, interrupted[], busy}`), `categories.estimate`, `categories.create`,
  `categories.regenerate` (both answer `{category, spentMicros}`: what THIS call cost; the category's own `spentMicros` is its total),
  `categories.update`, `categories.delete`, and a seventh command, `categories.dismissInterrupted {jobId}`, which the CS.0 contract notes need
  («Убрать» forgets the record). Event `category.changed` (`upserted {category}` | `removed {categoryId}`). Error code `POOL_REJECTED`
  (Russian text in `errorMessagesRu.ts`). `EngineError.spentMicros` (additive): on every failure of a paid category call from the moment
  its call started, 0 for a provider refusal, absent on the refusals before it. Shared: `CategoryDescription` (1..500, line break allowed),
  `CategoryPool`/`CategoryPlace`/`PoolShot` (counts 5..7 places, 3..6 outfits, deck of 5, 1..3 times, 2..4 activities, one free hand per
  place, a mirror place when the deck can draw a mirror shot), `CategorySummary {categoryId, name, description, label, style, pool, model,
  spentMicros, createdAt, updatedAt}`, `CategoryInterrupted`, `CategoryBusy`, `categoryNameKey` (the one name-uniqueness rule), `MAX_CUSTOM_CATEGORIES`.
- **Engine**: `library/categories.ts` (`CategoryStore`, one record per category, one lock for the folder, atomic writes, unreadable and newer
  records counted and kept, names unique per library, the 50 limit, `pending-<jobId>.json` records of calls in flight; the survey moves its crash
  temps), `scenes/poolGen.ts` (prompt, strict `scene_pool` schema, `readPoolAnswer` with salvage and the `twoHanded` normalisation),
  `scenes/poolCall.ts` (`POOL_MAX_ATTEMPTS`, `poolCall`, kept light because `control.ts` reads it), `scenes/categoryJob.ts` (two attempts, the
  descriptor job's mould), `scenes/categoryPlan.ts` (price), `money/jobSpend.ts` (what the ledger booked for a job id: the one source of every
  «потрачено»). `#categoryCall` serialises create/regenerate (IN_FLIGHT, counted in `#paidCommands`); the call's scope is `{avatarJobId}`
  (ledger format unchanged), capped at the accepted worst; the pending record is written before the first send and removed on any outcome; a
  paid pool that cannot be stored is kept in `raw/<jobId>:category`. A failed regenerate keeps the old pool and adds its cost to the category's
  total (event `upserted`). `runs.estimate`/`runs.start` look custom refs up in the library (unknown or deleted → NOT_FOUND, after the avatar
  checks, before any price), plan from the pool and write the `categories` snapshot. `control.ts` deadlines as the descriptor's.
- **Mock and parity**: `MockCategories` (deterministic pool from name + description), controls `setCategoryPrice`, `failNextCategoryCall`,
  `seedInterruptedCategory`; the store follows `category.changed` through `subscribeCategories`. `mockOpenRouter.ts` answers `scene_pool`. Two
  golden scenarios appended (+44 lines, nothing changed).
- **Smoke**: `runCategoryScenario` (`--only category`): create, list, a run of 5 photos with the category, label-only writer, canary, money.

Money numbers (fallback prices): `POOL_CALL` 10,000 tokens in / 4,000 out = $0.0225 an attempt, $0.045 for two (the estimate and the
default cap, accepted worst = cap), typical 1,800 + 1,500 tokens = $0.006. Floor pin (`poolGen.floor.test.ts`): worst prompt = a 500-char
description of 3-byte chars (CJK) with the worst feedback (all 8 reasons, 6 words of 32 bytes) = **6,442 tokens**, margin **3,558** under the
10,000 ceiling (the pin requires 3,000; Cyrillic measures 5,942); the reserve of that prompt equals the ceiling's price (22,500 µ$).

Deviations from the plan, and why:
1. **The category's name is not sent to the pool call** (§4.1 step 3 says name + description; §4.4 and the CS.0 dialog say the name is UI-only):
   only the description goes; the canary and the smoke pin it.
2. The seventh command, `categories.dismissInterrupted`, and `categories.list`'s `busy` (so a second dialog can say what it waits for) are
   additions the design notes ask for.
3. The pool is salvaged item by item without any rewriting: no normalisation of quotes or accents, a bad item is dropped; a mirror deck with no
   mirror place is refused (never given a place it did not name). Repeats and items past the pool's largest size are ignored.
4. The floor pin is measured with 3-byte characters, not only Cyrillic: a 500-char description can cost 1,500 bytes.
5. `categories.estimate` is not in the parity golden: the mock's prices are «live» by design, the engine's offline ones the table.
6. Not shown in the transcript of the golden: events (the existing rig records none).

Verification: `tsc` clean for `studio/` and `studio/shared/`; the full Studio suite in three shards, 7032 + 6115 + 5627 = 18774 tests
passing, 0 failing; the E2E smoke's category scenario, 25 of 25 checks (unpackaged E2E build); the packaged smoke and the Windows and macOS CI
dispatch are recorded in the task's report.

Tests seen red first: the contract, `readPoolAnswer`, the floor pin, the store, `categoryJob`, `jobSpend`, `categoryPlan`, the engine
commands (red: INTERNAL «not implemented yet»), the deadlines, the mock, the store listeners, the mock OpenRouter route. Written after the
code and checked red afterwards by switching the lookup back to CS.1's refusal: the custom-run tests in `engine.runs.test.ts`. Passing at once by
nature: the canary tests (a leak-free property) and the smoke scenario.

#### CS.2 fix round 1 (2026-10-06): what CS.3 builds on

The review returned MERGEABLE; this round fixes what gets expensive after merge (the on-disk format, the contract) and the cheap money and data
items in the same files. Contract additions, all additive in protocol v5:

- **`PoolTime` / `POOL_TIMES`** (shared): a place's `times` are bound to the plan's vocabulary (morning, midday, golden hour, evening, night,
  studio lighting), no longer any short ASCII text. `readPlace` drops a time outside it (normal salvage); a place left with no time follows the
  below-minimum rule. The mock already used the vocabulary.
- **`EngineError.categoryReason`**: `"limit" | "name-taken" | "below-minimum" | "mirror-needed" | "item-not-found"`, only on `VALIDATION`, set on every
  category VALIDATION: create, update and the one a create meets after its pool was paid for (it then also carries `spentMicros`). `exists`
  (an id clash) and `not-found` carry none. Russian texts: `CATEGORY_REASONS_RU` in `errorMessagesRu.ts`, read by `errorText`. The mock sets the same; the parity
  golden covers the free ones (`transcript.ts` writes the field; a new scenario with a second category plays a taken name).
- **`CategoryInterrupted`**: `spentMicros` and the new `openReserveMicros` are both `number | null`. `openReserveMicros` is the part of the spend that is a
  reserve still open at its worst case, so «Запрос учтён по худшей цене до сверки» is true exactly when it is above 0. A call killed before its reserve
  was written is a known `0` and `0`; a ledger that cannot be read gives `null` and `null` (unknown, not nothing). The refinements: both null or both set,
  the open part never above the spend.
- **`categories.list`**: a new `overLimit` count (a separate field, not folded into `unreadable`: those files can be read). `categories` holds at most 50, the
  oldest first; `overLimit` counts the readable ones past the 50th, which stay on disk and come back as categories are deleted. Every `cat-*.json`
  holds a place towards the limit, readable or not, so a create is refused (`limit`) at 50 files and the folder stays bounded; a name held by a category the
  list leaves out still counts as taken (`CategoryStore.assertRoom` reads the whole folder).
- **`busy`** of a regenerate names its category from the moment the command is claimed (the listing looks the name up when the call has not read it yet).
- **`categories.dismissInterrupted`** on an interrupted regenerate first adds the call's spend to its category (written before the record is removed: a crash
  between the two can only count it twice, never lose it); with an unreadable ledger it is refused with the ledger's own code. A call that ended in this
  process but whose record could not be removed is not listed as interrupted, is removed again at the next listing, and its dismissal books nothing.

Engine behaviour: a rename to the name a running create is about to take is refused (`VALIDATION`, `name-taken`), so the paid create is no longer lost at its
write; a delete marks its category before its first await and a regenerate or an update of it is refused (`IN_FLIGHT`) with nothing reserved; a ledger write
that fails in an attempt's reserve or settle ends the job as a failed call that carries what the ledger holds (`CategoryJobDeps.errorOf`), and a regenerate
books it; a regenerate whose paid pool could not be stored also books its cost; both delete paths flush the folder (`fsyncDir`) after the unlink.

Verification: `tsc` clean for `studio/` and `studio/shared/`; the full Studio suite in three shards, 5898 + 6196 + 6745 = 18839 tests passing, 0 failing.
Tests seen red first: every item above (the engine, store, job, shared, renderer-text and mock tests); the golden lines of the category scenarios
changed only where the new fields appear (they are this branch's own entries), and no older golden line moved.

#### CS.2 fix round 2 (2026-10-06): the booked-jobs key

A review of round 1 reproduced a double count: `#dismissInterrupted` wrote the spend before removing the record, so a removal the disk refused
(EBUSY/EPERM after `unlinkWithRetry`, EIO/EACCES) left the call listed and every further «Убрать» added the spend again. Two relatives had the same cause:
after a restart a finished regenerate whose record survived looked interrupted, and `replacePool`'s write could throw after its rename (the folder's flush).
All three are closed by one idempotency key on disk (CS.2 is unmerged, so the format was still free):

- **`bookedJobs`** in the category record (`cat-*.json`, not in the contract; `summaryOf` drops it): the ids of the paid calls whose cost is already in
  `spentMicros`. `create` (its own job), `replacePool` and `addSpend` take the `jobId` and write it in the same atomic record write as the amount; a job already
  listed is a no-op and writes nothing. A record without the field reads as `[]` (zod `default`), so older records and fixtures still parse.
- **Cap: the last 200 ids, the oldest dropped** (`BOOKED_JOBS_CAP`). Only one paid call runs at a time and its record is either removed at the end of the call or listed
  as interrupted for the owner to dismiss, so a call that can still be booked again is a recent one: 200 later bookings of the same category before its stale record
  is dismissed is out of reach, and the record stays a few KB however long the category lives.
- **`#dismissInterrupted`**: when the removal of the record throws after the cost is booked (or the call is already known to have ended), the call is remembered as
  ended, a warning is logged and `{ jobId }` is answered; the listing no longer offers it, the next listing retries the removal, and a repeated «Убрать» is a no-op by
  memory and by the key. A removal that fails for a call with nothing booked is still an error.
- **A record write that threw after its rename** (the flush of the folder) is recognised by the key: the engine reads the record back, finds the job in `bookedJobs`
  and answers success, so the owner is not told «не удалось» for a pool that is in the library, and the failure path books nothing a second time. The test seam for it is
  `testHooks.afterRename` (runs between the rename and the flush).

Contract parity (the UI in CS.3 is built against the mock): the mock refuses `categories.dismissInterrupted` of an interrupted regenerate whose cost is unknown
(`spentMicros: null`, or a ledger marked unavailable) with the ledger's code and keeps the record, as the engine does, and books a job once. `exists` (an id clash after the
pool was paid for) is now `INTERNAL`: the id is `cat-` + a random UUID, so it is unreachable except by a record planted by hand under that exact name, and it names no
`categoryReason`, which now holds for every category VALIDATION. Not done, in the backlog: a test for a rename to the name of a hidden (51st and later) category.

Verification: `tsc` clean for `studio/` and the root; full Studio suite in three shards, 5905 + 6209 + 6745 = 18859 tests passing, 0 failing. Tests seen red first: the store key (17 000 for 11 000, the key list
missing), the engine cases (dismiss twice 17 000 for 11 000, restart 15 200 for 10 100, write after rename 15 200 for 10 100 and a failure answer, a create that failed
after its rename, `exists` as VALIDATION), the mock (a regenerate with unknown cost dismissed, a job counted twice).

### CS.3 — Categories UI (designer, opus)

Scope: chips (built-ins, then custom, counts from `splitCount`); «+ Своя» dialog with price,
generate, preview, errors; «Мои категории» sheet (rename, remove item, regenerate with price,
delete with confirm); store slice for categories (`categories.list` on mount and library switch,
`category.changed`).
Accept: matches CS.0's artboards at 1200/1440; the paid button follows the app's rules (price keyed
to the exact request and models, `PRICE_CHANGED` notice, no double send, paid-in-flight lock);
mock-engine screen tests for each dialog state; keyboard and screen-reader labels like the existing
chips.
Review notes: sonnet review for UI logic, opus conformance pass against the canvas.

#### CS.3 built (2026-10-06, branch `feat/studio-custom-categories-ui`)

What shipped. Renderer only: no contract, engine, mock or golden change.

- **Window slice** (`renderer/engine/categoryLibrary.ts`, owned by `EngineProvider`, read with `useCategoryLibrary()`): the library's
  categories (`categories.list`, asked when a screen first retains the slice, again on the store's `resynced` — a gap, a restarted engine, a
  library switch — and for another engine or library folder; the last list stays on show while the same library is listed again; changes heard
  while a list is on its way are applied to its answer; a delete while `overLimit > 0` lists again so the category coming back is shown), the pool
  call's price (`categories.estimate`, keyed by the settings' text model: a change asks again, a price for another model is never offered), and the
  window's one paid category call: sent only with the worst case a priced button showed, never twice, its outcome kept per kind (`create`,
  `regenerate`) until the screen clears it, PRICE_CHANGED re-priced at once (the refused worst case kept to compare), IN_FLIGHT re-listed so the
  dialog can name the other call, and a `busy` that was this window's own call forgotten when it ends. Because the call lives in the window and not in
  the dialog, a create hidden with «Скрыть», or a Photos screen left while a pool is composed, still lands. `subscribeCreated` puts a category
  this window made into the run at once (owner decision 4).
- **Category row** (`photos/CategoryRow.tsx`): built-ins, then custom chips in creation order, drawn alike (max 220 px, the name cut with «…», whole
  in `title` and `aria-label`, counts from `splitCount` in `aria-label` like the built-ins); a chip spinning while this window composes a pool
  (hidden dialog: it takes the focus and reopens the dialog; when the pool lands the focus moves to the new chip, or to «+ Своя» if it failed);
  more than four custom ones: the first four and every one turned on stay, the rest behind «ещё N» (`aria-expanded`), opened in place; «+ Своя»
  dashed and last, unavailable at 50 held places (categories + unreadable + overLimit) with «50 из 50 — удалите ненужную в «Мои категории».»;
  «Мои категории · N» in the label row. The form keeps custom refs in creation order (`arrangeCategories` / `toggleCategory` in `runForm.ts`), so a
  chip clicked last never takes a remainder photo from one made earlier; a category deleted, or another library's, leaves the request at once and
  the form once the library is listed.
- **«Новая категория»** (`photos/CategoryCreateDialog.tsx`, a portal on `useModalDialog`): free checks before sending (blank once touched, 40 /
  500 chars, hidden chars, a name the library holds — `categoryNameKey`); price «≈ … · до …» with model, attempts and price source; one priced
  click; busy with seconds and «Скрыть»; done with the pool read-only (places with Russian times, outfits, shot shares) and «Готово» → the new chip;
  every failure in the design's words with what it cost (`spentMicros`): POOL_REJECTED, MODERATION_REFUSED (first attempt free / second paid), the
  limit («Мои категории»), a pool paid for but not stored (INTERNAL with a cost → «Открыть Настройки»), PRICE_CHANGED («Подтвердить новую цену ·
  до $X»), IN_FLIGHT (names the other call), `paidBlockedReason`. A create that failed while hidden is a notice under the card with «Изменить
  описание».
- **«Мои категории»** (`photos/CategorySheet.tsx`): the right panel (760 / 680 px), list with counts, detail with label, style, date, spend;
  rename (Enter / Escape, free checks); × on a place or an outfit (free; unavailable with the reason at the minimums and for the only mirror place
  of a mirror deck; the focus goes to the next ×); regenerate with its price, busy (rename, delete, × locked), failure keeps the old pool and says
  what it cost, PRICE_CHANGED, done with the new pool; delete confirmed on the spot (focus on «Отмена», Escape back to «Удалить», then the next
  category); empty invitation; unreadable and overLimit notes; Escape cancels what is open inside before it closes the panel.
- **Interrupted calls** (`photos/CategoryNotices.tsx`): a create a closed Studio left stands under the card and atop the panel, a regenerate in its
  category's box; «Создать снова / Пересоздать снова · до $X» (a new request, unavailable with `paidBlockedReason` until the reconcile),
  «Изменить описание», «Убрать» (`categories.dismissInterrupted`; a refusal, e.g. an unknown cost, is said and the record stays).
- **Money** on these screens follows the design's «Деньги на экране»: `formatUsdTiered` (three decimals below $0.10, a ceiling up, an estimate and
  spent money to the nearest).
- **Gallery**: a photo's category label is cut with «…» on the tile and whole in its `title` (decision 6).

Deviations from the artboards, and why: a busy paid button stays at full colour with its spinner (the app's own rule for `aria-busy` buttons) where
the boards dim it; «пересоздана … · всего потрачено» is known only for a regeneration this window made (the contract keeps no date or count of
regenerations; after a restart the line reads «создана … · потрачено» with the true total); the overLimit note, the money sentence of an interrupted
call whose reserve is closed or unknown, the list's loading and failure states have no board and use their own wording; an interrupted regenerate
also offers «Убрать» (the contract notes ask for it; the board's box has only «Отмена» / «Пересоздать снова»); with another window's call in
flight «Создать» stays available (the `busy` it names is a snapshot; the engine refuses a second call for free); the board's sample outfit «beige
trench coat over a striped tee» is 36 chars, over `POOL_TEXT_MAX`, so fixtures cut it. Phase 2 parts of the boards (the «готово» line for an open
scene set, «Мои категории» in the set's strip) are not built.

Tests, written first and run red for the intended reason: `formatUsdTiered`, `arrangeCategories` / `toggleCategory` / `sameCategories`, every
wording in `categoryText.ts`, the slice (`categoryLibrary.test.ts`), the chip row and the create dialog (`PhotosCategories.test.tsx`), the gallery
label. The sheet's tests (`PhotosCategorySheet.test.tsx`) were written after its code; each key one was proven by breaking the behaviour it pins
(Escape order, focus after ×, delete focus, the busy lock, the reconcile lock, the focus after a regeneration) and seeing it fail. Focus is compared
through `describeElement` and absence through `=== null`, as the repo's `studio/testing/domMatchers` guard requires: a DOM node handed to a matcher
that prints it makes Bun print the node's whole graph (one such failure here ran for minutes and was then reported as a pass).

Verification: `tsc` clean for `studio/` and `studio/shared/`; the full Studio suite in three shards, 6489 + 5865 + 6762 = 19116 tests passing,
0 failing; screenshots of every phase-1 board at 1200 and 1440 against the mock (`.omc/stage3/design/custom-categories/impl-shots/`, untracked),
no console errors.

CS.3 fix round 1 (2026-10-06), each fix with a test run red for its reason first: (1) the slice marks its list stale instead of forgetting the
library key when no screen shows it, so a library switch heard while unretained resets the list to `loading` on the next retain (a library's
categories are never shown for another); (2) PRICE_CHANGED takes the refused price off until the fresh answer, and a forced re-price outranks an
estimate already on its way (a price-request generation); (3) the price-key guard is pinned by a screen test (text model changed while an estimate
is pending: «до …», disabled); (4) Enter during IME composition in «Название» no longer sends the paid create; (5) `category.changed` re-lists
while a `busy` is named, an IN_FLIGHT refusal is dropped once the list shows nothing composing, and «Создать», «Пересоздать» and «… снова» wait,
with the note, while another window's call is named (this replaces the earlier deviation that «Создать» stays available); (6) a failed
regenerate is «retried» only if it spent; (7) an interrupted call's reserve is told in money: «Запрос учтён по худшей цене — до $0.023 — до
сверки расходов.» Verification: `tsc` clean for both configs; renderer 2947 tests; full suite in three shards, 6494 + 5876 + 6762 = 19132
passing, 0 failing.

### CS.4a — Scene sets, core (test-engineer)

Scope: `library` scene-set store (per avatar, atomic, `revision`, one open set, pre-issued run id,
survey temps, Trash on avatar deletion); `engine/sceneSets/` (compose job driving the parametrised
writer phase one pending chunk at a time, view builder, edit ops, the per-set mutex); the `scenes`
job kind end to end (contract, registry, events, snapshot, renderer store `trackScenesJob`, sidebar
counts); `scenes.estimateCompose`, `compose`, `get`, `edit`, `estimateWrite`/`write` with the
`unwritten` target only, `cancel`, `discard`; `scenes.changed`; `SCENES_CHANGED`; mock engine + tests;
free commands in the golden.
Tests first:
- compose persists the run id and the chunk ids before the first call; a fake kill between a
  reserve and its answer, then a restart: the set reads `stopped`, «unwritten» passes only pending
  chunks and resumes from the next unused id, never resending a reserved one;
- a gave-up chunk is marked and the job **goes on** with the next chunk; a later «unwritten» does
  not retry it; cancel keeps written chunks;
- `scenes.edit`: each `problem` reason; a stale revision → `SCENES_CHANGED`; two edits on the same
  revision → the second refused, nothing lost; refused while the set's job runs (`IN_FLIGHT`) and
  when the set is used; one open set per avatar (compose while one is open → `VALIDATION`);
- concurrency: compose/write refused while the avatar runs a run or another scenes job; a library
  switch is refused while a scenes job runs; discard refused during a job;
- money: compose estimate = writer worst for N (`writerWorstMicros`); `PRICE_CHANGED`; monthly room;
  per-job cap = accepted worst;
- canary: the vibe marker never appears in a compose body.
Review notes (opus): the state machine (writing/stopped/ready/used) at every crash point; event
ordering (`scenes.changed` before `job.done`); that the run's own writer phase still stops at its
first unwritable chunk (only the set's job continues past one).

#### Owner decisions for phase 2 (2026-10-07), binding

1. **«Сцены на проверку» is ON by default and remembered** (a renderer setting, per machine; CS.6). The engine only has to support both paths: CS.4a's
   compose/«Дописать» are the review path, `runs.start` is the unchanged path with review off.
2. **Own scenes only «По описанию»** (an idea written by the model). There is no «Как есть»: no `addOwn` op exists, and CS.4b/CS.6 do not build one.
3. **⟳ redraws the whole scene** (a new place, outfit, activity and pose from the same category, and a new sentence), as the recommended default of §11.4 said (CS.4b).

#### CS.4a built (2026-10-07, branch `feat/studio-scene-sets-core`)

What shipped. Protocol v5 stays open and additive. No paid or live call anywhere (the fake OpenRouter only).

- **Contract** (`shared/engine/scenes.ts`, new): `SceneSetView {sceneSetId, avatarId, createdAt, revision, status writing|stopped|ready|used, stoppedBy, stoppedError,
  runId (named only when used), poses, categories [{ref, name}] (the set's own snapshot), textModel, spentMicros, openReserveMicros (both null when the ledger is
  unreadable), write {kind, count} (the live write), lastCompose {total, written, gaveUp}, chunks [{chunk, sceneIds, attemptsLeft, gaveUpBy}], scenes}`;
  `SceneView {sceneId, origin, category, categoryName, shot, pose, place, idea, text, edited, removed, unwritten pending|gave-up, gaveUpBy rejected|refused|no-attempts, chunk}`;
  `SceneStoppedBy` (`closed` is derived, never stored), `ComposeRequest`, `SceneEditOp` (`text`, `remove {1..100}`, `restore {1..100}`), `SceneProblem` (`empty | too-long |
  not-one-line | control-char | youth-word | revealing-word`, with the words), `SceneWriteTarget` (`unwritten` only), `ScenesResult`. Commands `scenes.estimateCompose`, `compose`,
  `get` (`{sceneSet, unreadable}`), `edit` (`{sceneSet}` or `{problem}`), `estimateWrite`, `write`, `cancel`, `discard`. Event `scenes.changed` (`upserted {sceneSet}` | `removed
  {sceneSetId, avatarId}`), always before the job's `job.done|failed|cancelled`. Job kind `scenes` (`JobProgress`, `JobFailed`, `JobCancelled`, `JobResult`, `JobState`, snapshot).
  Error code `SCENES_CHANGED` (Russian text in `errorMessagesRu.ts`). Deadlines: the two estimates, compose and write = price fetch + 15 s; the other four keep main's default.
- **Store** (`library/sceneSets.ts`): `avatars/<avatarId>/scenes/<sceneSetId>.json`, atomic (temp, fsync, rename, fsyncDir), `revision` on every write, one lock per set
  (`scenes:<id>`), a stale revision is refused before the mutation runs, a `guard` runs under the lock before the revision is compared (used / job live). Unreadable or newer-schema
  files are counted and never touched; the survey moves crash temps. The set holds its pre-issued run id; **used ⇔ `runs/<runId>/` exists** (`Library.runFolderExists`).
- **Engine** (`engine/sceneSets/`): `compose.ts` (the planner a run uses, seeded by the set id, recent pairs avoided, chunk ids `${setId}:writer-${n}#1..4` written into the file
  BEFORE the first call), `chunks.ts` (attempts per chunk from the ledger: `answered` = `attemptPaid`, `attemptsLeft = min(2 − answered, unused ids)`), `estimate.ts`, `view.ts`,
  `edit.ts`, `mutations.ts`, `writeJob.ts` (drives `runWriterPhase` one pending chunk at a time), `service.ts` (the commands; engine.ts only wires them).
- **Mock and parity**: `renderer/engine/mockSceneSets.ts` (same states, same order of refusals, controls `failNextSceneAttempt`, `markSceneSetUsed`, seeds `sceneSets`,
  `unreadableSceneSets`); store: `trackScenesJob`, `subscribeSceneSets`; the sidebar counts a scenes job with the photo-side jobs unchanged. Two golden scenarios appended
  (55 lines, nothing else moved); `sceneSetId` joined the transcript's id kinds.

State machine (derived on every view; the file stores only the write record `{k, kind, jobId, stoppedBy?}`):

| Crash or stop point | Ledger | View |
|---|---|---|
| set written, no reserve yet | nothing | `stopped`/`closed`, both attempts left, spent 0 |
| between a reserve and its answer | open reserve | `stopped`/`closed`, spent and open reserve = $0.0375, ONE attempt left; paid calls wait for the reconcile |
| after the reconcile closed it | estimated settle | same spend, no longer open; «Дописать» sends ONE attempt, never a fresh pair, never the reserved id |
| answer settled, chunk not yet saved | settle | `stopped`/`closed`, that attempt counted, scenes still waiting (an accepted answer is kept nowhere: `raw/` holds only unusable paid responses; the save is retried once first) |
| chunk 1 saved, chunk 2 not asked | settle | `stopped`/`closed`, chunk 2's scenes pending |
| all chunks saved, write not cleared | settles | `ready` (nothing left to write) |
| job stopped by a 429/5xx | free settle | `stopped`/`rate-limited` or `provider-error`, both attempts kept |
| job stopped by a dropped connection / timeout | open reserve | `stopped`/`network` or `timeout`, one attempt left |
| cancel mid-request | open reserve | `stopped`/`cancelled`, written chunks kept |
| two rejected answers / a provider's refusal | settles / none | chunk `gaveUp` `rejected` / `refused`, the job goes on; never retried |
| all ids or attempts used | settles | scenes `gave-up`/`no-attempts`, skipped, «Дописать» does not count them |
| every waiting scene removed | any | `ready` (the button is «Отрисовать») |
| run folder exists | any | `used`, read-only, names its run |

Money (fallback prices): one attempt $0.0375 (14K in, 8K out); compose 20 = $0.075 worst, ≈ $0.009 expected; 26 = $0.15; 100 = $0.30. «Дописать» of 35 scenes fresh = $0.15;
after the first chunk's request was interrupted $0.1125 (one attempt + two); remove the second chunk's 10 scenes → $0.0375; a chunk the owner typed text into entirely is not asked and
costs nothing. The writer prompt floor pin holds for every chunk a set can send (the file holds custom scenes to `POOL_TEXT_MAX`, chunks to 25: `sceneSets/floor.test.ts`).

Deviations, and why: (1) **the job's cap is the estimate's worst case** (`min(accepted, estimate)`; `accepted ≥ estimate` is checked, so they are equal for a window that sends the price it
showed) rather than the accepted value itself, so an inflated acceptance cannot raise a cap. (2) **No per-scene «interrupted write» markers**: in CS.4a only compose and «Дописать»
exist, and an interrupted one reads as the set `stopped`; the per-scene markers (`rewriteInterrupted`, `interruptedIdeas`, `dismissInterrupted`) arrive with CS.4b's rewrite and idea writes.
(3) **A paid answer whose chunk could not be written to disk, even after one retry, is lost to the set**: the client keeps a raw body in `raw/` only for an unusable paid response (`UNUSABLE_PAID_RESPONSE`), NOT for an accepted answer, so nothing else holds it; the attempt stays counted. (4) `scenes.get` answers the open
set, else the newest used one; it reads every set file of the avatar (a prune of used sets is a backlog item). (5) The set is live (edits refused `IN_FLIGHT`) from the claim of its
write, while its prices are still being fetched, so no edit can land between the checks and the first call. (6) Own scenes (CS.4b) will join `SceneRecord` as a second variant.

Tests seen red first, for the intended reason (a stub that throws «not implemented yet», or a permissive stub that accepts what the contract must refuse): the contract (40 of 52
assertions), the store (30), `chunks` (20), `estimate` (18), `compose` (13), `edit` (29), `view` (34), `mutations` (12), the write job (23), the job registry (10), the store `guard` (3),
the engine commands (71 of 72: INTERNAL «not implemented yet»), the deadlines (4), the mock (35). Written after the code and checked by mutation: the floor pins
(`sceneSets/floor.test.ts`: a chunk bound of 30 turns «a chunk holds at most 25» red) and the renderer store tests; the parity golden was generated from agreeing engines.

Verification: `tsc` clean for `studio/` and `studio/shared/`; the full Studio suite in three shards, 6991 + 6570 + 5977 = 19538 tests, 0 failing (after one fix: the new test files call `useNativeGlobals()`).

**CS.4a fix round 1** (review: not mergeable; every finding reproduced, each fix has a test seen red first for the intended reason).

- **A refused `scenes.write` removed another job's live mark (HIGH).** `write` now refuses `IN_FLIGHT` at its very start when the set is live, and its `finally` deletes only the live
  entry it made itself (`mine`); `scenes.cancel` goes through `jobs.runningJobOfSet`. Two concurrent writes start exactly one job; the other is `IN_FLIGHT` with nothing written.
- **An accepted paid chunk could be lost to the store (MEDIUM, money).** The writer's sentence has no upper bound (the run's journal accepts `z.string().min(1)`), while the stored and
  shown text was capped at 600: a 676-char accepted sentence failed the whole save. The stored/view `SceneText` is now bounded below only; the 600-char bound (`SCENE_TEXT_MAX`) is the
  OWNER's edit alone (`textProblem` answers `too-long`). The save of an accepted chunk is retried once from the sentences in memory on a non-store error (a refusal of the store itself,
  `SceneSetError`, is deterministic and is not retried). Row 4 of the crash table and deviation (3) are corrected above: `raw/` holds only unusable paid responses, never an accepted answer.
- **The start of a write is announced (MEDIUM).** compose: the first `scenes.changed` carries the full `write.count` (it was 0 until the launch). «Дописать»: `scenes.changed` goes out
  right after the write is recorded (status `writing`, the next revision), not at the first chunk, which can be minutes away. The mock already did both.
- **Renderer store tests pinned (MEDIUM).** The tracking test runs on a bare scripted bridge, so only `trackScenesJob` can give the total; the job-first-heard-at-its-end test feeds only
  `job.done`, so only the `written + unwritten` sum can give it. Seen red under both mutations (`trackScenesJob` a no-op; the sum replaced by 0).
- **LOW, same files.** `avatar delete` now announces `scenes.changed removed` for each of the avatar's sets before `avatar.removed` (engine: the sets are listed at the prepare, announced
  at a `trashed` finish; an avatar pruned after its folder vanished is announced by `avatar.removed` alone; the mock does the same). The mock takes the text model from the set (kept at
  its creation), as the engine does. `lastCompose` is the outcome stored when the last write job ended (`SceneSetFile.lastOutcome`, optional, so older files stay valid); a set no job
  ended on (seeded, or its process died) still reads it from the scenes as they are now, so «Готово 35 из 60» no longer changes when the owner removes scenes. The store's JSDoc blocks sit
  on their own methods again.

Verification of the round: `tsc` clean for `studio/` and `studio/shared/`; the scene sets' suites, the mock, the store and the parity scenarios for scenes all green. A local full run
(this machine lacks the resvg wasm, fonts, native decoders and caption renderer) had 6929 + 6417 + 6680 passing and no failure in any scenes test; the red ones are the text, decode, media and
caption-preview files only. CI is the full run of record.

#### CS.5 built (2026-10-07, branch `feat/studio-runs-from-scenes`)

What shipped. Protocol v5 stays open and additive. No paid or live call anywhere (the fake OpenRouter only).

- **Contract**: `runs.estimateFromScenes {sceneSetId, revision}` → `{estimate}` (free) and `runs.startFromScenes {sceneSetId, revision, acceptedWorstMicros}` → `{runId, jobId}`.
  Deadlines: the estimate = price fetch + 15 s; the start = `runs.start`'s own (price fetch + 2 × `REFERENCE_TIMEOUT_MS` + slack). No new error code. The start also announces
  `scenes.changed` (upserted, status `used`, `runId` named) right after the run folder exists and before any event of the run's job, so every window sees the lock.
- **Plan** (`runs/plan.ts`, `scenes/schema.ts`): `RunPlanSchema` gains `sceneSetId?`, `sceneIds?` (the set's scene id of each slot, in slot order) and `request` becomes optional; the slot gains
  `sentence?: SceneText` (min 1, no upper bound) and a second slot variant, the own scene (`kind: "own"`, category `"own"`, shot, pose, sentence; no place fields; a selfie or mirror still faces
  the camera). The planner's `ScenePlanSchema` is unchanged: only the run's plan knows the own variant. Invariant, in the schema: `sceneSetId` ⇔ every slot has its sentence ⇔ `writerChunks: []`
  ⇔ no `request` ⇔ `sceneIds` (one distinct id per slot); a mixed plan is refused. Slots are renumbered 1..M in the set's order (a set with scene ids [1,3,4,5] becomes slots 1..4), which is what
  `RunPlanSchema` requires. A plan written by main still parses unchanged, key for key (`runs/fixtures/plan-main-3a9cd498.json`).
- **Engine**: `sceneSets/toRun.ts` (pure: the refusals in their order, the run's scenes, the category snapshots the active scenes use), `sceneSets/approve.ts` (`loadApprovable`, and `commitApproval`
  under the set's own lock), `engine.ts` (`#estimateFromScenes`, `#startFromScenes`), `money/estimate.ts` (`writer: null` takes the writer term out of both figures), `runs/plan.ts`
  (`runEstimateFromScenes`, `buildSceneRunPlan`), `runs/journal.ts` (`foldRun` seeds the sentences from the plan), `runs/runJob.ts` (an own slot commits as category `own` and leaves no history line;
  the writer phase is handed only the planner's slots), `scenes/assembler.ts` and `scenes/categories.ts` (accept the own slot; an own scene is finished like a phone photo).
  `SceneSetService` gained two small methods, `isLive` and `announce`.
- **Mock and parity**: `mockEngine.ts` / `mockSceneSets.ts` (`approvalOf`, `approve`, `runPriceFromScenes`; the set's pre-issued run id is the run's). One scenario appended to the golden (31 lines,
  nothing else moved): the free refusals in order. Success estimates differ by design and the rig's two engines differ on the age gate, so the priced path is pinned by each side's own suite.

The estimate: `runEstimate` with M photos (the active scenes with text) and **no writer term**, plus an age check per attempt when the check is on; at Settings' image model, quality and age-check mode
(the README's CS.5-2: `cameraRealism` is not in it). Refusals, all free and nothing written, in this order: `NOT_FOUND`, `SCENES_CHANGED` (the revision moved), `VALIDATION` (an active scene has no
text, or none or more than 100 are active), `IN_FLIGHT` (a job of the set runs), `VALIDATION` (already used). The start then makes exactly `#startRun`'s checks (key, ledger, avatar, master, age and face
gates, `PRICE_CHANGED`, monthly room, the master preflight) and, **last, under the set's lock**, reads the set again, refuses again on what is there now, and makes the run folder under the set's pre-issued
run id with the plan built from that very record. The cap is the accepted images-only worst case for exactly those scenes, fixed for the run's life (`min(accepted, estimate)`, as CS.4a's jobs: an inflated
acceptance cannot raise it).

Money (fallback prices, one image attempt $0.05, age check off): 5 photos worst $0.75 / expected $0.25; 4 photos worst $0.60 / expected $0.20; 18 photos worst $2.70 / expected $0.90 (the doc's reviewed
run: 20 composed, 2 removed); the whole run for the same photos is dearer by exactly its writer, `ceil(M / 25) × 2 × $0.0375`. Each removed scene lowers the worst case by exactly its three attempts ($0.15).
With the age check on, 4 photos: worst 4 × 3 × ($0.05 + $0.00525) = $0.663. Nothing reserves a writer id: a run's ledger holds `<runId>:slot-N#k` ids only.

The race, each with a test: an edit, a removal and a discard that land while the start awaits the prices → `SCENES_CHANGED` / `NOT_FOUND`, no run folder, no reserve, no paid call, the avatar's claim released;
a run folder that appears meanwhile is refused and left as it was; an edit or a discard after the run exists → `VALIDATION` (used); a second start (after the run ended, and while it still draws) → refused,
one run folder; a kill after `createRun` (a fresh engine over the same folders) reads the set `used`, and `runs.list` lists the run resumable. The re-check under the lock was mutated away: the edit and
removal races turn red.

Tests seen red first, for the intended reason (a stub that throws «not implemented yet», or a permissive stub that accepts what the contract must refuse): the plan (25 of 29 on the throwing stub,
then 9 on the permissive schema: the invariant's refusals, the empty set, `foldRun`'s seed), the estimate (8 of 8), the contract (the command set, the fixtures, 6 round trips) and the deadlines (2),
`toRun` (17 of 18), the engine commands (INTERNAL «not implemented yet» on every success and every refusal that needs the set; the count was not kept), the announcement (1), the mock (13 of 13), the
own-slot job tests (1: category `own`). Green on arrival, honestly: most of the run-job tests (the job already skips the writer once `foldRun` seeds the plan's sentences, which was red first), and the
history test, which a mutation (the skip removed) turns red; the 700-char pins are red under a 600 bound on the plan's sentence.

Deviations, and why: (1) **a set's plan has no `request`** (rather than a synthetic one): nothing reads it, and an own-only set has no category to name. (2) **`sceneIds` in the plan** keeps the scene id ↔ slot
mapping the UI and the history will need. (3) **`scenes.changed` at the approval** (additive): the file does not change, but the view does (`used`). (4) **No `#assertCategoriesExist` at the approval**:
the set holds its own snapshot of every custom category it uses, so a category deleted since does not stop a run (a test pins it, and that the photo keeps the owner's name). (5) **`IN_FLIGHT` is only
reachable through a set's own job when every active scene already has text**, which on this base needs CS.4b's rewrite; here the order is pinned by the unit test, and the engine's `IN_FLIGHT` by the avatar's claim.
(6) The own-scene mapping from the set's record is **not written**: `runSources` switches exhaustively on `scene.origin`, so merging CS.4b's own `SceneRecord` fails to compile exactly there; the plan side
(own slot, no history line, category `own`) is built and tested. (7) The E2E smoke's own-scene-by-idea step is a TODO (the `idea` target is not on this base); the scenario composes five, edits one, removes one,
restarts the engine during the review, approves, and checks the writer was asked for nothing.

### CS.4b — Scene sets, writes (test-engineer)

Scope: `scenes.write` targets `rewrite` (1..5, `redraw`) and `idea` (1..5); the idea prompt
variant with its own system prompt (the compose prompt stays byte-identical), read by
`readWriterAnswer`; the deterministic one-slot redraw from the current pool (in the planner); write
ids `${sceneSetId}:write-${k}#n` and the redraw stored in the write record before the call; mock
idea answers in `mockOpenRouter.ts`.
Tests first:
- write ids and `k` are persisted before the call and never repeat across restarts; a crash-resume
  of the same write draws nothing new;
- redraw is deterministic per (seed, scene, k), avoids places/outfits already in the set where it
  can, shows the new place only with its accepted sentence, refreshes the category snapshot; a
  failed write leaves the scene as it was; a deleted category → redraw refused free, rewrite allowed;
- idea with count k adds k own scenes; auto shots never pick mirror; poses follow the set's
  allowance; selfie/mirror own scenes are front or three-quarter;
- money: write estimate = `WRITER_CALL` × 2 for one chunk; the phase-2 floor pin (5 own scenes with
  500-char Cyrillic ideas, or 5 redrawn custom slots, + the worst refusal ≤ 14K);
- canary: the vibe marker never appears in rewrite or idea bodies.
Review notes (opus): money (per-job cap, ids); that a rewrite never touches a scene outside its target.

#### CS.4b built (2026-10-07, branch `feat/studio-scene-sets-writes`)

What shipped. Protocol v5 stays open and additive. No paid or live call anywhere (the fake OpenRouter only). The README of the design wins where the plan says «Как есть» / `addOwn`: there is no such mode.

- **Contract** (`shared/engine/scenes.ts`, `commands.ts`): `SceneWriteTarget` gains `rewrite {sceneIds 1..5, redraw}`, `idea {idea, count 1..5, shot | null}` and **`resume {write}`** (a deviation, below);
  `SceneEditOp` gains `dismissInterrupted {sceneIds 1..5 | write}` (exactly one); `SceneView.rewriteInterrupted? {write, stoppedBy}` and `SceneSetView.interruptedIdeas? [{write, idea, count, shot, stoppedBy}]`
  are optional and omitted when empty, so no existing transcript moved; `SceneLiveWrite.kind` gains `rewrite | idea` and `sceneIds?`. `SceneIdeaInput`: 1..500 chars, not blank, and no heavier than
  3 bytes a character once JSON-escaped (control characters and lone surrogates escape to 6 and would break the floor pin). No new error code.
- **Store** (`library/sceneSets.ts`): `SceneRecord` is `planned | own`; an own scene has its stored idea, a shot, a pose and a sentence, no place, no chunk. `reviewWrites?` holds a record per rewrite or idea write
  (`k`, `jobId`, the four ids `${set}:write-${k}#n`, `closed`, `stoppedBy`, and the draw: a rewrite's redrawn `slots` and refreshed `snapshots`, an idea write's reserved scene ids with their shot and pose),
  written BEFORE the call. A record outlives its write (closed): its ids are burnt and its attempts are spend. At most 500 records per set (refused VALIDATION past that).
- **Engine** (`engine/sceneSets/`): `reviewPlan.ts` (every free refusal and every draw, from the set as it is now), `reviewMutations.ts` (pure changes: begin, resume, accept, stop, close),
  `reviewWrites.ts` (attempts from the ledger, `nextSceneId`, the interrupted list), `reviewWriteJob.ts` (the job: one request, the compose prompt for planned scenes, the idea prompt for own scenes and idea writes),
  `estimate.ts` (`reviewWriteEstimate`), `view.ts`, `edit.ts`, `service.ts`. `scenes/redraw.ts` (`redrawSlot`, `drawOwnScenes`) and `scenes/ideaWriter.ts` (the idea prompt; the compose prompt is untouched and still byte-pinned).
  `readWriterAnswer` reads a `ReadableSlot` (number, shot, pose), so one reader serves both prompts; `runWriterPhase` is generic over it (a type-only change).
- **Mock and parity**: `mockSceneSets.ts` / `mockEngine.ts` plan, draw, price, refuse, mark and resume as the engine does (`failNextSceneAttempt` drives review writes too; seeds take own scenes and review writes);
  `scripts/mockOpenRouter.ts` answers idea requests; one parity scenario appended (48 lines, nothing else moved) with a `reviewWrites` rig.

Rules as built:

| Rule | How |
|---|---|
| Ids and `k` | `k = set.writes + 1`, persisted with the draw before the call; `writes` only grows, so no id of a write is ever another's, across restarts too |
| Resume | `scenes.write {resume}`: same `k`, same draw, same ids; the next unused id; a reserved id is never sent again; nothing is drawn |
| Attempt invariant | answered attempts per write ≤ 2 across ALL jobs, from the ledger; an open reserve and a reconcile's estimated settle count as answered; a write left with none is resolved, not resumable |
| Money | new write = `WRITER_CALL` × 2 (one request, two attempts); resume = attempts left × the ceiling; the job's cap is the estimate (`accepted ≥ estimate` is checked), as in CS.4a; `PRICE_CHANGED`, monthly room, `RECONCILE_REQUIRED` as for any paid command |
| Redraw | deterministic per (set seed, scene, `k`), from the category's CURRENT pool; avoids the places and outfits the set shows (then the scene's own); a mirror shot stays on a mirror place (a selfie if the pool has none); selfie/mirror stay front or three-quarter; the scene shows the new place only with its accepted sentence; the set's snapshot (`label`, `style`, `name`) of the category is refreshed at acceptance |
| Deleted category | redraw refused free (`NOT_FOUND`), plain rewrite works (with the label the set holds) |
| Own scenes | only from `idea`; auto never draws the mirror; poses follow the set's allowance; ⟳ on an own scene is `rewrite {redraw: false}` from the STORED idea, never the current text |
| Failure | a failed write leaves every scene exactly as it was; two rejected answers, a refusal or no attempt left resolve the write and end the job `failed` (`INTERNAL` / `MODERATION_REFUSED`); a free failure or an interruption leaves it resumable and marks its scenes (`closed` when nothing says why) |
| Markers | per scene, never cleared by a write on another scene; a new rewrite of a marked scene takes it over (the old record keeps its other scenes); only a resume or `dismissInterrupted` clears one |
| Canary | the avatar's vibe never appears in a rewrite or an idea body (engine test) |

Floor numbers (`promptTokenFloor`, tokens; the ceiling is 14,000 and the pin keeps a 200-token margin, so ≤ 13,800): five redrawn custom slots at every bound with the worst refusal **5,266**; five own scenes with 500-char
Cyrillic ideas **8,247** fresh, **9,257** after the worst refusal; the heaviest idea the contract lets through (500 three-byte characters) **10,747 / 11,757**. (All measured with five-digit scene ids, the widest an id can be.) The 25-slot compose pin is unchanged
(13,712 with the ids 1..25 a compose chunk really has; a planned scene's id never passes 100). The write estimate is `2 × 37,500 µ$ = $0.075` at the fallback prices, expected ≈ $0.0005 per scene.

Deviations, and why: (1) **`resume {write}` is a new target**: the plan lists only `unwritten`, `rewrite` and `idea`, and the README says «Повторить» is `scenes.write` resuming write k, which needs a way to name k;
re-sending the same rewrite would be a new write with new ids and a new pair of attempts. (2) **A write that can never be answered ends its job `failed`** rather than `done` with `unwritten`: the owner asked for one thing and
nothing changed, and `MODERATION_REFUSED` is the owner's text refused by the provider. (3) **Scenes of an idea write join the set when accepted**, at the end of the list, under the ids reserved before the call
(so a later write's scenes can come before an earlier one's after a resume). (4) **`dismissInterrupted` by scenes shrinks the record** (its other scenes stay resumable) and by write closes it; a record out of attempts is not offered
as a marker but can still be dismissed. (5) **A set records at most 500 review writes** (they are kept for their spend and ids). (6) The mock's redraw uses the mock's own tables, so its places differ from the engine's; only the rules are shared.

Tests seen red first, for the intended reason (a stub that throws «not implemented yet», a schema that did not yet accept the shape, or the old behaviour): the contract (10 of 12 new), the redraw and own-scene draws (21), the idea prompt (11 of 14; the 3 reader tests
could only change in type), the store (16 of 23), `reviewWrites` (26), `reviewMutations` (35 of 40; the 5 «throws» tests passed under the stub), the view (16 of 25), `dismissInterrupted` (13 of 16), the estimate (7 of 8), the review job (26 of 29), the engine commands
(38 of 47: «no scene of the set is waiting to be written»), the mock (28 of 29), the fake provider (4 of 4), the `lastOutcome` reset (1) and the parity scenario («no golden transcript»). Written after the code and checked by mutation: the phase-2 floor pins,
the engine's «a store refusal is not retried» (red when the `SceneSetError` check is removed) and a batch of 16 mutations of the money, id and marker rules (15 caught; the survivor, a cap set to the accepted price instead of the estimate, is not observable:
no attempt can exceed the estimate).

Verification: `tsc` clean for `studio/` and `studio/shared/`; the full Studio suite in three shards, 7143 + 6616 + 6174 = 19933 passing, 0 failing (this machine, `node_modules` linked from the main checkout; CI is the run of record).

### CS.5 — Runs from a scene set (test-engineer)

Scope: the phase-2 plan fields (slot `sentence?`, the own-slot variant without place fields and with
category `"own"`, top-level `sceneSetId?`, `request` optional with it) under the invariant
`sceneSetId` ⇔ every slot has a sentence ⇔ `writerChunks: []`; `foldRun` seeds sentences from the
plan; the run's estimate passes a zero writer term; `runJob` skips the history append for own slots;
`runs.estimateFromScenes`, `runs.startFromScenes` with the approval race closed (re-read and
revision check under the set's mutex right before `createRun` under the pre-issued id); mock + tests;
E2E smoke scenario.
Tests first:
- schema: a mixed plan (some slots with a sentence, or a sentence with writer chunks) is refused;
  `main`'s fixture still parses;
- estimate = M photos with no writer term (+ age checks when on); refusals in order: revision, empty
  text, 0 or > 100 active, job running, already used — all free, nothing written;
- the race: an edit, then a discard, landing while the start awaits prices/preflight → the start
  refuses (`SCENES_CHANGED` / `NOT_FOUND`) and writes nothing; an edit after `createRun` is refused;
- start: `plan.json` slots equal the active scenes in order with their sentences; cap = accepted
  worst; a second start of the same set fails on `run-exists`; a kill right after `createRun` still
  reads the set as used;
- `runJob` with pre-written sentences sends **no writer request** and journals the prompts before
  the first image; an own slot commits without a history line; cancel, resume (`remaining.ts` with no
  chunks) and `runs.list` behave as for any run;
- E2E smoke: compose 5 → edit 1 → remove 1 → add own («как есть») → approve → 5 photos; the engine
  restarted during review keeps the set.
Review notes (opus): the cap is fixed once and covers exactly the approved scenes; no path sends an
image before `plan.json` exists; no path approves a set twice.

### CS.6 — Review UI (designer, opus)

Scope: the switch (remembered, default ON); the button's modes (compose / approve / continue) and
prices; the «Сцены» column per CS.0 (cards with category and shot tags, inline edit with the
problem shown, remove/restore, ⟳ with a price popover, add own with both modes, «Пересоставить» with
confirm, progress and cancel of the scenes job, stopped and gave-up states, locked after approval
and linked to its run); store slices (scene sets, scenes jobs); every edit sends the revision it was
made on; the approve price is re-asked on every `scenes.changed`; the old «скоро» placeholders removed.
Accept: CS.0's artboards at 1200/1440; paid buttons follow the app's rules; mock-engine screen tests
for every state; nothing paid fires without a click after a restart.
Review notes: sonnet logic review, opus conformance pass.

### CS.7 — Whole-slice review, E2E, docs, local build, canary

- Whole-slice review (opus), areas: money/state (CS.2, CS.4a/b, CS.5), contract/mock parity, UI
  conformance.
- CI on macOS + Windows incl. the packaged smoke; local build (`bun run dist:studio:mac`) for the
  owner.
- Docs: the Stage 2 money model and invariant 6 extended for the pool call, scene-set jobs and runs
  from a set.
- Paid canary, **only with the owner's approval**: create 1 category (≈ $0.006, worst ≈ $0.045),
  compose 5 scenes (≈ $0.003, worst $0.075), 1 rewrite (≈ $0.002, worst $0.075), approve 5 photos
  (≈ $0.25, worst $0.75); reconcile; record the numbers and the real token counts (input for a
  smaller review-time call shape later).

Phase 1 = CS.0 (category states), CS.1, CS.2, CS.3. Phase 2 = CS.0 (review states), CS.4a, CS.4b,
CS.5, CS.6, CS.7. Rough size: phase 1 ≈ one L and two M tasks; phase 2 ≈ two L and three M tasks
plus the review.

## 9. Risks

| Risk | Where | Mitigation |
|---|---|---|
| A retried or resumed writer call is sent twice | compose/write after a crash | ids persisted in the set before the call; the writer phase skips ledger-reserved ids; crash tests |
| A reserve exceeds the accepted worst, so the job's own cap refuses it | writer chunks of custom pools, pool and idea calls | pool texts ≤ 35 plain chars (no `"`, no `\`) and label ≤ 24, refusal words clipped; every ceiling pinned against the worst `promptTokenFloor` (Cyrillic input, worst refusal) |
| Built-in runs change behind the parametrised writer phase | CS.1 | byte-identical request-body pin for built-in runs |
| An edit lands while an approval is under way, or two edits race | approve, edit | one mutex per set, revision on every mutation, re-read and compare right before `createRun` |
| A set approved twice → two runs | approve | the run id is issued at compose; `createRun` refuses an existing folder under its own lock |
| One bad writer chunk blocks the rest of a set forever | compose, continue | the set's job passes only pending chunks and goes on past a gave-up chunk |
| Two paid category writes race (double spend, limit passed, library switched mid-call) | categories | `IN_FLIGHT` flag + `#paidCommands`; paid pool kept in `raw/` on a failed write |
| Restart in the middle of review or compose | engine/app restart | the set is a file; `stopped` derived; reconcile flow for open reserves, as today |
| Built-in plans drift (existing seeds produce different scenes) | planner change | byte-identical fixtures from `main` |
| Renderer counts disagree with the engine's split | chips | one shared function |
| A custom-category photo disappears from the gallery or the montage bin | contract, renderer | `PhotoSummary` widened and every consumer updated in CS.1, before any such photo can exist |
| Category deleted or regenerated during a run | resume, rewrite | plans and sets carry a snapshot; redraw refused free when the pool is gone |
| A single-scene rewrite shows the cap of a whole chunk («до $0.08») | review UI | the typical cost is shown next to it; a smaller measured call shape after the canary |
| Owner text refused by a provider | pool, idea, prompt | existing `MODERATION_REFUSED` (free); no new gate |
| Merge conflicts in the contract and the golden | CS.2 / CS.4a, CS.4b / CS.5 | merge order CS.2 → CS.4a, CS.5 → CS.4b; phase 2 after the min-clip and delete-avatar branches |
| Paid flows are not in the parity rig (it scripts no chat) | parity | free commands in the golden; paid flows pinned by engine tests, mock tests and the E2E smoke |

## 10. Out of scope (follow-ups)

Live per-scene status during the image run (the mockup's «Рисуется / Проверка / Отказ → повтор»,
already in the Stage 2 backlog); the «История сцен» tab over used sets; shot-type percentages;
hand-editing pool items beyond removal; reordering scenes; moving categories between libraries; a
smaller measured call shape for review-time writes (after the canary's token counts).

## 11. Open questions for the owner (each has a recommended default)

1. **«Сцены на проверку» by default** — ON (the mockup's default) and remembered; or OFF.
   Recommended: ON.
2. **Custom categories shared by all avatars** (one library-wide list) — or per avatar.
   Recommended: shared.
3. **Own scenes** — both «По описанию» (any language, written by the model, ≈ $0.002) and «Как есть»
   (your English text, free); or only one of them. Recommended: both.
4. **What ⟳ does on a planned scene** — a new place/outfit from the same category plus new text; or
   only new text for the same place/outfit (fine changes go through the pencil anyway).
   Recommended: new place/outfit + text.
5. **Where categories are managed** — on the Photos screen (chip «+ Своя» and a «Мои категории»
   sheet), or a card in Settings. Recommended: Photos.
