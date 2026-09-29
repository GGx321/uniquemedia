# Studio — Stage 3 design reconciliation (task 3d.0)

File: `docs/studio/2026-09-30-stage-3-design-reconciliation.md`.

## Owner decisions (2026-09-30)

The six questions of section 5 are settled. Everything below them that reads "until he
answers" now follows these answers.

**His answers:**
- **Q1, one photo → one video (no reuse):** as built. Used photos stay visible in the bin,
  dimmed («в видео»), and cannot be added. After «Готово», «Рендер» is disabled with an
  explanation. Deleting the video frees its photos.
- **Q2, «Плашка»: the artboard's model.** `color` paints the plaque, and the text is
  #111111 or #ffffff by contrast (3b.4b; the plan's Text row).
- **Q6, «Удалить запись» for an `elsewhere` video:** allowed, behind an explicit
  confirmation, «Файл останется в прежней папке, а фото снова станут свободными» (3e.2).

**Defaults he accepted:**
- **Q3:** no scale slider for cells or own video in Stage 3.
- **Q4:** no «Проверить» for the RapidAPI key; a check costs 1 of the 30 requests.
- **Q5:** own stickers are GIF/APNG only; no still PNG.

Status: **provisional**, built against the designer's LOCAL artboards (the owner's decision of
2026-09-30: he reviews the artboards only when Stage 3 is complete). The 3d.0 row says "after the
owner reviews"; the newer decision wins. Everything here is adjusted after his review.

It is the contract for the UI tasks 3d.1a–3d.6, 3e.1–3e.3 and 3f.6: every control the artboards
draw is mapped to a spec field, a command, an event or a snapshot field, or it is named as a gap.
A control the contract lacks becomes a contract change first; it is never guessed in the UI.

## Sources

- The plan: `docs/studio/2026-09-29-stage-3-plan.md` (fixed decisions, `MontageSpec` sketch,
  contract additions by slice, invariants, task rows 3a–3f and their decision blocks).
- The contract on `main` (protocol 5): `studio/shared/engine/` — `montage.ts`, `video.ts`,
  `commands.ts`, `events.ts`, `state.ts`, `errors.ts`, `errorMessagesRu.ts`.
- The 3a.8b.2 branch (`worktree-agent-afdd5c549fa1dfc66`, reviewed MERGEABLE, not yet on
  `main`): `RENDER_QUEUE_FULL`, `LIBRARY_TOO_NEW`, the render `saving` flag on `JobProgress` and
  `JobState`, `videos.delete {videoId, mode: "video" | "record"}` → `{videoId, fileDeleted,
  fileState}`. Marked **†** below.
- The shared geometry `studio/shared/montage/` and the sticker manifest `studio/shared/stickers/`.
- The local artboards (scratchpad `stage3/design/`): `Editor`, `EditorNew`, `EditorText`,
  `EditorMusic`, `EditorGif`, `EditorMine` (one template, `Editor.dc.html`, with different
  default props: `tab`, `sel`, `render` = idle / blocked / nofolder / busy / done, `zones`,
  `bars`, `playhead`, `draft` = full / empty, `refresh` = idle / confirm), `EditorEmpty`,
  `AvatarVideos`, `Photos`, `Settings`, `Sidebar`, `Components` (section «Монтаж · этап 3»),
  plus `canvas.json`, `CHANGES.md` and the PNGs in `shots/`.
- The pending plan notes (review requirements for 3d/3e: the «сохранение» phase, delete modes,
  "upsert after `job.failed` wins", `PHOTO_UNAVAILABLE` cell highlights, the
  `RENDER_QUEUE_FULL` / `LIBRARY_TOO_NEW` texts, "usage unknown", `ImageDecoder`
  `colorSpaceConversion: "none"`, sticker frames by `delayFrames`, © ® ™ refused).

**Not reconciled here:** `Main.dc.html` (the avatar tile's «K видео»), `AvatarNew.dc.html` and
`Autopilot.dc.html` are on the canvas but not in the local set. The avatar tile's video count is
`AvatarSummary.videoCount` (exists) and must be checked against `Main` after the owner's review.

## Summary

| What | Count |
| --- | --- |
| Controls and data items in the table (section 1) | **256** |
| — `exists` (incl. † on the 3a.8b.2 branch) | 142 |
| — `exists-but-shape-differs` | 22 |
| — `missing-in-contract` | 53 |
| — `not-in-plan` | 11 |
| — `preview-only` | 28 |
| Contract gap items (section 3) | **30** (27 shape changes, 2 doc-only rules, 1 removal) |
| Conflicts with fixed decisions (section 4) | **20** |
| Open questions for the owner (section 5) | **6** |

## Legend

- **Artboard** — the file without `.dc.html`. `Editor*` = all six editor artboards (one
  template); a row names a single editor artboard when only that one shows the state.
  `Components` = the «Монтаж · этап 3» section of the components sheet.
- **Status** — one of:
  - `exists`: the contract (or the shared modules) already carries it; **†** = on the 3a.8b.2
    branch, not yet on `main`;
  - `exists-but-shape-differs`: it exists, but the artboard needs another shape (said how);
  - `missing-in-contract`: a gap; the proposal is the `K` item in section 3;
  - `not-in-plan`: a design-only idea the plan does not have (see section 4 or 5);
  - `preview-only`: a renderer concern with no engine counterpart (layout state, playback,
    navigation, undo, toggles).
- **CF** = a conflict (section 4), **Q** = an open question (section 5), **AM** = an ambiguity
  with its best reading (section 4.3), **K** = a contract change (section 3).
- "total" = Σ `clips[].durationMs`; "playhead" = the renderer's clock, snapped to 100 ms.

---

## 1. The control table

### 1.1 Sidebar (`Sidebar`, embedded in every artboard)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| S1 | Sidebar | «Аватары» | route to the avatars grid | Stage 1 route | exists |
| S2 | Sidebar | «Фото» | route to the current avatar's photos | `photos.list` | exists |
| S3 | Sidebar | «Монтаж» | route to the drafts list (`EditorEmpty`) | `montages.list` (K3) | missing-in-contract |
| S4 | Sidebar | «Автопилот» | Stage 4 screen | — | not-in-plan (Stage 4; stays disabled) |
| S5 | Sidebar | «Настройки» | route | `settings.get` | exists |
| S6 | Sidebar | «Очередь · 8 задач» | unfinished jobs of every kind | `Snapshot.jobs` + `job.*`: count of `queued` + `running` | exists |
| S7 | Sidebar | «Генерация 6 / 20» + bar | the running photo run | `JobState` kind `run`, `done / total` | exists |
| S8 | Sidebar | «Рендер 2 / 5» + bar | render batch progress, queued included | `JobState` kind `render`; best reading AM4 | exists |
| S9 | Sidebar | «Баланс OpenRouter · $42.18 · сегодня −$3.40» | balance | Stage 2 money | exists |
| S10 | Sidebar | «Уникализатор ↗» | switch to the uniquifier | Stage 1 | exists |

### 1.2 Drafts list (`EditorEmpty`, «Монтаж · черновики»)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| D1 | EditorEmpty | «Монтаж», «5 черновиков · 1 рендер идёт» | title and counts | K3 `total`; running `render` jobs | missing-in-contract |
| D2 | EditorEmpty | segment «Все / Mia / Sofia / Elena» | filter drafts by avatar | `montages.list {avatarId?}` (K3); labels `AvatarSummary.name` | exists-but-shape-differs: the plan's `montages.list` requires `avatarId`; «Все» needs it optional |
| D3 | EditorEmpty | «Пустой ролик» | new empty draft | `montages.create {avatarId, photoIds: []}` | exists (which avatar under «Все»: AM1) |
| D4 | EditorEmpty | card «Фото для нового ролика ещё не выбраны», paragraph, steps «Откройте аватара», «Отметьте фото», ««Монтаж из выбранных»» | onboarding copy | — | preview-only |
| D5 | EditorEmpty | «Открыть фото Mia» | route to Photos | the renderer's last avatar (AM2) | preview-only |
| D6 | EditorEmpty | «Фото из «Отклонённых» в монтаж не попадают.» | rule copy | the one eligibility rule | exists |
| D7 | EditorEmpty | «Черновики · 5 · сохраняются сами» | count | K3 | missing-in-contract |
| D8 | EditorEmpty | card poster (first clip's cells, first caption) | thumbnail | `spec.clips[0]` cells via `studio-media://photo/…`; the caption is best omitted (a `textPreview` per card is too costly) | preview-only |
| D9 | EditorEmpty | «Mia · «кафе и город»», «Elena · без названия» | draft title | `AvatarSummary.name` + `Montage.name` | exists-but-shape-differs: an unnamed draft needs `name: null` (K1) |
| D10 | EditorEmpty | «сегодня, 14:02» | last save | `Montage.updatedAt` | exists |
| D11 | EditorEmpty | «9.6 с · 4 кадра · 3 текста», «без текста», «нет кадров» | summary | derived from `spec` | exists |
| D12 | EditorEmpty | tags «Mia», «♬ Espresso» | avatar and track | `spec.music.trackId` → `TrackSummary.title` (K23) | missing-in-contract |
| D13 | EditorEmpty | «Рендер 42 %» + bar | a render of this draft runs | `JobState` render with this `montageId`, `done / total` | exists |
| D14 | EditorEmpty | «✓ уже 2 видео из этого черновика» | videos made from this draft | `videoCount` per item (K3) | missing-in-contract (CF1) |
| D15 | EditorEmpty | «Кадр 2: фото отклонено — замените его, иначе рендер недоступен», amber border | a cell is no longer usable | K3 `issues` (`photo-unavailable` at `clips.1…`); wording from `PhotoSummary.rejected` | missing-in-contract |
| D16 | EditorEmpty | trash «Удалить черновик {name}» | delete the draft | `montages.delete` (K5); no confirmation drawn | missing-in-contract |
| D17 | EditorEmpty | «Открыть» | open the editor | `montages.get` (K2) | missing-in-contract |
| D18 | EditorEmpty | tile «Новый ролик · из фото аватара · бесплатно» | route to Photos | — | preview-only |
| D19 | EditorEmpty | the empty draft's dashed «+» poster | open | — | preview-only |

### 1.3 Editor header (`Editor*`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| H1 | Editor* | «Назад к фото» (icon) | back | — | preview-only |
| H2 | Editor*, EditorNew | «Mia · «кафе и город»», «Mia · новый ролик» | draft title | `AvatarSummary.name` + `Montage.name` | exists-but-shape-differs (K1: `null` → «без названия»; EditorNew's «новый ролик» should use the same placeholder) |
| H3 | Editor* | «Переименовать черновик» (pencil) | rename | `montages.save {name}` (K4) | missing-in-contract |
| H4 | Editor*, EditorNew | «черновик · сохранён 14:02», «черновик · создан только что» | save state | `Montage.updatedAt` + the renderer's save queue | exists (a failed save is not drawn) |
| H5 | Editor* | «Отменить» | undo | renderer history, ≤ 100 spec versions | preview-only |
| H6 | Editor* | «Повторить» | redo | same | preview-only |
| H7 | Editor* | «1080×1920 · 30 fps · 9.6 с · ≈ 2.9 МБ», EditorNew «… · 0 с» | output line | `FRAME_W/H`, `FPS`, `totalFrames`, `estimateBytes` (it gives «≈ 4.2 МБ» for 9.6 s; the mock's 2.9 is not the formula) | exists |
| H8 | Editor* | «Черновики» | route to the drafts list | K3 | preview-only |
| H9 | Editor | «Рендер» (ready) | queue a render | flush the pending save, then `videos.render {montageId}` → `{jobId, videoId}` | exists |
| H10 | Editor (render=blocked) | «Текст 2: только английский и эмодзи» + disabled «Рендер» | the first blocking reason | K19 `captionIssue` from the layer's last `montages.textPreview`; K7 `caption-invalid` from `montages.get` / at render | missing-in-contract |
| H11 | EditorNew | «Добавьте хотя бы один кадр» + disabled «Рендер» | no clips | `montageIssues(spec, "spec")` → `no-clips` | exists (K7 rewords `MONTAGE_ISSUE_MESSAGES_RU` to the artboards' «кадр») |
| H12 | Editor (render=nofolder) | «Папка «Готовые видео» недоступна · Настройки» | export folder unusable; link to Settings | `Snapshot.exportStatus` + live `export.status` (K9); reason texts `EXPORT_UNAVAILABLE_REASONS_RU` | exists-but-shape-differs: no live event on `main` |
| H13 | EditorMine | «Рендер · 42 %» + spinner | running | `JobState` render with this `montageId`, `floor(done / total × 100)` | exists |
| H14 | EditorMine | «Отменить рендер» (×) | cancel | `videos.cancel {jobId}`; disabled once `saving` | exists† |
| H15 | EditorGif | «Готово» | the job is done | `job.done` → `RenderResult` | exists |
| H16 | EditorGif | «Открыть в папке» | reveal the file | `videos.reveal {videoId}` (main-only) | exists |
| H17 | EditorGif | «Рендер» next to «Готово» | render again | `videos.render {montageId}`: refused `PHOTO_UNAVAILABLE` while the new video holds the photos | exists (CF1) |

### 1.4 Media panel tabs and the «Фото» tab (`Editor`, `EditorNew`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| P1 | Editor* | tab «Фото» | photo bin | `photos.list {avatarId}` | exists |
| P2 | Editor* | tab «Мои» | own media | `media.*` (K28, K29) | missing-in-contract (3f; «Скоро» until then) |
| P3 | Editor* | tab «Музыка» | trending tracks | `music.list` (K23) | missing-in-contract (3c) |
| P4 | Editor* | tab «GIF» | stickers | `STICKER_MANIFEST` (shared) + own (K28) | exists (built-ins) |
| P5 | Editor* | tab «Текст» | text presets and layers | `TextLayer` | exists |
| P6 | Editor, EditorNew | chip «Mia ▾» | the draft's avatar | `spec.avatarId`, fixed for the draft's life | exists-but-shape-differs: read-only, no dropdown (CF15) |
| P7 | Editor, EditorNew | chip «Неиспользованные 31» (toggle) | show free photos only | `eligible && !used && !reserved`; count `AvatarSummary.eligibleUnusedCount` | exists |
| P8 | Editor, EditorNew | chip «Все категории ▾» | category filter | `PhotoSummary.category` (`home`, `travel`, `shoot`, `glam`, `fit`) | exists |
| P9 | Editor, EditorNew | photo tile | an eligible scene photo | `photos.list`, `eligible` only; `studio-media://photo/<avatarId>/<photoId>` | exists |
| P10 | Editor | tile badge «1» / «2» / «4» | the clip holding the photo | derived from `spec.clips` | exists |
| P11 | Editor, EditorNew | tile «в 2 видео», dimmed | used photo | `PhotoSummary.usedIn.length` | exists (addable? CF1, Q1) |
| P12 | Editor | tile click | append a photo clip | push `{kind: "photo", clipId, durationMs, transitionIn: "cut", motion: "kenburns", cell: {photo: {source: "scene", photoId}, focus}}`; focus from K6; default length AM7 | exists (K6 missing) |
| P13 | Editor | tile dragged onto a collage cell in the preview, or onto the main track | replace a cell / insert a clip | `Cell.photo` + K6 / `clips` splice | exists |
| P14 | Editor | «Клик — кадр в конец ролика. Перетащите фото на ячейку коллажа в превью, чтобы заменить её.» | hint | — | exists |
| P15 | Components | «Не больше 20 кадров в одном видео. Клик по фото в панели ничего не добавит.» | clip cap | `MAX_CLIPS` | exists |

### 1.5 The «Мои» tab (`EditorMine`, `Components` drop zone)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| M1 | EditorMine | «Добавить файлы · фото, видео, музыка, стикеры · перетащите или нажмите» | open main's file dialog | main-only `media.pickImport {kind: "any"}` (K29) | missing-in-contract (text: CF8) |
| M2 | EditorMine | «Фото и видео · 5» | count | `media.list` (K28) | missing-in-contract |
| M3 | EditorMine | own photo / video tile | an own media item | `MediaSummary`; `studio-media://media/<mediaId>` | missing-in-contract |
| M4 | EditorMine | tile «▶ 0:06» | video length | `MediaSummary.durationMs` | missing-in-contract |
| M5 | EditorMine | tile badge «3» | the clip holding it | derived | exists |
| M6 | EditorMine | tile «40 %» + spinner | import in progress | import job (K29) | missing-in-contract |
| M7 | EditorMine | tile click / drag | add an own video clip or an own photo clip | `VideoClip {mediaId, trimStartMs: 0, durationMs, focus}` / `Cell.photo {source: "own", mediaId}` | exists (shape; refused `not-yet-supported` until 3f) |
| M8 | EditorMine | «Музыка · 2», row «summer-edit.mp3 · 0:42 · свой трек» | own track | `media.list {kind: "audio"}` | missing-in-contract |
| M9 | EditorMine | «Послушать summer-edit.mp3» | play | `<audio>` from `studio-media://media/<mediaId>` | preview-only |
| M10 | EditorMine | row «voice-note.m4a · 0:05 · короче ролика», dimmed, not selectable | too short for the montage | `durationMs < startMs + total`; render issue `track-too-short` (K7) | exists-but-shape-differs (no issue code on `main`) |
| M11 | EditorMine | own track row click | set the music | `music = {source: "own", mediaId, startMs: 0}` | exists (N9 until 3f) |
| M12 | EditorMine | «Стикеры · 3»: «mia-mono.png», «underline.gif», «new-badge.gif» | own stickers | `media.list {kind: "sticker"}`; layer `sticker: {source: "own", mediaId}` | missing-in-contract (PNG: CF20, Q5) |
| M13 | Components | «Отпустите — добавим 3 файла · 2 фото, 1 видео» | Finder drag-and-drop | — | not-in-plan (CF8) |
| M14 | Components | «Готовим street-walk.mp4 · HDR → SDR, 60 → 30 fps · 40 %» | import normalising | import job (K29), `MediaSummary.hdrToSdr` / `sourceFps` | missing-in-contract |
| M15 | Components | «track.flac не подходит · Музыка — mp3 или m4a. Остальные 2 файла добавлены.» | one file refused, others added | `MEDIA_UNSUPPORTED` + `mediaReason` (K30); multi-file result (K29) | missing-in-contract (CF10) |

### 1.6 The «Музыка» tab (`EditorMusic`, `Components`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| U1 | EditorMusic | «В тренде Instagram» | header | — | exists |
| U2 | EditorMusic | chip «Скрыть E» | hide explicit tracks | renderer filter on `TrackSummary.explicit`, default off | not-in-plan (harmless; the plan only says "visible with an «E» badge") |
| U3 | EditorMusic | «обновлено 27 сент., 14:02» | list age | `MusicStatus.listFetchedAt` (K24) | missing-in-contract |
| U4 | EditorMusic | row: cover, «Espresso», «Sabrina Carpenter», «2:55» | a track | `TrackSummary` (K23); `studio-media://cover/<trackId>` | missing-in-contract |
| U5 | EditorMusic | «E» on «Luther» | explicit | `TrackSummary.explicit` | missing-in-contract |
| U6 | EditorMusic | «★ 1:02» | first highlight | `TrackSummary.highlights[0].ms` (sorted ascending, likely-default last) | missing-in-contract (CF6) |
| U7 | EditorMusic | «✓ в ролике», accent row | the chosen track | `spec.music.trackId` | exists |
| U8 | EditorMusic | cover ▶ / ⏸, «▶ 0:34» | listen | `<audio>` from `studio-media://track/<trackId>` | preview-only |
| U9 | Components | hover «+» («в ролик»), row click | set the music | `music = {source: "trending", trackId, startMs: first highlight that fits, else 0}` | exists |
| U10 | EditorMusic | «оригинальный звук · dasha.daily · 0:07 · короче ролика», dimmed | too short | `TrackSummary.durationMs < total`; K7 `track-too-short` | exists-but-shape-differs |
| U11 | EditorMusic | «12 из 30 запросов в этом месяце» + bar | quota | `MusicStatus.sentLast31d` / `limit` (K24) | missing-in-contract (CF5) |
| U12 | EditorMusic | «Обновить · 1 запрос» | open the confirmation | — | preview-only |
| U13 | EditorMusic | «Список обновляется только по этой кнопке.» | copy | manual refresh only | exists |
| U14 | EditorMusic | «Обновить тренды?», «Спишется 1 запрос — останется 17 из 30 до 1 окт. Ошибка тоже считается, повторов нет.» | confirmation | `limit − sentLast31d − 1`; the date is `MusicStatus.nextFreeAt` | missing-in-contract (CF5) |
| U15 | EditorMusic | «Обновить · 1 запрос» (in the confirmation) | refresh | `music.refresh {confirm: true}` (K25) | missing-in-contract |
| U16 | EditorMusic | «Отмена» | close | — | preview-only |
| U17 | Components | «28 из 30 запросов в этом месяце», «Обновить · 1 из 2 оставшихся», «До 1 окт. осталось 2 запроса.» | near the limit | K24 | missing-in-contract (CF5) |
| U18 | Components | «30 из 30 …», disabled «Обновить», «Квота кончилась, новые запросы — с 1 окт. Список остаётся прежним.» | exhausted | `sentLast31d ≥ limit` or `serverRemaining = 0`; `nextFreeAt` | missing-in-contract (CF5) |

### 1.7 The «GIF» tab (`EditorGif`, `Components`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| G1 | EditorGif | chips «Все 20», «Блеск», «Сердца», «Стрелки», «Еда», «Погода» | category filter | `STICKER_CATEGORIES`: «Любовь», «Блеск», «Эмоции», «Природа», «Праздник», «Абстракция», «Указатели» | exists-but-shape-differs (CF11) |
| G2 | EditorGif | «Встроенные · 20» | count | `STICKER_MANIFEST.length` = 10 | exists-but-shape-differs (CF11) |
| G3 | EditorGif | sticker tile | a built-in sticker | manifest entry; `studio-media://sticker/<stickerId>` (3b.1) at `posterFrame` | exists |
| G4 | EditorGif | tile badge «1» | uses in this montage | derived | exists |
| G5 | EditorGif | selected tile ring | the selected layer's sticker | derived | exists |
| G6 | EditorGif | tile click | add a sticker layer at the playhead | `StickerLayer {sticker: {source: "builtin", stickerId}, …DEFAULT_STICKER, startMs: playhead}`; default length AM7 | exists |
| G7 | EditorGif | «Мои · 3» + «Добавить свой стикер» (+) | import | `media.pickImport {kind: "sticker"}` (K29) | missing-in-contract |
| G8 | EditorGif | own sticker tiles | own stickers | `media.list {kind: "sticker"}` | missing-in-contract |
| G9 | Components | tile «грузится» | thumbnail loading | — | preview-only |
| G10 | Components | «Не больше 10 стикеров в одном видео — уберите один, чтобы добавить другой.», tiles disabled | sticker cap | `MAX_STICKER_LAYERS` | exists |

### 1.8 The «Текст» tab (`EditorText`, `Components`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | EditorText | «Добавить текст в 4.1 с» | add a text layer at the playhead | `TextLayer` push (default value and length: AM7) | exists |
| T2 | EditorText | «Стили» presets: «Плашка · Manrope» («sunday reset»), «Обводка · Oswald» («coffee first»), «Без фона · Playfair» («golden hour»), «Без фона · Caveat» («slow morning»), «Плашка · PT Mono» («day 01»), «Обводка · Manrope» («wait for it») | add a styled layer | `TextLayer {font, style, color: the style's default}`; the sample is the initial `value` | exists |
| T3 | EditorText | «Слои · 3 из 10» | count | text layers / `MAX_TEXT_LAYERS` | exists |
| T4 | EditorText | rows «sunday reset ☀️ · 0.3–4.4 с» … | select a layer | `layers[i]` | exists |
| T5 | Components | disabled «Добавить текст», «Не больше 10 текстов в одном видео.», «Слои · 10 из 10» | text cap | `MAX_TEXT_LAYERS` | exists |

### 1.9 Preview (`Editor*`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| V1 | Editor* | 9:16 frame, 306 × 544 | preview surface | `FRAME_W / FRAME_H` | exists |
| V2 | Editor* | photo and collage cells, cropped and moving | the frame at the playhead | `clipAtFrame`, `collageRects`, `coverCrop`, `motionWindow`, `cellReveal` / `cellAlphaPermille`; the photo drawn with `image-orientation: none` so its size is the STORED size | exists |
| V3 | Editor | empty cell «перетащите фото» | empty cell | `Cell.photo = null` (legal in a draft) | exists |
| V4 | EditorMine | own video frame | video clip | `<video>` of the mezzanine at `trimStartMs` + clip time (3f.3b) | exists (3f) |
| V5 | Editor* | slide bars along the top | clip progress, preview only | `progressSegments`, `segmentFillWidth` | preview-only (constants: CF19) |
| V6 | Editor* | captions «sunday reset ☀️», «slow morning in lisbon», «coffee first ☕» | text exactly as rendered | the engine PNG from `montages.textPreview` (K20) at `studio-media://text/<previewId>`, placed by `textBox(layer, {w, h})` | missing-in-contract |
| V7 | EditorText | selected caption: dashed outline, two corner handles | move / resize | drag → `x, y` (centre); corner → `scale` | exists |
| V8 | Editor* | stickers «sparkle», «heart» | animated overlay in phase with the render | canvas + `ImageDecoder` (`colorSpaceConversion: "none"`); frame by the 30 fps tick mod `loopFrames` (own: by `delayFrames`) | exists (manifest) |
| V9 | EditorGif | selected sticker handles | move / resize | `x, y, size` | exists |
| V10 | EditorGif | selected sticker inside a zone: yellow dashed frame | zone warning | `zonesHit(stickerBox(layer), reelsSafeZones())` | exists |
| V11 | EditorNew | «Ролик пока пуст», «Кликните фото слева — оно станет первым кадром. Длина ролика — от 4 до 15 с.» | empty draft | `clips.length = 0` | exists |
| V12 | Editor* | bottom band with the pill «подпись и аудио», right band | Reels UI zones | `reelsSafeZones()`: bottom 20 %, right 15 % from 40 % to 80 % | preview-only |
| V13 | Editor | selected cell: dashed frame, face ring, pill «по лицу · тяните» | drag the crop | `Cell.focus {x, y}` | exists (a `null` focus: AM9) |
| V14 | Editor* | «Подсказки» switch «Зоны Reels» | toggle zones | renderer state | preview-only |
| V15 | Editor* | switch «Полоски слайдов» | toggle bars | renderer state | preview-only |
| V16 | Editor* | «только в превью, в видео их нет» | copy | — | preview-only |

### 1.10 Properties panel (`Editor*`)

Nothing selected:

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| R1 | Editor*, EditorNew | «Свойства · ничего не выбрано» / «· ролик пуст», «Выберите кадр, текст, стикер или музыку на таймлайне — здесь появятся их настройки.» | empty properties | — | exists |
| R2 | EditorNew | «Кадры · фото, коллаж 2–4 или своё видео · до 20», «Текст · английский и эмодзи · до 10 слоёв», «Стикеры · встроенные или свои · до 10», «Музыка · один трек из трендов на весь ролик» | limits | `MAX_CLIPS`, `MAX_TEXT_LAYERS`, `MAX_STICKER_LAYERS`, one `music` | exists |

A photo or collage clip (`Editor`, `sel = c2`):

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| R3 | Editor | «Кадр 2 из 4 · коллаж 3 · 2.4–5.6 с» | header | index, `layout`, `clipRanges` | exists |
| R4 | Editor | «Дублировать» | duplicate the clip | a copy with a new `clipId`; its scene photos cannot repeat | exists-but-shape-differs (CF4) |
| R5 | Editor | «Удалить» | remove the clip | `clips` splice | exists |
| R6 | Editor | «Раскладка»: «1 фото», «Коллаж 2», «Коллаж 3», «Коллаж 4» | switch the layout | `kind: "photo"` ↔ `kind: "collage", layout`; cells cut or padded with empty cells | exists |
| R7 | Editor | «Ячейки»: thumbs «1», «2», «3» (an empty one dashed) | pick a cell | `cells[i]`; the selection is renderer state | exists |
| R8 | Editor | tag «кадр по лицу» | the face was found | `Cell.focus !== null` | exists (the unresolved state is not drawn) |
| R9 | Editor | «Масштаб» slider 1.00–2.00, «1.15×» | per-cell zoom | — | not-in-plan (CF3, Q3) |
| R10 | Editor | «Фото уже кадрировано по лицу. Тяните его в превью, чтобы сдвинуть.» | copy | focus drag | exists |
| R11 | Editor | «Анимация»: «Ken Burns», «Панорама», «Статика» | motion | `motion`: `kenburns`, `pan`, `static` | exists |
| R12 | Editor | «Ячейки по очереди, шаг 0.3 с» switch, disabled for «1 фото» | stagger | `CollageClip.stagger`; the step in the label from `staggerStepFrames` (0.1 s on a 500 ms collage 4) | exists |
| R13 | Editor | «Длительность» slider + «3.2 с» | clip length | `durationMs`: 100 ms steps, ≥ 500, total ≤ 15 000 | exists |
| R14 | Editor | «ролик 9.6 с из 15 · кадр можно удлинить ещё на 5.4 с» | room left | `MAX_TOTAL_MS − total` | exists |

An own video clip (`EditorMine`, `sel = c3`):

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| R15 | EditorMine | «Кадр 3 из 4 · видео · 5.6–7.6 с» | header | | exists |
| R16 | EditorMine | «Обрезка» strip with handles, «1.8 → 3.8 с», «2.0 с из 6.4» | trim | `trimStartMs`, `durationMs`; the source length is `MediaSummary.durationMs` (K28); strip frames from `<video>` | missing-in-contract (source length) |
| R17 | EditorMine | «Кадр» «Масштаб» «1.00×» | zoom | — | not-in-plan (CF3, Q3) |
| R18 | EditorMine | «Видео уже 9:16 и занимает весь кадр. Тяните его в превью, чтобы сдвинуть.» | copy | `VideoClip.focus` | exists |
| R19 | EditorMine | «latte-pour.mov», «6.4 с · 1080×1920 · 60 → 30 fps», tags «свой файл», «HDR → SDR» | source facts | `MediaSummary {name, durationMs, width, height, sourceFps, hdrToSdr}` (K28) | missing-in-contract |
| R20 | EditorMine | «Звук видео не используется — в ролике только музыка» | V4 copy | — | exists |

A text layer (`EditorText`, `sel = t1`; error from `Components`):

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| R21 | EditorText | «Текст · слой 1 из 3 · 0.3–4.4 с» | header | | exists |
| R22 | EditorText | «Дублировать», «Удалить» | | a new `layerId` / splice | exists |
| R23 | EditorText | «Текст» textarea | the caption | `TextLayer.value` (`Caption`) | exists |
| R24 | EditorText | «15/60» | length | graphemes by `Intl.Segmenter` / `MAX_CAPTION_GRAPHEMES` (the mock counts code points) | exists |
| R25 | EditorText | «только английский · эмодзи можно · до 2 строк» | rules copy | caption rules | exists (CF14) |
| R26 | Components | «Только английский: буквы, цифры, знаки и эмодзи.» (`aria-invalid`) | inline caption error | `TEXT_INVALID` + `captionIssue` (K19) | missing-in-contract |
| R27 | EditorText | emoji chips ☀️ ☕ ✨ 💛 🌿 📍 🥐 | insert an emoji | into `value`; each must pass the CBDT reader's `has()` | exists |
| R28 | EditorText | «Стиль»: «Плашка», «Обводка», «Без фона» | style | `style`: `plaque`, `outline`, `none` | exists |
| R29 | EditorText | fonts «Playfair», «Manrope», «Oswald», «PT Mono», «Caveat» | font | `font` | exists |
| R30 | EditorText | «Размер» slider 40–160, «84» | size | `scale` 0.5–2, shown as `round(scale × TEXT_BASE_PX)` (K21) | exists-but-shape-differs (CF13) |
| R31 | EditorText | label «Плашка» (plaque) or «Цвет», swatches «Белый» #ffffff, «Почти чёрный» #111111, «Жёлтый» #ffd166, «Розовый» #ff9ec4, «Голубой» #9ad9ff, «Коралловый» #ff7a59 | colour | `TextLayer.color` | exists-but-shape-differs: the artboard colours the plaque (CF2, Q2) |
| R32 | EditorText | «Время 0.3 — 4.4 с» | range | `startMs` / `endMs`: 100 ms, ≥ 300, within the clips | exists |

A sticker layer (`EditorGif`, `sel = s2`):

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| R33 | EditorGif | «Стикер 2 из 2 · 6.0–9.6 с · петля» | header | | exists |
| R34 | EditorGif | «Дублировать», «Удалить» | | | exists |
| R35 | EditorGif | thumb, «heart», «встроенный · петля 1.2 с», tag «Сердца» | sticker facts | manifest `nameRu`, `loopFrames / 30` s, category `nameRu` | exists-but-shape-differs (English names, CF11) |
| R36 | EditorGif | «Размер» slider 5–50, «18 %» | size | `size` 0.05–0.6 | exists-but-shape-differs (CF12) |
| R37 | EditorGif | «Время 6.0 — 9.6 с» | range | `startMs` / `endMs` | exists |
| R38 | EditorGif | «Анимация идёт по кругу весь отрезок. Позицию и размер меняйте и в превью.» | copy | the loop spans the layer | exists |
| R39 | EditorGif | «Под кнопками Reels», «Стикер заходит в зону справа: в ленте его могут перекрыть лайки и комментарии.» | zone warning | `zonesHit` (AM10) | exists |
| R40 | EditorGif | «Сдвинуть внутрь» | move out of the zone | new `x, y` from `reelsSafeZones()` + `stickerBox` | exists |
| R41 | EditorGif | «Заменить стикер» | replace, keeping time and place | the `sticker` ref | exists |

The music (`EditorMusic`, `sel = music`):

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| R42 | EditorMusic | «Музыка · 0–9.6 с · весь ролик» | header | the track spans the montage | exists |
| R43 | EditorMusic | «Удалить» | remove the music | `music = null` | exists |
| R44 | EditorMusic | cover, «Espresso», «Sabrina Carpenter», «2:55 · тренд Instagram» | track facts | `TrackSummary` (K23) | missing-in-contract |
| R45 | EditorMusic | «Лучшая часть · от Instagram · 3» | highlight count | `TrackSummary.highlights.length` | missing-in-contract |
| R46 | EditorMusic | whole-track waveform, ★ marks, a window as long as the montage | pick the start | `music.peaks {startMs: 0, durationMs: track, bars: 68}` (K26) | missing-in-contract |
| R47 | EditorMusic | chips «★ 0:42», «★ 1:18», «★ 2:05» | set the start | `music.startMs = highlight.ms` (the data is K23) | missing-in-contract |
| R48 | EditorMusic | «0:42.0 → 0:51.6» | the used range | `startMs … startMs + total` | exists |
| R49 | EditorMusic | «Послушать» | listen to the range | `<audio>` from `startMs` for `total` | preview-only |
| R50 | EditorMusic | «Громкость выровняется при рендере сама. Трек длиннее ролика обрежется по его концу.» | copy | A5 peak safety | exists-but-shape-differs (wording: CF7) |
| R51 | EditorMusic | «Заменить трек» | go to the «Музыка» tab | | exists |

### 1.11 Timeline (`Editor*`, `Components`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| L1 | Editor* | «Воспроизвести» | play / pause | preview clock + `<audio>` | preview-only |
| L2 | Editor* | «00:04.1 / 00:09.6» | clock | playhead, total | preview-only |
| L3 | Editor* | «Разрезать по плейхеду» | split at the playhead | two clips or layers on the 100 ms grid | exists-but-shape-differs (CF4 for photo and collage clips) |
| L4 | Editor* | «Дублировать выбранное» | duplicate | new ids | exists-but-shape-differs (CF4) |
| L5 | Editor* | «Удалить выбранное» | delete | splice / `music = null` | exists |
| L6 | Editor* | «ролик 9.6 с · от 4 до 15 с» | total and bounds | `MIN_TOTAL_MS`, `MAX_TOTAL_MS` | exists |
| L7 | Editor* | «Уменьшить масштаб», slider «Масштаб таймлайна» 1–8, «Увеличить масштаб», «Уместить» | timeline zoom | renderer | preview-only |
| L8 | Editor*, Components | ruler «0 с» … «15 с» (tick 0.5 s, 0.25 s zoomed), dim labels and hatching after the end | time scale | renderer | preview-only |
| L9 | Editor* | «Текст 3» + «Добавить текст» | count + add at the playhead | `TextLayer` | exists |
| L10 | Editor* | «Стикеры 2» + «Добавить стикер» | count + open «GIF» | | exists |
| L11 | Editor* | «Кадры 4» + «Добавить кадр» | count + open «Фото» | | exists |
| L12 | Editor* | «Музыка» | track header | | exists |
| L13 | Editor*, Components | text blocks «T sunday reset ☀️», «T slow morning in lisbon», «T coffee first ☕» on two rows; while dragging «0.3 → 4.4 с»; edges snap to the playhead and clip bounds | select / move / trim | `startMs` / `endMs`; the rows are display packing; z-order is the array order (no control drawn) | exists |
| L14 | Editor*, Components | sticker blocks «sparkle · петля», «heart · петля» | same | `StickerLayer.startMs / endMs`; label from the manifest `nameRu` | exists |
| L15 | Editor*, Components | clip blocks: thumbnails, tag «коллаж 3» / «▶ видео», «2.4 с»; selected: accent border and handles | select / trim | `clips`, `durationMs` | exists |
| L16 | Components | clip «⚠ фото отклонено» | a cell is no longer usable | `issues` from K2; wording from `PhotoSummary` | missing-in-contract |
| L17 | Components | lifted clip + insertion line | reorder | `clips` order | exists |
| L18 | Editor* | «Добавить кадр в конец» (+ after the last clip) | open «Фото» | | exists |
| L19 | Components | disabled «+» («Добавить кадр: не больше 20»), amber header counts | caps | `MAX_*` | exists |
| L20 | Editor* | music block «★ 0:42 · Espresso · Sabrina Carpenter» + waveform | the track over the montage | `music.peaks {startMs, durationMs: total, bars: 72}` (K26), `TrackSummary` | missing-in-contract |
| L21 | Components | selected music block «★ 1:18» | select → properties | | exists |
| L22 | Editor*, Components | playhead; while dragging «4.1 с» | seek / scrub | `msToFrameFloor` | preview-only |
| L23 | EditorNew | «Перетащите фото или видео сюда» | empty main track: open «Фото», drop target | | exists |
| L24 | EditorNew | «Добавить музыку» | open «Музыка» | | exists |
| L25 | Components | caption «без музыки · видео получит тишину той же длины» | silence | `music = null` → a silent track (invariant 20) | exists |

### 1.12 Avatar videos (`AvatarVideos`, «Видео аватара»; card variants from `Components`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| A1 | AvatarVideos | avatar photo, «Mia», «124 фото · 31 не использовано · 18 видео» | header counts | `AvatarSummary.photoCount`, `eligibleUnusedCount`, `videoCount` | exists (usage unknown not drawn) |
| A2 | AvatarVideos, Photos | tabs «Фото», «История сцен», «Видео» | sections | «История сцен» is out of Stage 3 | not-in-plan for «История сцен» (CF18); the other two exist |
| A3 | AvatarVideos | «Новый монтаж» | empty draft for this avatar | `montages.create {avatarId, photoIds: []}` | exists |
| A4 | AvatarVideos | «Видео · 18 · 52 МБ · сначала новые» | count, size, order | `videos.list` length, Σ `bytes`, newest first | exists |
| A5 | AvatarVideos | «Все 18», «В работе 2», «С ошибкой 1» | filter | records + render jobs (AM5) | exists |
| A6 | AvatarVideos | «~/Studio/export/Mia» | the avatar's folder | `Settings.exportPath` + the first segment of any `relPath`, home masked | exists-but-shape-differs: unknown while the avatar has no video (K17 answers it) |
| A7 | AvatarVideos | «Папка «Готовые видео»» | open that folder | main-only `videos.revealFolder {avatarId}` (K17) | missing-in-contract |
| A8 | AvatarVideos | card poster (with the caption burnt in) | poster frame | `VideoSummary.hasPoster` + route `poster/<avatarId>/<videoId>` (K14) | missing-in-contract |
| A9 | AvatarVideos | pill «0:08» | length | `durationMs` | exists |
| A10 | AvatarVideos | «утро дома» | video title | `VideoSummary.title` (K12) | missing-in-contract |
| A11 | AvatarVideos | «29 сент., 11:04» | date | `createdAt` | exists |
| A12 | AvatarVideos | «8.0 с · 3 кадра · 2.4 МБ» | facts | `durationMs`, a clip count `VideoSummary` lacks, `bytes` | exists-but-shape-differs: relabel to «· N фото» from `photoCount` (no new field) |
| A13 | AvatarVideos | cover + «Birds of a Feather · Billie Eilish» (+ «E») | music | `VideoSummary.music {title, artist}`; the cover and «E» need `trackId` (K13) | exists-but-shape-differs |
| A14 | AvatarVideos | «без музыки» | silent | `music = null` | exists |
| A15 | AvatarVideos | running: pill «Рендер · 42 %», shimmer, «Рендер · кадр 121 из 288» + bar | a running render | `JobState` render (`avatarId`), `done / total` frames; title and facts from the draft (`montageId`) | exists |
| A16 | AvatarVideos | «Отменить» | cancel | `videos.cancel`; disabled once `saving` | exists† |
| A17 | AvatarVideos | queued: pill «В очереди», «в очереди · после 1 рендера» | queued, with position | `JobState` `queued` + the order of `Snapshot.jobs` (K10) | exists-but-shape-differs (the order is not promised on `main`) |
| A18 | AvatarVideos | «Убрать из очереди» | cancel a queued render | `videos.cancel` | exists |
| A19 | AvatarVideos | failed: pill «Не собралось», «Не собралось: трек больше недоступен. Фото остались свободными.» | a failed render | `JobState.error.code` → text; `TRACK_UNAVAILABLE` is a 3c code | missing-in-contract (planned 3c) |
| A20 | AvatarVideos | «Изменить» (failed) | open the draft | `montageId` | exists |
| A21 | AvatarVideos | «Повторить» | render again | `videos.render {montageId}` | exists |
| A22 | AvatarVideos | trash on the failed card | dismiss the card | renderer-local (AM6) | preview-only |
| A23 | AvatarVideos | «✓ в «Готовых видео»» | file present | `fileState: "present"` | exists |
| A24 | AvatarVideos | «Открыть в папке» | reveal | `videos.reveal` | exists |
| A25 | AvatarVideos | «Изменить» (done, file deleted) | open the source draft | `VideoSummary.montageId`; hidden when `null` | exists (re-render: CF1) |
| A26 | AvatarVideos | trash «Удалить видео 017» | ask to delete | — | preview-only |
| A27 | AvatarVideos | «Удалить видео? Файл в «Готовых видео» тоже удалится, 4 фото снова станут свободными.» | confirmation | `photoCount` | exists |
| A28 | AvatarVideos | «Удалить» (danger) | delete the video | `videos.delete {videoId, mode: "video"}` → `{fileDeleted, fileState}` | exists† |
| A29 | AvatarVideos | «Отмена» | close | — | preview-only |
| A30 | AvatarVideos | pill «Файл удалён», dimmed poster, «Файл удалён из «Готовых видео». Пока есть запись, 3 фото считаются занятыми.» | file missing | `fileState: "missing"`, `photoCount` | exists |
| A31 | AvatarVideos | «Удалить запись» | drop the record, free the photos | `videos.delete {videoId, mode: "record"}` | exists† |
| A32 | Components | draft card «Mia · «утро дома»», «черновик · 26 сент., 09:15», «✓ уже 2 видео из этого черновика», «Открыть» | a draft as a card | K3 | missing-in-contract |

### 1.13 Avatar photos (`Photos`, «Фото аватара»)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| F1 | Photos | «124 фото · 31 не использовано · 18 видео» | counts | `AvatarSummary` | exists |
| F2 | Photos | «Монтаж из выбранных · 3» | a draft from the selection | `montages.create {avatarId, photoIds}` in selection order | exists (disabled at 0 and above 20 not drawn) |
| F3 | Photos | tile checkbox «Выбрать для монтажа: Ванная, зеркало» | select | renderer selection; only `eligible` photos | exists |
| F4 | Photos | «Все / Неиспользованные / Отклонённые» | gallery filter | `PhotoSummary.used`, `reserved`, `rejected`, `eligible` | exists |
| F5 | Photos | Stage 2 run form: «Сколько фото» −/«20»/+, category chips «Дом 4» …, glamour hint, «Ракурсы» chips, «Тип кадра» bar and legend, model line | run form | `RunRequest`, `runs.estimate` | exists (Stage 2) |
| F6 | Photos | Stage 2 cost block: «Сцены ≈ $0.01», «20 × $0.05 ≈ $1.00», «Проверка возраста выкл.», «Ожидаемая ≈ $1.01», «Сгенерировать 20 фото · до $3.07» | estimate and start | `runs.estimate`, `runs.start` | exists (Stage 2) |
| F7 | Photos | Stage 2 «Сцены на проверку», «Пересоставить», «Изменить сцену N», «Перегенерировать сцену N» | scene review | no command; shipped disabled «Скоро» | not-in-plan (Stage 2 scope) |
| F8 | Photos | Stage 2 scene rows and tile statuses «лицо 0.86», «Рисуется · 14 с», «Проверка», «Отказ · повтор», «В очереди», «лицо не проверялось», «повтор» | run progress | Stage 2 run journal, `PhotoSummary.qa` | exists (Stage 2) |

### 1.14 Settings (`Settings`)

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| St1 | Settings | Stage 2 rows: «OpenRouter и расходы» (key, balance, budget, spend, reserves, «Сверить»), «Модели», «Автопроверка возраста на фото», «Сходство лица», «Параллельных генераций» | | Stage 2 `settings.*`, `money.*` | exists |
| St2 | Settings | «Параллельных рендеров · Авто / Вручную», «подобрано бенчмарком: 5 × 2 потока на 10 ядрах» | render pool | `Settings.renderConcurrency` («Авто» only; no set command in Stage 3) | exists-but-shape-differs (CF16) |
| St3 | Settings | «Кодировщик · x264 · качество / VideoToolbox · быстро», «VideoToolbox найден; у него нет CRF, файлы тяжелее» | encoder | — | not-in-plan (CF17) |
| St4 | Settings | «Библиотека · ~/Studio/library · Изменить» | library folder | `settings.setLibraryPath`; refused `IN_FLIGHT` while renders are queued or running | exists |
| St5 | Settings | «Готовые видео · ~/Studio/export», «здесь хранятся готовые видео · Studio держит у себя только запись о каждом», «Изменить» | export folder | `Settings.exportPath`; main-only `settings.setExportPath` (K18) | missing-in-contract |
| St6 | Settings | «Видео · 1080×1920 · 30 fps · CRF 20 · ≤ 3500 кбит/с» + hint | output facts | profile constants | exists |
| St7 | Settings | «Метаданные · движок» + hint | metadata policy | invariant 14 | exists |
| St8 | Settings | «Ключ RapidAPI · ••••••••7c1e · зашифрован системой» | key status | `Settings.musicKey {stored, last4, rejected}` | missing-in-contract (3c.2) |
| St9 | Settings | «Проверить» (RapidAPI) | check the key | — (a check would spend a request) | not-in-plan (Q4) |
| St10 | Settings | «Заменить» (RapidAPI) | set the key | main-only `settings.setMusicKey` (K27) | missing-in-contract (3c.2) |
| St11 | Settings | «Сентябрь · запросы · 12 из 30» + bar, «считаются и запросы с ошибкой» | quota | `MusicStatus.sentLast31d` / `limit` | missing-in-contract (CF5) |
| St12 | Settings | «Тренды Instagram · только вручную · обновлено 27 сент., 14:02 · 94 МБ» | list age, disk use | `MusicStatus.listFetchedAt`, `bytesOnDisk` | missing-in-contract |
| St13 | Settings | «Обновить · 1 запрос» → «Спишется 1 запрос — останется 17 из 30 до 1 окт. Ошибка тоже считается.», «Отмена», «Обновить · 1 запрос» | confirmed refresh | `music.refresh {confirm: true}` (K25) | missing-in-contract |

### 1.15 Legacy components on the sheet

| # | Artboard | Control / label | What it does | Maps to | Status |
| --- | --- | --- | --- | --- | --- |
| Cm1 | Components | «Шаблон монтажа»: «1 фото», «Коллаж 2», «Коллаж 3», «Слайды» | old template picker | superseded by R6; «Слайды» is now several photo clips | not-in-plan (legacy) |
| Cm2 | Components | «Плитка плана»: «Видео 30», «Из библиотеки 58», «Ожидаемая ≈ $1.01» | autopilot plan | Stage 4 | not-in-plan (Stage 4) |

---

## 2. States

### 2.1 States the artboards draw, mapped to the contract

| Artboard state | Where | Contract state |
| --- | --- | --- |
| Empty draft | EditorNew; draft card «нет кадров» | `clips.length = 0`; `no-clips` |
| Draft saved / just created | Editor* header | `Montage.updatedAt` + the renderer's save queue |
| Render ready | Editor | `montages.get` issues empty, `exportStatus.status = "ok"`, no unfinished render of this draft |
| Blocked: caption | Editor (render=blocked) | K19 `captionIssue` / K7 `caption-invalid` |
| Blocked: no clips | EditorNew | `no-clips` |
| Blocked: no export folder | Editor (render=nofolder) | `ExportStatus {status: "unavailable", reason}` |
| Running «Рендер · 42 %», «кадр 121 из 288» | EditorMine, AvatarVideos, EditorEmpty | `JobState {kind: "render", status: "running", done, total}` |
| Queued «в очереди · после 1 рендера» | AvatarVideos only | `status: "queued"` + order (K10) |
| Done «Готово · Открыть в папке» | EditorGif | `status: "done"`, `RenderResult`; `video.changed` upserted |
| Failed «трек больше недоступен» | AvatarVideos | `status: "failed"`, `error.code` (`TRACK_UNAVAILABLE`, 3c) |
| «✓ в «Готовых видео»» | AvatarVideos | `fileState: "present"` |
| «Файл удалён» | AvatarVideos | `fileState: "missing"` |
| Delete confirmation | AvatarVideos | before `videos.delete {mode: "video"}` † |
| Draft with a running render | EditorEmpty | a render `JobState` with this `montageId` |
| Draft with videos | EditorEmpty, Components | K3 `videoCount` (CF1) |
| Draft / clip with a rejected photo | EditorEmpty, Components | `photo-unavailable` in K2 / K3 issues + `PhotoSummary.rejected` |
| Bin: in the draft / used / free | Editor, Components | derived / `PhotoSummary.usedIn` / `eligible && !used && !reserved` |
| Caps reached | Components | `MAX_CLIPS`, `MAX_TEXT_LAYERS`, `MAX_STICKER_LAYERS` |
| Track too short | EditorMusic, EditorMine | K7 `track-too-short` |
| Track playing / in the montage / explicit | EditorMusic, Components | preview / `spec.music` / `TrackSummary.explicit` |
| Quota normal / confirm / near limit / exhausted | EditorMusic, Settings, Components | `MusicStatus` (K24) |
| Import in progress / normalising | EditorMine, Components | import job (K29) |
| Import refused | Components | `MEDIA_UNSUPPORTED` + `mediaReason` (K30) |
| Sticker thumbnail loading | Components | preview |
| Sticker in a Reels zone | EditorGif | `zonesHit` |
| Face found «кадр по лицу» | Editor | `Cell.focus !== null` |
| Caption error inline | Components | `TEXT_INVALID` + `captionIssue` (K19) |
| Engine offline | Components (Stage 2 section) | `INTERNAL` / `ENGINE_GONE_DETAIL` |

### 2.2 Contract states NO artboard draws (the designer must add them)

Render and jobs:
- **Queued, in the editor header** (only the videos tab draws it): e.g. «В очереди · после 1».
- **The «сохранение» phase** (`saving: true` †): Cancel disabled, e.g. «Сохранение…»; and the
  notice for a saving phase that never ends (the 3a.8b.2 backlog).
- **Failed, in the editor header**, with the text by error code and «Повторить».
- **Cancelled** (`job.cancelled`): the header returns to ready; the videos-tab card disappears.
- **"Done after failed"**: a `video.changed` upsert after `job.failed` wins (a late adoption);
  the failed card turns into the video.
- **The render answer timed out** but the job exists: show it from `job.*` / the snapshot.
- Refusals: `RENDER_QUEUE_FULL` †, `LIBRARY_TOO_NEW` †, `NOT_FOUND` (the draft was deleted),
  `PHOTO_UNAVAILABLE` for a **used or reserved** photo (only "rejected" is drawn).
- Render reasons beyond «нет кадров» and the caption: `duration-too-short` («короче 4 с»),
  `duration-too-long`, `cell-empty` (the preview draws the empty cell, the button no reason),
  `layer-outside-timeline` (a layer past the end after shortening clips), `not-yet-supported`
  (a «Скоро» part), `track-too-short`, `track-unavailable`, `media-unavailable`,
  `sticker-unavailable` (K7).
- Job failure texts other than the track: `RENDER_FAILED`, `RENDER_VERIFY_FAILED`,
  `EXPORT_UNAVAILABLE` mid-render.
- `EXPORT_UNAVAILABLE` per reason (only a generic line is drawn): `missing`, `not-a-directory`,
  `not-writable`, `not-enough-space`, `overlaps-library`, `newer-marker`, `invalid-marker`
  (for a root that already has records it must never suggest deleting the marker).

Video records:
- `fileState: "changed"` («файл изменён вне Studio»: playable, used, «Удалить запись»; «Удалить»
  keeps the file).
- `fileState: "elsewhere"` («файл в другой папке»: no playback, no «Открыть в папке», «Удалить
  запись» with the Q6 wording).
- `"unchecked"` (K15, «не удалось проверить файл»).
- The delete result `fileDeleted: false` («файл оставлен в папке») †.
- Playback of a `present` (and `changed`) video: the plan's 3e.2 lists "play"; no card has a
  play control or a player.
- An empty «Видео» tab.
- **Usage unknown** (`AvatarSummary.usage`, K16) with «Убрать повреждённую запись» and
  «Восстановить отметки»; it also covers `index-stale` and records hidden by `LIBRARY_TOO_NEW`.

Drafts and photos:
- A failed save (`LIBRARY_UNAVAILABLE`, `NOT_FOUND`); the open draft deleted elsewhere
  (`montage.changed` removed).
- The draft-delete confirmation.
- «Монтаж из выбранных» busy (create resolves focus for up to ~30 s), disabled at 0 and above 20
  with the reason.
- Focus detection in progress on a placed photo; focus not found (`null`, drawn at the fallback
  point).
- A **reserved** photo (in a queued or running render) in the bin and the gallery.
- Reject / restore on a gallery tile (`photos.setRejected`), the rejected tile's look, and the
  used badge in the gallery's «Все».
- An empty bin (no eligible photo), `photos.list.skippedTotal`, `LIBRARY_UNAVAILABLE`.

Text:
- The caption preview pending (the engine PNG is debounced).
- Caption issues other than the charset (K19): an emoji the font lacks, a text-style emoji
  (VS15), a youth word, a youth emoji, an age number, over 60 characters, over 2 lines, © ® ™
  (refused, owner 2026-09-30).
- A rasteriser timeout (`RENDER_FAILED`, «уменьшите размер или смените стиль»).

Music:
- No RapidAPI key (`MUSIC_KEY_MISSING`) in the tab and in Settings; a rejected key
  (`musicKey.rejected`, `MUSIC_KEY_REJECTED`).
- Refresh running (≈ 50 MB of downloads) and refresh failed (`MUSIC_UNAVAILABLE`, network).
- Never refreshed / empty list; the server's `remaining = 0` while the local count is below 30.
- The chosen track became unavailable, or too short after the montage grew: a state of the music
  block and the music properties.

Own media (3f) and N9:
- Every N9-gated control disabled «Скоро» until its slice lands: the «Мои» tab (3f), and the
  text, sticker and music parts until 3b / 3c lift N9.
- HEIC refused with «сохраните как JPEG» (V3); the other `MEDIA_UNSUPPORTED` reasons (over 3 min,
  over 2 GB, over 4K, WebM / VP9 / AV1, animated WebP, a side under 2 px, a sticker loop over
  300 frames).
- Import cancel; deleting own media (`media.delete`), including media a draft uses; own media
  missing in a draft (`media-unavailable`).
- A sticker that is no longer available (`sticker-unavailable`).

Settings and the export folder:
- The switch result «N видео остались в прежней папке» (`elsewhere` count, K18).
- The export folder unavailable, with its reason, in Settings.

Controls the plan requires that no artboard draws:
- **Z-order** of layers (3d.3b: "z-order"); the two text rows are only packing.
- **Split evenly** (3d.3a, `splitEvenly`): no control.
- A **play** control for a finished video (3e.2).
- Reject / restore on a Photos tile (3e.2).

---

## 3. Gaps as contract changes

Ordered by the task that needs them first. Batch A goes into the next contract task (3d.1a) and
bumps the protocol **5 → 6**. Every new field follows the house style: strict objects, bounded
arrays, closed enums, no user text in errors (Russian lives in `errorMessagesRu.ts`).

**Prerequisite (in flight, 3a.8b.2 †):** `saving?: boolean` on the render `JobProgress` and
`JobState`; `RENDER_QUEUE_FULL` (limit in `detail`); `LIBRARY_TOO_NEW`; `videos.delete {videoId,
mode: "video" | "record"}` → `{videoId, fileDeleted, fileState}`. Blocks 3d.6 and 3e.2. Merge
first.

### Batch A — with 3d.1a (drafts)

| K | Change | Blocks |
| --- | --- | --- |
| K1 | `Montage.name`: `MontageName.nullable()`. `montages.create` stores `null`; the UI shows «без названия» (EditorNew's «новый ролик» aligns to it). | 3d.1a, 3d.2 |
| K2 | `montages.get {montageId}` → `{montage: Montage, issues: MontageIssue[] (0..64)}`. `issues` = `montageIssues(spec, "spec")` plus the engine's referential issues (K7), so the Render reason and the cell highlights are the engine's verdict. Errors: `NOT_FOUND`, `LIBRARY_UNAVAILABLE`. | 3d.1a, 3d.2, 3d.6 |
| K3 | `montages.list {avatarId?: Id}` → `{items: {montage: Montage, issues: MontageIssue[] (0..64), videoCount: Count}[] (≤ MAX_LISTED_MONTAGES = 200), total: Count}`, newest `updatedAt` first. No `avatarId` = every avatar (the drafts screen's «Все»). Reuses `Montage` instead of a new summary shape. | 3d.1a, 3d.2 |
| K4 | `montages.save {montageId, spec: MontageDraft, name: MontageName \| null}` → `{montage: Montage}`. `spec.avatarId` must equal the stored draft's (`VALIDATION` otherwise); no referential check (a draft may hold a rejected photo); `NOT_FOUND` for a deleted draft. Saves stay serialised in the renderer, latest wins. | 3d.1a, 3d.2 |
| K5 | `montages.delete {montageId}` → `{montageId}`. Allowed while a render of it is queued or running (the job keeps its spec; its record then lists `montageId: null`). | 3d.1a, 3d.2 |
| K6 | `montages.focus {avatarId, photo: PhotoRef}` → `{focus: Focus \| null}`. `null` = not resolved: the draft stores `null` and the preview draws `FOCUS_FALLBACK`. ≤ 20 s; `NOT_FOUND`, `PHOTO_UNAVAILABLE`. The plan's `{photoId \| mediaId}` needs `avatarId` because the focus cache is per avatar. | 3d.1a, 3d.3a, 3d.4 |
| K7 | `MONTAGE_ISSUE_CODES` gain five engine-only codes (like `photo-unavailable`, never produced by the shared code): `caption-invalid` (`layers.i.value`), `media-unavailable` (an own media id missing or of the wrong kind: `clips.i`, `clips.i.cells.j`, `music`, `layers.i.sticker`), `sticker-unavailable` (`layers.i.sticker`), `track-unavailable` (`music`), `track-too-short` (`music`: shorter than `startMs + total`). Russian texts added, and the existing `MONTAGE_ISSUE_MESSAGES_RU` reworded from «клип» to the artboards' «кадр». | 3d.1a (get/list), 3d.3b, 3d.6, 3f.* |
| K8 | Event `montage.changed`: `{change: "upserted", montage: Montage}` or `{change: "removed", montageId, avatarId}` (the `video.changed` pattern). | 3d.1a, 3d.2 |
| K9 | Event `export.status` `{exportStatus: ExportStatus}`, **pulled forward from 3e.3**: the Render button's «Папка … недоступна» must follow the disk live, not a snapshot. | 3d.6, 3e.3 |
| K10 | Doc-only: `Snapshot.jobs` lists jobs in submission order, so «после N рендеров» is derivable. | 3d.6, 3e.2 |
| K11 | Doc + tests: `montages.create` refuses a photo that is not eligible, or is used or reserved, with `PHOTO_UNAVAILABLE`, issues at `["photoIds", i]` (so the Photos screen can mark the tiles). | 3d.1a, 3d.2 |

### Batch B — with 3e.2 / 3e.3 (videos tab, export folder)

| K | Change | Blocks |
| --- | --- | --- |
| K12 | `VideoSummary.title: MontageName \| null`: the draft's name at render time, stored in the record (records are loose schema v1; older ones read `null`). The card keeps its name after the draft is deleted. | 3e.2 |
| K13 | `VideoSummary.music.trackId: Id \| null` (`null` for own music): the tile's cover (`cover/<trackId>`) and «E» from `music.list`. | 3e.2 |
| K14 | Media route `poster/<avatarId>/<videoId>` added to invariant 28 (3b.1's route list): `hasPoster` exists but nothing serves it. | 3e.2 (via 3b.1 / 3e.1) |
| K15 | `FileState` gains `"unchecked"`: the file could not be checked on this read. Replaces 3a.8b.2's "an unchecked record reads `elsewhere`", which the pending notes want told apart («не удалось проверить файл»). | 3e.2 |
| K16 | `AvatarSummary.usage`: `{state: "ok"}` or `{state: "unknown", reason: "record-unreadable" \| "rejects-unreadable" \| "index-stale" \| "library-too-new"}`; commands `videos.quarantineRecords {avatarId}` («Убрать повреждённую запись») and `photos.rebuildRejected {avatarId}` («Восстановить отметки»). Already assigned to 3e.2 by the plan; shape proposed. | 3e.2 |
| K17 | Main-only `videos.revealFolder {avatarId}` → `{opened: "avatar" \| "root"}`: opens `<exportRoot>/<SafeName>`, or the root when the avatar has no folder yet; `EXPORT_UNAVAILABLE` otherwise. | 3e.2 |
| K18 | Main-only `settings.setExportPath {}` (main's own dialog) → `{picked: false}` or `{picked: true, settings: Settings, rootId: Id, resolved: Count, elsewhere: Count}`. | 3e.3 |

### Batch C — with 3b (text and stickers)

| K | Change | Blocks |
| --- | --- | --- |
| K19 | Error code `TEXT_INVALID` with a required `captionIssue` (on `TEXT_INVALID` only, like `exportReason`): `charset \| emoji-missing \| emoji-text-style \| youth-word \| youth-emoji \| age-number \| too-long \| too-many-lines`. `CAPTION_ISSUES_RU` holds the texts; `charset` names © ® ™ explicitly. | 3d.5, 3d.6 |
| K20 | `montages.textPreview {avatarId, layer: TextLayer}` → `{previewId, width, height}` (raster px at the 1080 scale, for `textBox`). `avatarId` because the number rule reads the avatar's age. `TEXT_INVALID` (K19); a rasteriser timeout is `RENDER_FAILED`. | 3d.4, 3d.5 |
| K21 | A shared constant `TEXT_BASE_PX` in `studio/shared/montage/` (the rendered size at `scale` = 1), so «Размер» shows `round(scale × TEXT_BASE_PX)`. | 3d.5 |
| K22 | **Removal:** drop `stickers.list` from the plan. The renderer imports `STICKER_MANIFEST` / `STICKER_CATEGORIES` (pure, shared); own stickers come from `media.list`. | 3d.5 (unblocks) |

### Batch D — with 3c (music)

| K | Change | Blocks |
| --- | --- | --- |
| K23 | `TrackSummary {trackId, title (1..120), artist (1..120) \| null, durationMs, explicit: boolean, highlights: {ms, likelyDefault: boolean}[] (≤ 8; ascending, the likely `1500` default last), hasCover: boolean}`; `music.list {}` → `{tracks: TrackSummary[] (≤ 100)}`. | 3d.5, 3d.3b, 3d.2 (draft tags) |
| K24 | `MusicStatus {listFetchedAt: IsoDateTime \| null, trackCount, bytesOnDisk, sentLast31d (0..30), limit: 30, serverRemaining: Count \| null, nextFreeAt: IsoDateTime \| null, refresh: {state: "idle"} \| {state: "running", done, total} \| {state: "failed", error: EngineError}}`; `music.status {}` → `MusicStatus`; event `music.changed {status}`. `Settings.musicKey` keeps `{stored, last4, rejected}` only, so the quota has one source. `nextFreeAt` = when the oldest send leaves the 31-day window. | 3c.6, 3d.5 |
| K25 | `music.refresh {confirm: true}` answers at once `{status}` with `refresh.state = "running"`; the downloads report through `music.changed`. A refresh (≈ 50 MB) outlives main's 30 s command deadline. Errors: `MUSIC_KEY_MISSING`, `MUSIC_KEY_REJECTED`, `MUSIC_QUOTA_EXHAUSTED`, `MUSIC_UNAVAILABLE`, `IN_FLIGHT` (one at a time). | 3c.6, 3d.5 |
| K26 | `music.peaks {track: {source: "trending", trackId} \| {source: "own", mediaId}, startMs, durationMs, bars (16..256)}` → `{peaks: int[] (0..1000, length = bars)}`. One command serves the timeline block (the montage window, 72 bars) and the highlight picker (the whole track, 68 bars). | 3d.3b, 3d.5 |
| K27 | Main-only `settings.setMusicKey {key}` and `settings.clearMusicKey` as planned (3c.2), with **no** separate check command (Q4). | 3c.6 |

### Batch E — with 3f (own media)

| K | Change | Blocks |
| --- | --- | --- |
| K28 | `MediaKind = "photo" \| "video" \| "audio" \| "sticker"`; `MediaSummary {mediaId, kind, name (SafeText, ≤ 120, the display name only), bytes, createdAt, width \| null, height \| null, durationMs \| null, sourceFps \| null, hdrToSdr: boolean, loopFrames \| null, delayFrames: int[] \| null}`; `media.list {kind?}` → `{media: MediaSummary[] (≤ 500)}`; `media.delete {mediaId}`; event `media.changed`. | 3f.1, 3f.3b, 3f.6, 3d.5 («Мои») |
| K29 | Main-only `media.pickImport {kind: MediaKind \| "any"}` (a multi-select dialog; `"any"` for the one drop zone) → `{picked: false}` or `{picked: true, jobIds: Id[] (1..20), refused: {name, reason: MediaUnsupportedReason}[]}`; `JobKind` gains `import` (`{jobId, mediaKind, name, mediaId \| null}`, `done / total`); `media.cancelImport {jobId}`. | 3f.1, 3f.6 |
| K30 | `MEDIA_UNSUPPORTED` with a required `mediaReason`: `heic \| format \| too-large \| too-long \| dimensions \| too-small \| animated-webp \| codec \| not-animated \| loop-too-long`; Russian texts (`heic` → «сохраните как JPEG»). | 3f.1–3f.5, 3f.6 |

---

## 4. Conflicts with fixed decisions

### 4.1 Compliance with the fixed decisions

| Decision | Artboards | Verdict |
| --- | --- | --- |
| Caps 20 clips / 10 text / 10 stickers | «до 20», «до 10 слоёв», «до 10», the caps section, «3 из 10» | consistent |
| 4.0–15.0 s | «от 4 до 15 с», ruler 0–15 s, «кадр можно удлинить ещё на …» | consistent |
| Hard cuts only (V1) | «Между кадрами только резкая смена» | consistent |
| No fades; the track's own level (A5) | «громкость и затухания не настраиваются» | wording conflict (CF7) |
| Emoji supported (Noto) | emoji chips, captions with emoji | consistent |
| © ® ™ not supported | none shown | consistent; the charset error must name them (K19) |
| Progress bars preview-only | «только в превью, в видео их нет» | consistent; geometry differs (CF19) |
| Motion kinds | «Ken Burns / Панорама / Статика»; own video static; no direction control | consistent |
| Collage 2–4, 58 % top row, 12 px gap | «Коллаж 2 / 3 / 4», `TOP = H × 0.58`, 3 px at 306 | consistent |
| Stagger `min(300 ms, d / (n + 1))` | «шаг 0.3 с» fixed text | consistent if the label is computed |
| Safe zones: bottom 20 %, right 15 % at 40–80 % | same numbers; warning only | consistent (AM10) |
| A scene photo once per montage | split / duplicate of photo clips | CF4 |
| "Used" from records; reserved photos (S16) | reuse across videos | CF1 |

### 4.2 The conflicts

| # | Conflict | Artboards | Recommendation |
| --- | --- | --- | --- |
| CF1 | **One photo in several videos.** The queued «кафе и город · 2» of the same draft, «✓ уже 2 видео из этого черновика», «Рендер» enabled next to «Готово», and bin tiles «в 2 видео» that look addable. The built engine refuses a used or reserved photo at render (3a.8b.2's used check, S16). | AvatarVideos, EditorEmpty, EditorGif, Editor, Components | **Ask the owner (Q1).** Until then follow the engine. |
| CF2 | **Text colour.** The artboard colours the plaque for «Плашка» (text auto #111111 / #ffffff) and flips the outline or shadow to light for a dark text; the Text row says `color` is the text colour in every style, the plaque stays white and the outline black. | EditorText, Components | **Ask the owner (Q2).** |
| CF3 | **Zoom** «Масштаб 1.00–2.00×» on collage cells and own video. 3a.1: "Not in v1: per-cell zoom". | Editor, EditorMine | **Ask the owner (Q3).** Default: drop the sliders. |
| CF4 | **Split / duplicate a photo or collage clip** repeats scene photos: `photo-repeated` applies to drafts too, so the save is refused. | Editor* toolbar, properties | **Follow the plan:** «Разрезать» disabled for photo and collage clips (enabled for video clips and layers); «Дублировать» copies layout, length, motion and stagger with empty cells. |
| CF5 | **Quota wording** «в этом месяце», «Сентябрь · запросы», «до 1 окт.», «новые запросы — с 1 окт.» against the 31-day rolling window. | EditorMusic, Settings, Components | **Follow the plan:** «12 из 30 за 31 день»; the date is `nextFreeAt` («следующий освободится 3 окт.»). |
| CF6 | Highlight chips «в порядке Instagram» against ascending order with the `1500` default last. | Components | **Follow the plan.** |
| CF7 | «Громкость выровняется при рендере сама» against A5 (the level is kept; only peaks are attenuated). | EditorMusic | **Follow the plan:** e.g. «Громкость трека не меняется, при рендере приглушаются только пики». |
| CF8 | **Finder drag-and-drop** («перетащите», «Отпустите — добавим 3 файла») against the plan: the drop zone opens main's dialog. | EditorMine, Components | **Follow the plan:** «Добавить файлы · … · нажмите, чтобы выбрать»; no drop state. |
| CF9 | **HEIC own photos** shown as imported («IMG_2041.heic», «IMG_2044.heic») against V3. | EditorMine | **Follow the plan:** JPEG names; draw the refusal «сохраните как JPEG». |
| CF10 | «track.flac не подходит · Музыка — mp3 или m4a» against the own-music formats (mp3, m4a/aac, wav, flac, alac, ogg, opus). | Components | **Follow the plan:** a truly refused example (e.g. `.wma`) and the full list. |
| CF11 | **Built-in stickers:** 20 tiles, categories «Блеск / Сердца / Стрелки / Еда / Погода / Эмоции», English names, against the committed manifest (10 stickers, 7 categories, Russian names; plan 8–12). | EditorGif | **Follow the plan:** chips and names from `STICKER_CATEGORIES` / `STICKER_MANIFEST`. |
| CF12 | Sticker size slider 5–50 % against `size` 0.05–0.6. | EditorGif | **Follow the contract:** 5–60 %. |
| CF13 | Text size slider 40–160 against `scale` 0.5–2. | EditorText | **Follow the contract:** the slider moves `scale`, the label shows `round(scale × TEXT_BASE_PX)` (K21). |
| CF14 | «до 2 строк» in a two-row textarea invites manual line breaks; a newline is a control character and `Caption` refuses it. | EditorText | **Follow the plan:** Enter inserts nothing; the engine wraps to ≤ 2 lines; hint «строки переносятся сами, до 2». |
| CF15 | Bin avatar chip «Mia ▾» as a dropdown against one avatar per montage (`spec.avatarId`, eligibility). | Editor, EditorNew | **Follow the plan:** a read-only chip. |
| CF16 | «Параллельных рендеров · Авто / Вручную · подобрано бенчмарком» against «Авто» only (cores + memory; benchmark in Stage 4). | Settings | **Follow the plan:** «Авто» with «Вручную» disabled «Скоро»; hint from the formula. |
| CF17 | «Кодировщик · x264 / VideoToolbox» against x264 only. | Settings | **Follow the plan:** x264; VideoToolbox «Скоро». |
| CF18 | «История сцен» tab, out of Stage 3. | Photos, AvatarVideos | **Follow the plan:** hidden or «Скоро». |
| CF19 | Slide bars: ≈ 36 px margins, ≈ 10 px tall, ≈ 14 px gap at 1080 and equal widths, against the shared 24 / 24 / 6 / 6 with proportional widths ("constants pending the designer"). | Editor*, Components | **Follow the plan's model** (proportional) and take the designer's constants into `segments.ts`, even-rounded: 36 / 36 / 10 / 14. Preview-only, so the designer may still choose equal widths without an engine change. |
| CF20 | Own sticker «mia-mono.png» reads as a still logo; own stickers are GIF / APNG only (the validator refuses `NOT_ANIMATED`). | EditorMine, EditorGif | **Ask the owner (Q5).** Default: GIF / APNG only. |

### 4.3 Ambiguities and best readings

| # | Where | Ambiguity | Best reading |
| --- | --- | --- | --- |
| AM1 | EditorEmpty «Пустой ролик» | Which avatar when the filter is «Все»? | Enabled only with one avatar selected; under «Все» it opens a small avatar picker. |
| AM2 | EditorEmpty «Открыть фото Mia» | Which avatar? | The last avatar the owner worked with (renderer state); hidden when none. |
| AM3 | EditorEmpty hint card | When is it shown? | Always at the top of the drafts screen; it is the "how to start" card, not an error. |
| AM4 | Sidebar «Рендер 2 / 5» | What are a and b? | b = renders submitted since the queue was last empty (queued + running + ended), a = those ended. |
| AM5 | AvatarVideos «С ошибкой» | Failed jobs, or also file problems? | Failed render jobs only; `missing` / `changed` / `elsewhere` records stay under «Все». |
| AM6 | AvatarVideos failed-card trash | Delete what? | Dismiss the card (renderer-local; it can reappear after a window reload until `KEEP_FINISHED` evicts the job). |
| AM7 | Adding a clip, text or sticker | Default length and text are not drawn. | Clip: `min(2.0 s, room)`, refused below 0.5 s of room; layer: from the playhead for `min(3.0 s, total − playhead)`, ≥ 0.3 s; «Добавить текст» uses the first preset with a neutral sample value. |
| AM8 | Music start | Only highlight chips are drawn; the waveform window is `aria-hidden`. | The window is also draggable in 100 ms steps (`startMs` is any whole ms, N16); chips are quick picks. |
| AM9 | Focus ring when `focus = null` | Not drawn. | Draw the ring at `FOCUS_FALLBACK` with «лицо не найдено»; dragging stores a real focus. |
| AM10 | Zone warning | Only for stickers and only while «Зоны Reels» is on. | Show it for stickers **and** text whenever the box hits a zone; the switch only hides the stripes. |
| AM11 | Text rows on the timeline | Two text rows: z-order or packing? | Packing only; z-order is the array order and needs its own control (not drawn). |
| AM12 | Video card «Изменить» | Edit the video, or its draft? | Opens the source draft; see Q1 for what a re-render may do. |

---

## 5. Open questions for the owner

**All six were answered on 2026-09-30** (the owner's answers and the accepted defaults are summarised at the top of this document). The text below is kept as the record of what was asked.

Only product decisions. Each has a recommended default that the UI tasks build until he answers.

**Q1. Can one scene photo appear in more than one video?** — **ANSWERED (the owner, 2026-09-30): no reuse.** One photo, one video; the default below stands.
The artboards assume yes (a second render of the same draft, «уже 2 видео из этого черновика»,
«Рендер» again after «Готово», used photos addable). The engine refuses a used or reserved photo,
so a photo lives in at most one video; that is what keeps Stage 4's "unused" pool honest.
**Recommended default: no reuse (as built).** Used photos stay visible in the bin, dimmed «в
видео», and cannot be added; «Монтаж из выбранных» cannot take them; after «Готово» the Render
button is blocked with «Фото уже в видео «…» — замените их или удалите то видео»; «Изменить» on a
video opens its draft, and a re-render needs new photos or the old video deleted first. If the
owner says yes, the engine drops the used check from `videos.render` (reserved stays), and the
artboards stand.

**Q2. What does the colour choose for «Плашка»?** — **ANSWERED (the owner, 2026-09-30): the artboard's model.** `color` paints the plaque; the text is black or white by contrast.
Artboard: the plaque's colour, with the text switching to #111111 or #ffffff for contrast; a dark
text colour also flips the outline or shadow to light. Plan: the text colour, with the plaque
always white and the outline always black. **Recommended default: the artboard's model** (it is
Instagram's own text tool, and it cannot produce white-on-white or black-on-black). It keeps the
one `color` field and its default (#ffffff plaque → #111111 text looks the same as the plan's
default); only the field's meaning for «Плашка» changes, before 3b.4b builds the styles.

**Q3. A zoom slider for collage cells and own video («Масштаб 1.00–2.00×»)?** — **ANSWERED (default accepted, 2026-09-30): not in Stage 3.**
**Recommended default: not in Stage 3.** Keep dragging the crop by the face point. A 2× zoom on a
1K scene photo leaves about half its pixels for a 1080-wide frame, and the `zp4` canvas cap
interacts with it. It can come later as an optional `zoom` with a default of 1.0.

**Q4. «Проверить» for the RapidAPI key.** — **ANSWERED (default accepted, 2026-09-30): no «Проверить».**
Every flashapi request counts toward the 30 per 31 days, so a check is not free.
**Recommended default: no «Проверить».** The key's state comes from the last refresh (a 401 shows
«ключ отклонён»); «Заменить» and «Удалить» stay.

**Q5. Still PNG own stickers (a logo)?** — **ANSWERED (default accepted, 2026-09-30): GIF / APNG only.**
The mock's «mia-mono.png» reads as a still. The plan allows GIF and APNG only; the pipeline could
overlay a still. **Recommended default: GIF / APNG only in Stage 3.**

**Q6. «Удалить запись» for a video in another folder (`elsewhere`).** — **ANSWERED (the owner, 2026-09-30): allowed, with the confirmation below.**
3a.8b.2 lets «Удалить запись» drop the record in any state, which frees the photos while the MP4
still lives in the old folder. **Recommended default: allow it, with the confirmation «Файл
останется в прежней папке, а фото снова станут свободными».**

---

## 6. Per-task UI checklists

What each of the next UI tasks must implement from the artboards. «Скоро» means disabled with
that title until the slice lands (N9).

### 3d.2 — the editor shell

- **Routes.** Sidebar «Монтаж» → the drafts screen; Photos «Монтаж из выбранных · N» →
  `montages.create {avatarId, photoIds}` in selection order (disabled at 0 and above 20, with the
  reason; a busy state while focus resolves, up to ~30 s; `PHOTO_UNAVAILABLE` marks tiles by
  `["photoIds", i]`, K11); «Видео» tab «Новый монтаж» → `montages.create {photoIds: []}`;
  «Изменить» → the draft by `montageId`.
- **Drafts screen** (`EditorEmpty`): «Монтаж», «N черновиков · M рендер идёт»; the avatar
  segment «Все / …» (K3); «Пустой ролик» (AM1); the hint card with its three steps and «Открыть
  фото …» (AM2); «Черновики · N · сохраняются сами»; draft cards (poster from the first clip,
  `Avatar · «name»` or «без названия», date, «T с · N кадров · K текстов», tags, render progress,
  «✓ …» and «Кадр N: …» notes from K3, «Открыть», delete with a confirmation); the «Новый ролик»
  tile.
- **Editor frame:** header («Назад», name + «Переименовать черновик» → `montages.save {name}`,
  save label «черновик · сохранён HH:MM» / «сохраняется…» / a failed save with a retry), undo /
  redo (≤ 100 spec versions, ⌘Z / ⇧⌘Z), «1080×1920 · 30 fps · T с · ≈ X МБ» from
  `estimateBytes`, «Черновики», and the Render button slot (its states are 3d.6's).
- **Autosave:** debounced, one save in flight, the latest wins; flush before navigating away and
  before «Рендер»; ignore `montage.changed` echoes of the open draft's own saves; handle
  `removed` and `NOT_FOUND` (the draft was deleted).
- **Panels:** the left media panel with the five tabs («Мои» «Скоро» until 3f; the «Музыка»,
  «GIF» and «Текст» controls «Скоро» until their N9 lifts), the centre preview area (3d.4 fills
  it), the right properties panel with «Свойства · ничего не выбрано / ролик пуст» and the
  composition list (R1, R2), the timeline frame (3d.3a fills it).
- **Empty draft** (`EditorNew`): «Ролик пока пуст…», Render blocked «Добавьте хотя бы один кадр»,
  the dashed «Перетащите фото или видео сюда» and «Добавить музыку».
- **Errors:** `LIBRARY_UNAVAILABLE`, the Stage 2 engine-offline card.
- Contract it needs: K1–K5, K8, K11 (+ 3d.1b mock parity).

### 3d.3a — the timeline: the clip track

- **Toolbar:** «Воспроизвести» (the preview clock), «00:04.1 / 00:09.6», «Разрезать по
  плейхеду» (video clips and layers only, CF4), «Дублировать выбранное» (photo / collage: empty
  cells, CF4), «Удалить выбранное», «ролик T с · от 4 до 15 с», zoom «−» / slider 1–8 / «+» and
  «Уместить».
- **Ruler and playhead:** 0–15 s always, tick 0.5 s (0.25 s zoomed), dim labels and hatching
  after the end, a draggable playhead that shows its time, click to seek, 100 ms snapping.
- **Track headers:** «Текст N +», «Стикеры N +», «Кадры N +», «Музыка»; counts amber and «+»
  disabled at a cap, with the reason.
- **Main track:** clip blocks (24 px thumbnails, «коллаж N» / «▶ видео», «2.4 с»); select
  (accent border, 9 px handles); trim by the handles (100 ms, ≥ 500 ms, total ≤ 15 s); reorder by
  drag (lifted clip, insertion line); «+» after the last clip; «⚠ фото отклонено» (and «фото уже
  в видео» / «фото недоступно») from K2 issues and `PhotoSummary`; the empty dashed track; the
  cap state; a **split-evenly** control (the plan asks for it, no artboard draws it).
- **Adding clips:** click a bin photo → append (AM7); drag onto the track → insert; each placed
  photo gets `montages.focus` (K6) and stores `null` when unresolved. Until 3d.5 lands, the
  «Фото» tab grid is enough: `photos.list`, eligible only, slot badges, used photos dimmed (Q1).
- **Clip properties** (photo / collage): «Кадр i из n · layout · a–b с», «Дублировать» /
  «Удалить», «Раскладка» (kind and layout switch; cells cut or padded empty), «Ячейки» picker,
  «кадр по лицу», the focus hint, «Анимация» («Ken Burns / Панорама / Статика»), «Ячейки по
  очереди, шаг X с» (computed; disabled for «1 фото»), «Длительность» and «ролик T с из 15 · кадр
  можно удлинить ещё на R с». **No «Масштаб»** (Q3).
- **Selection:** one item at a time (clip, text, sticker or music); Delete key; every edit goes
  through the undo stack and autosave.

### 3d.6 — render action and queue

- **Header button states:** ready «Рендер»; blocked with the first reason on its left, in this
  order: export folder → no clips → too short / too long → empty cell → photo unavailable (with
  the cells highlighted) → caption «Текст N: …» → layer past the end → track too short /
  unavailable → «Скоро» part; the no-folder variant with «· Настройки»; submitting (no double
  click); **queued** «В очереди · после N» (not drawn); running «Рендер · P %» + «Отменить
  рендер»; **«Сохранение…»** with Cancel disabled once `saving` (not drawn); done «Готово» +
  «Открыть в папке» + «Рендер» (blocked while the photos are in the new video, Q1); **failed**
  with the text by code and «Повторить» (not drawn); cancelled → ready.
- **Submit:** flush the autosave, then `videos.render {montageId}`. Map the refusals:
  `MONTAGE_INVALID` (issues → reason and highlights), `PHOTO_UNAVAILABLE` (cells by issues; never
  show `detail`), `EXPORT_UNAVAILABLE` (reason text + Settings link), `RENDER_QUEUE_FULL` †,
  `LIBRARY_TOO_NEW` †, `NOT_FOUND`. A refusal queued nothing and is safe to retry.
- **Tracking:** from the snapshot and `job.*`, never only from the answer (a timed-out answer's
  job is found by `montageId`); `video.changed` upserted after `job.failed` wins; the percentage is
  `floor(done / total × 100)` of frames.
- **Live export status:** `export.status` (K9), not a one-render size check.
- **Sidebar:** «Очередь · N задач» counts renders; «Рендер a / b» (AM4) with its bar.
- **Notices:** done / failed while the editor is not on screen, with the existing notice
  component.
- The drafts screen's «Рендер 42 %» and the videos tab's job cards use the same job model (the
  cards themselves are 3e.2's).
- Contract it needs: the 3a.8b.2 prerequisite, K2, K7, K9, K10 (+ K19 for caption reasons once 3b
  lands).

### 3e.1 — the playback check

- `studio-media://video/<avatarId>/<videoId>` plays and seeks (Range) in the packaged app on
  macOS and Windows for `present` **and** `changed` records ("playable, still used"); `missing`,
  `elsewhere` (and K15 `unchecked`) answer 404.
- The poster route `poster/<avatarId>/<videoId>` (K14) if 3b.1 has not added it: the cards need
  it even for a `missing` file.
- No artboard draws a play control or a player; 3e.1 proves the route with a minimal harness,
  and the designer adds the play affordance for 3e.2.

### 3e.3 — the export folder in Settings

- «Папки и экспорт» → «Готовые видео»: the path (home as «~»), the hint «здесь хранятся готовые
  видео · Studio держит у себя только запись о каждом», «Изменить» → `settings.setExportPath`
  through main's dialog (K18); a cancelled dialog changes nothing.
- After a switch: «Папка выбрана: N видео на месте, M остались в прежней папке» (not drawn;
  from `resolved` / `elsewhere`).
- The unavailable state with its reason (`EXPORT_UNAVAILABLE_REASONS_RU`); the dedicated
  `invalid-marker` text for a root that already has records, which never suggests deleting the
  marker; `newer-marker` (not drawn).
- `export.status` (K9) keeps this row, the editor's Render reason and the videos tab in step;
  the editor's «Настройки» link lands on this row.
- «Библиотека · Изменить» refused with `IN_FLIGHT` while renders are queued or running (a text
  is needed; not drawn).
- The default folder is created on first use (the owner-facing note in the plan is still open).
- The Settings rows around it follow CF16 / CF17 («Авто» only, x264 only) whoever edits the
  card.
- The videos tab's «~/Studio/export/Mia» and «Папка «Готовые видео»» (K17) read the same path;
  they are 3e.2's.
