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
   reserve is priced on bytes) so a full 25-slot writer chunk of a custom pool stays at least 300
   tokens under `WRITER_CALL`'s 14K input ceiling with the worst refusal (pinned by a test, 368
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
  clipped to 6 x 16 bytes) ≤ 14K minus a 300-token margin;
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
  refusal ≤ 14K input tokens minus a 300-token margin;
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
all-photographer deck, the widest pose label, a 24-char label, and the worst refusal (every reason, 160 distinct hostile words
in four widest spellings, which the feedback clips). With the refusal words bounded to 6 words of 16 bytes each (case-insensitive
dedupe, clipped on character boundaries) the floor is 13632 tokens at 35 chars: a margin of 368 tokens under
`WRITER_CALL.inputTokens` = 14000. At 36 chars the margin is 293, below the 300 the pin requires, so 35 is the largest bound that
keeps it (the pin asserts both). A first cut measured 40 as fitting with 106 tokens of headroom, but that pin was not the worst:
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
6368 + 5550 + 6168 = 18086 tests passing, 0 failing (after fix round 1) (the face parity test skips without the local model cache, as before);
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
