import { describe, expect, test } from "bun:test";
import { CLIP_REASONS_RU, type EngineError } from "../../../shared/engine";
import { NBSP } from "../../lib/format";
import { clipUsedBadge, deleteOutcome, deleteUseLines, IN_RENDER_LINE } from "./clipUse";

// 5b.2 part A (S5.WA4; plan §6 41e, 44b; mockups 41e and 44b, README §S5.WAD, WAD re-review N4): what the avatar's «Клипы» screen says of a clip's use
// (`ClipSummary.use`). The tile's badge «в видео» is one for both ways a finished video holds the frame, with the title telling them apart. «Удалить клип?»
// says a finished video keeps its picture only when the video holds THIS clip, and names the draft holding its copy (one by name, several by number); a render
// holding the copy is told only after «Удалить» is refused `in-use`.

const nb = (text: string): string => text.replace(/ — /g, `${NBSP}— `);

describe("41e: the tile's «в видео»", () => {
  test("one badge for both `use.inVideo` values, the title tells them apart; none for an unused clip or one only in a draft", () => {
    expect(clipUsedBadge({ inVideo: "clip" })).toEqual({ label: "в видео", title: "Этот клип уже в готовом видео — второй раз не ставится" });
    expect(clipUsedBadge({ inVideo: "photo" })).toEqual({ label: "в видео", title: "Это фото или другой его клип уже в готовом видео — кадр второй раз не ставится" });
    expect(clipUsedBadge(undefined)).toBeNull();
    expect(clipUsedBadge({ inDrafts: { count: 1, first: { name: "утро дома", frame: 3 } } })).toBeNull();
  });
});

describe("44b: the lines of «Удалить клип?»", () => {
  test("a finished video holds this clip: «Клип есть в готовом видео — видео не изменится.»; through its photo or a sibling: nothing about videos", () => {
    expect(deleteUseLines({ inVideo: "clip" })).toEqual({ video: nb("Клип есть в готовом видео — видео не изменится."), draft: null });
    expect(deleteUseLines({ inVideo: "photo" })).toEqual({ video: null, draft: null });
    expect(deleteUseLines(undefined)).toEqual({ video: null, draft: null });
  });

  test("one draft holds the copy: named, with the kadr it stands at", () => {
    expect(deleteUseLines({ inDrafts: { count: 1, first: { name: "утро дома", frame: 3 } } }).draft).toBe(nb("В черновике «утро дома» он в кадре 3 — кадр будет помечен, пока его не замените."));
    expect(deleteUseLines({ inVideo: "clip", inDrafts: { count: 1, first: { name: "вечер", frame: 2 } } })).toEqual({
      video: nb("Клип есть в готовом видео — видео не изменится."),
      draft: nb("В черновике «вечер» он в кадре 2 — кадр будет помечен, пока его не замените."),
    });
  });

  test("a draft with no name is called as the drafts screen calls it", () => {
    expect(deleteUseLines({ inDrafts: { count: 1, first: { name: null, frame: 1 } } }).draft).toBe(nb("В черновике без названия он в кадре 1 — кадр будет помечен, пока его не замените."));
  });

  test("several drafts: «В N черновиках он стоит кадром — кадры будут помечены, пока их не замените.», by the plural forms (the number bound to its word)", () => {
    expect(deleteUseLines({ inDrafts: { count: 2 } }).draft).toBe(nb(`В 2${NBSP}черновиках он стоит кадром — кадры будут помечены, пока их не замените.`));
    expect(deleteUseLines({ inDrafts: { count: 5 } }).draft).toBe(nb(`В 5${NBSP}черновиках он стоит кадром — кадры будут помечены, пока их не замените.`));
    expect(deleteUseLines({ inDrafts: { count: 21 } }).draft).toBe(nb(`В 21${NBSP}черновике он стоит кадром — кадры будут помечены, пока их не замените.`));
    expect(deleteUseLines({ inDrafts: { count: 11 } }).draft).toBe(nb(`В 11${NBSP}черновиках он стоит кадром — кадры будут помечены, пока их не замените.`));
  });

  test("one draft the engine did not name: said without the name", () => {
    expect(deleteUseLines({ inDrafts: { count: 1 } }).draft).toBe(nb("В одном черновике он стоит кадром — кадр будет помечен, пока его не замените."));
  });
});

describe("44b: after «Удалить»", () => {
  test("deleted; refused `in-use` (a render holds the copy: the dialog stays and says so); any other refusal is the viewer's to tell", () => {
    expect(deleteOutcome({ ok: true })).toEqual({ kind: "deleted" });
    const inUse: EngineError = { code: "IN_FLIGHT", clipReason: "in-use" };
    expect(deleteOutcome({ ok: false, error: inUse })).toEqual({ kind: "in-render" });
    const other: EngineError = { code: "IN_FLIGHT", clipReason: "job-running" };
    expect(deleteOutcome({ ok: false, error: other })).toEqual({ kind: "refused", error: other });
    expect(IN_RENDER_LINE).toBe(nb(CLIP_REASONS_RU["in-use"]));
    expect(IN_RENDER_LINE).toBe(nb("Клип сейчас в рендере — удалите его, когда рендер закончится."));
  });
});
