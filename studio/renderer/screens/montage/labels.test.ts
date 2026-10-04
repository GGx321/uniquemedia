import { describe, expect, test } from "bun:test";
import { MONTAGE_ISSUE_MESSAGES_RU, type Montage, type MontageDraft } from "../../../shared/engine";
import { NBSP } from "../../lib/format";
import {
  actionWhyLabel,
  captionLine,
  clockLabel,
  dragRangeLabel,
  draftMeta,
  draftName,
  draftTitle,
  layerAddLabel,
  layerAria,
  layerEdgeLabel,
  layerName,
  loopLabel,
  musicAria,
  outputLabel,
  outputParts,
  renderButtonLabel,
  saveLabel,
  stickerName,
  trackClock,
  trackName,
  trackTitle,
  trimOfLabel,
  trimRangeLabel,
  VIDEO_PROBLEM_TAGS,
  VIDEO_TAG_TEXTS,
  videoFactsLabel,
  videoRoomLabel,
  videoTag,
  whenLabel,
  clipAria,
} from "./labels";
import { draftSpec, montageOf, photoClip, stickerLayer, textLayer } from "./testkit";

// The words the drafts screen and the editor header show (EditorEmpty, Editor, EditorNew artboards).

/** A number bound to its unit by a no-break space, as the rest of Studio writes it ("25 лет", "20 МБ"); separators stay breakable. */
const nb = (s: string): string => s.replace(/(\d) (?=[^\d\s·])/g, `$1${NBSP}`).replace(/≈ /g, `≈${NBSP}`);

describe("names", () => {
  test("a named draft is quoted after its avatar; an unnamed one is «без названия» (K1)", () => {
    expect(draftTitle("Mia", "кафе и город")).toBe("Mia · «кафе и город»");
    expect(draftTitle("Elena", null)).toBe("Elena · без названия");
    expect(draftName(null)).toBe("без названия");
    expect(draftName("утро дома")).toBe("утро дома");
  });

  test("a draft whose avatar is not listed shows its own name alone", () => {
    expect(draftTitle(null, "кафе и город")).toBe("«кафе и город»");
    expect(draftTitle(null, null)).toBe("Без названия");
  });
});

describe("the summary line of a draft card", () => {
  test("length, clips and texts, as the artboard counts them", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 2_400), photoClip(1, "photo-mia-0002", 3_200), photoClip(2, "photo-mia-0003", 2_000), photoClip(3, "photo-mia-0004", 2_000)], {
      layers: [1, 2, 3].map((n) => ({ layerId: `layer-00${n}`, kind: "text" as const, startMs: 0, endMs: 1_000, value: "hi", font: "manrope" as const, style: "plaque" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 })),
    });
    expect(draftMeta(spec)).toBe(nb("9.6 с · 4 кадра · 3 текста"));
  });

  test("one text, no text, and no clips at all", () => {
    const one = draftSpec(3, { layers: [{ layerId: "layer-001", kind: "text", startMs: 0, endMs: 1_000, value: "hi", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 }] });
    expect(draftMeta(one)).toBe(nb("6.0 с · 3 кадра · 1 текст"));
    expect(draftMeta(draftSpec(1))).toBe(nb("2.0 с · 1 кадр · без текста"));
    expect(draftMeta(draftSpec(5))).toBe(nb("10.0 с · 5 кадров · без текста"));
    expect(draftMeta(draftSpec(0))).toBe("нет кадров");
  });
});

describe("the output line of the editor header", () => {
  test("frame, rate, length and the expected size from estimateBytes (9.6 s → ≈ 4.2 МБ)", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 4_800), photoClip(1, "photo-mia-0002", 4_800)]);
    expect(outputLabel(spec)).toBe(nb("1080×1920 · 30 fps · 9.6 с · ≈ 4.2 МБ"));
  });

  test("an empty draft has no size, only its zero length", () => {
    expect(outputLabel(draftSpec(0))).toBe(nb("1080×1920 · 30 fps · 0 с"));
  });

  test("its two parts: the format, the same for every draft (the first to go in a narrow window), and the draft's own length and size", () => {
    const spec = draftSpec([photoClip(0, "photo-mia-0001", 4_800), photoClip(1, "photo-mia-0002", 4_800)]);
    expect(outputParts(spec)).toEqual({ format: nb("1080×1920 · 30 fps"), length: nb("9.6 с · ≈ 4.2 МБ") });
    expect(outputParts(draftSpec(0))).toEqual({ format: nb("1080×1920 · 30 fps"), length: nb("0 с") });
  });
});

describe("times", () => {
  const now = new Date("2026-09-30T18:00:00.000Z");

  test("today, yesterday, this year and another year", () => {
    expect(whenLabel("2026-09-30T14:02:00.000Z", now, "UTC")).toBe("сегодня, 14:02");
    expect(whenLabel("2026-09-29T21:40:00.000Z", now, "UTC")).toBe("вчера, 21:40");
    expect(whenLabel("2026-09-26T09:15:00.000Z", now, "UTC")).toBe(nb("26 сент., 09:15"));
    expect(whenLabel("2025-12-31T23:59:00.000Z", now, "UTC")).toBe(nb("31 дек. 2025, 23:59"));
  });

  test("midnight is 00:05, never 24:05", () => {
    expect(whenLabel("2026-09-30T00:05:00.000Z", now, "UTC")).toBe("сегодня, 00:05");
  });

  test("«today» follows the owner's clock, not UTC", () => {
    // 23:30 UTC on the 29th is already the 30th in Moscow (UTC+3).
    expect(whenLabel("2026-09-29T23:30:00.000Z", now, "Europe/Moscow")).toBe("сегодня, 02:30");
  });

  test("the timeline clock: minutes, seconds and tenths", () => {
    expect(clockLabel(0)).toBe("00:00.0");
    expect(clockLabel(4_100)).toBe("00:04.1");
    expect(clockLabel(9_600)).toBe("00:09.6");
    expect(clockLabel(75_000)).toBe("01:15.0");
  });
});

describe("the save state under the draft's name", () => {
  const saved: Montage = montageOf(draftSpec(1), null, "2026-09-30T14:02:00.000Z");

  test("saved, with the time of the engine's last answer", () => {
    expect(saveLabel({ kind: "saved" }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик · сохранён 14:02");
  });

  test("just created and not edited since", () => {
    expect(saveLabel({ kind: "saved" }, saved, { fresh: true, timeZone: "UTC" })).toBe("черновик · создан только что");
  });

  test("an edit on its way", () => {
    expect(saveLabel({ kind: "pending" }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик · сохраняется…");
    expect(saveLabel({ kind: "saving" }, saved, { fresh: true, timeZone: "UTC" })).toBe("черновик · сохраняется…");
  });

  test("a refused save and a deleted draft", () => {
    expect(saveLabel({ kind: "failed", error: { code: "INTERNAL" } }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик · не сохранён");
    expect(saveLabel({ kind: "gone" }, saved, { fresh: false, timeZone: "UTC" })).toBe("черновик удалён");
  });
});

// 3d.6: the words on the render button while a render is on its way.
describe("renderButtonLabel", () => {
  test("submitting, queued (with how many renders are ahead), running (floor percent), saving", () => {
    expect(renderButtonLabel({ kind: "submitting" })).toBe("Рендер…");
    expect(renderButtonLabel({ kind: "queued", after: 0, cancelling: false })).toBe("В очереди");
    expect(renderButtonLabel({ kind: "queued", after: 2, cancelling: false })).toBe("В очереди · после 2");
    expect(renderButtonLabel({ kind: "running", percent: 42, cancelling: false })).toBe(`Рендер · 42${NBSP}%`);
    expect(renderButtonLabel({ kind: "running", percent: 0, cancelling: false })).toBe(`Рендер · 0${NBSP}%`);
    expect(renderButtonLabel({ kind: "running", percent: 100, cancelling: false })).toBe(`Рендер · 100${NBSP}%`);
    expect(renderButtonLabel({ kind: "saving" })).toBe("Сохранение…");
  });

  test("a cancel that is out says so instead of the progress", () => {
    expect(renderButtonLabel({ kind: "running", percent: 42, cancelling: true })).toBe("Отменяем…");
    expect(renderButtonLabel({ kind: "queued", after: 1, cancelling: true })).toBe("Отменяем…");
  });
});

// 3d.3b: the layer and music tracks' words (Editor.dc.html's timeline; the components sheet's «Слой текста и стикера» and
// «Музыка на дорожке»).
describe("the layer blocks", () => {
  const sticker = (stickerId: string, from = 6_000, to = 9_600): MontageDraft["layers"][number] => ({ ...stickerLayer(1, from, to), sticker: { source: "builtin", stickerId } });
  const spec = draftSpec(4, {
    layers: [
      { ...textLayer(0, 300, 4_400), value: "sunday reset ☀️" },
      sticker("heart-pulse"),
      { ...textLayer(2, 5_800, 9_600), value: "coffee\nfirst" },
      { ...stickerLayer(3, 1_000, 2_000), sticker: { source: "own", mediaId: "media-own-0001" } },
      sticker("sticker-gone-0001", 7_000, 8_000),
    ],
  });

  test("a layer is counted among its own kind, in z-order", () => {
    expect([0, 1, 2, 3, 4].map((i) => layerName(spec, i))).toEqual(["Текст 1", "Стикер 1", "Текст 2", "Стикер 2", "Стикер 3"]);
  });

  const stickerAt = (i: number): Extract<MontageDraft["layers"][number], { kind: "sticker" }> => {
    const layer = spec.layers[i];
    if (layer?.kind !== "sticker") throw new Error(`no sticker at ${i}`);
    return layer;
  };

  test("a sticker is named from the built-in set, with its loop in seconds; an own or a vanished one says so", () => {
    expect(stickerName(stickerAt(1))).toBe("Сердце");
    expect(loopLabel(stickerAt(1))).toBe(nb("петля 0.8 с"));
    expect(stickerName(stickerAt(3))).toBe("свой стикер");
    expect(loopLabel(stickerAt(3))).toBeNull();
    expect(stickerName(stickerAt(4))).toBe("стикер недоступен");
  });

  test("a block's name: what it is, its range, a sticker's loop; a caption's line break reads as a space", () => {
    expect(layerAria(spec, 0, 9_600)).toBe(nb("Текст 1: «sunday reset ☀️», 0.3–4.4 с"));
    expect(layerAria(spec, 1, 9_600)).toBe(nb("Стикер 1: Сердце, 6.0–9.6 с, петля 0.8 с"));
    expect(layerAria(spec, 2, 9_600)).toBe(nb("Текст 2: «coffee first», 5.8–9.6 с"));
    expect(captionLine("coffee\r\nfirst")).toBe("coffee first");
  });

  test("a layer past the montage's end says so", () => {
    expect(layerAria(spec, 1, 8_000)).toBe(nb("Стикер 1: Сердце, 6.0–9.6 с, петля 0.8 с, после конца ролика"));
  });

  test("the trim handles and the drag's range", () => {
    expect(layerEdgeLabel(spec, 0, "start")).toBe("Текст 1: начало");
    expect(layerEdgeLabel(spec, 4, "end")).toBe("Стикер 3: конец");
    expect(dragRangeLabel(300, 4_400)).toBe(`0.3 → 4.4${NBSP}с`);
  });

  test("the track headers' «+»: its name, and why it is off (the components sheet's caps)", () => {
    expect(layerAddLabel("text", null, 9_600)).toEqual({ name: "Добавить текст", why: null });
    expect(layerAddLabel("sticker", null, 9_600)).toEqual({ name: "Добавить стикер", why: null });
    expect(layerAddLabel("text", "layer-cap", 9_600)).toEqual({ name: "Добавить текст: не больше 10", why: "Не больше 10 текстов в одном видео" });
    expect(layerAddLabel("sticker", "layer-cap", 9_600)).toEqual({ name: "Добавить стикер: не больше 10", why: "Не больше 10 стикеров в одном видео" });
    expect(layerAddLabel("text", "no-room", 9_600)).toEqual({ name: "Добавить текст: нет места", why: nb("До конца ролика меньше 0.3 с — поставьте плейхед раньше") });
    expect(layerAddLabel("sticker", "no-room", 0)).toEqual({ name: "Добавить стикер: нет места", why: "Сначала добавьте кадр" });
  });

  test("the z-order steps say why they are off", () => {
    expect(actionWhyLabel("top")).toBe("Выше в это время ничего нет");
    expect(actionWhyLabel("bottom")).toBe("Ниже в это время ничего нет");
    expect(actionWhyLabel("not-a-layer")).toBe("Выше и ниже двигаются только текст и стикеры");
    expect(actionWhyLabel("nothing-selected")).toBe("Сначала выберите кадр, текст или стикер на таймлайне");
  });
});

describe("the music block", () => {
  const track = { trackId: "track-espresso-01", title: "Espresso", artist: "Sabrina Carpenter", durationMs: 175_000, explicit: false, highlights: [{ ms: 42_000, likelyDefault: false }], hasCover: true };

  test("a time in the track: minutes and seconds, tenths only when the start is between seconds", () => {
    expect(trackClock(0)).toBe("0:00");
    expect(trackClock(42_000)).toBe("0:42");
    expect(trackClock(78_000)).toBe("1:18");
    expect(trackClock(42_137)).toBe("0:42.1");
    expect(trackClock(59_999)).toBe("0:59.9");
    expect(trackClock(600_000)).toBe("10:00");
  });

  test("the title and the artist; a track with no artist is its title alone", () => {
    expect(trackTitle(track)).toBe("Espresso · Sabrina Carpenter");
    expect(trackTitle({ ...track, artist: null })).toBe("Espresso");
  });

  test("what the track is called on the block: its title, or what the editor knows of it", () => {
    expect(trackName({ state: "listed", track })).toBe("Espresso · Sabrina Carpenter");
    expect(trackName({ state: "unlisted" })).toBe("трек из прежнего списка");
    // An own track (3f.4) is called by the file's name; one the library no longer lists is told so.
    expect(trackName({ state: "own", track: { name: "my mix.mp3" } })).toBe("my mix.mp3");
    expect(trackName({ state: "own-gone" })).toBe("свой трек: файла больше нет");
    expect(trackName({ state: "loading" })).toBe(null);
    expect(trackName({ state: "none" })).toBe(null);
  });

  test("its name: the track and where it starts, or what is wrong with it", () => {
    const music = { source: "trending", trackId: "track-espresso-01", startMs: 42_000 } as const;
    expect(musicAria(music, "Espresso · Sabrina Carpenter", null)).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:42");
    expect(musicAria(music, "трек из прежнего списка", null)).toBe("Музыка: трек из прежнего списка, с 0:42");
    // Still being looked up: no name yet, never a wrong one.
    expect(musicAria(music, null, null)).toBe("Музыка: трек, с 0:42");
    expect(musicAria(music, "Espresso · Sabrina Carpenter", "too-short")).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:42, трек короче ролика");
    expect(musicAria(music, null, "unavailable")).toBe("Музыка: трек недоступен");
  });
});

describe("an own video clip (3f.3b)", () => {
  const latte = { name: "latte-pour.mov", width: 1_080, height: 1_920, durationMs: 6_400, sourceFps: 60, hdrToSdr: true };

  test("«Обрезка»: the part of the video «1.8 → 3.8 с» and «2.0 с из 6.4»", () => {
    expect(trimRangeLabel(1_800, 3_800)).toBe(`1.8 → 3.8${NBSP}с`);
    expect(trimOfLabel(2_000, 6_400)).toBe(nb("2.0 с из 6.4"));
    // The stored length as the record has it, to a tenth.
    expect(trimOfLabel(500, 6_433)).toBe(nb("0.5 с из 6.4"));
  });

  test("the source facts: length, stored size, the owner's rate and the constant 30 fps it became", () => {
    expect(videoFactsLabel(latte)).toBe(nb("6.4 с · 1080×1920 · 60 → 30 fps"));
    expect(videoFactsLabel({ ...latte, sourceFps: 29.97, width: 1_080, height: 608, durationMs: 14_000 })).toBe(nb("14.0 с · 1080×608 · 29.97 → 30 fps"));
    expect(videoFactsLabel({ ...latte, sourceFps: 23.976 })).toBe(nb("6.4 с · 1080×1920 · 23.98 → 30 fps"));
    // Already 30 fps: nothing changed.
    expect(videoFactsLabel({ ...latte, sourceFps: 30 })).toBe(nb("6.4 с · 1080×1920 · 30 fps"));
  });

  test("what is left of the 15 s for this clip, as far as its video goes", () => {
    expect(videoRoomLabel(9_600, 5_400, 5_400, 14_000)).toBe(nb("ролик 9.6 с из 15 · кадр можно удлинить ещё на 5.4 с"));
    expect(videoRoomLabel(9_600, 5_400, 1_200, 6_400)).toBe(nb("ролик 9.6 с из 15 · кадр можно удлинить ещё на 1.2 с — дальше видео заканчивается"));
    expect(videoRoomLabel(9_600, 5_400, 0, 2_000)).toBe(nb("ролик 9.6 с из 15 · видео уже целиком в кадре"));
    expect(videoRoomLabel(15_000, 0, 0, 14_000)).toBe(nb("ролик 15.0 с из 15 · длиннее кадр уже не станет"));
  });

  test("fix round 1 (L3): a video shorter than the shortest clip (0.5 s) is told apart: it cannot be in the montage at all", () => {
    expect(videoRoomLabel(4_500, 10_500, 0, 400)).toBe(nb("ролик 4.5 с из 15 · видео короче 0.5 с"));
    expect(videoRoomLabel(4_500, 10_500, 0, 499)).toBe(nb("ролик 4.5 с из 15 · видео короче 0.5 с"));
    expect(videoRoomLabel(4_500, 10_500, 0, 500)).toBe(nb("ролик 4.5 с из 15 · видео уже целиком в кадре"));
    expect(videoTag("video-too-short", 400)).toBe("video-under-min");
    expect(videoTag("video-too-short", 500)).toBe("video-too-short");
    expect(videoTag("video-too-short", null)).toBe("video-too-short");
    expect(videoTag("media-unavailable", 400)).toBe("media-unavailable");
    expect(VIDEO_TAG_TEXTS["video-under-min"]).toBe(nb("Видео короче 0.5 с — в ролик его не поставить"));
    expect(VIDEO_TAG_TEXTS["video-too-short"]).toBe(MONTAGE_ISSUE_MESSAGES_RU["video-too-short"]);
    expect(VIDEO_TAG_TEXTS["media-unavailable"]).toBe(MONTAGE_ISSUE_MESSAGES_RU["media-unavailable"]);
  });

  test("the clip block: «▶ видео» named by its file, or what the render refuses it for", () => {
    const clip = { clipId: "clip-003", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: "media-own-0001", trimStartMs: 1_800, focus: null } as const;
    expect(clipAria(2, clip, null, "latte-pour.mov")).toBe(nb("Кадр 3: видео latte-pour.mov, 2.0 с"));
    expect(clipAria(2, clip, null)).toBe(nb("Кадр 3: видео, 2.0 с"));
    expect(clipAria(2, clip, "video-too-short", "latte-pour.mov")).toBe(nb("Кадр 3: видео короче кадра, 2.0 с"));
    expect(clipAria(2, clip, "media-unavailable")).toBe(nb("Кадр 3: файла больше нет, 2.0 с"));
    expect(clipAria(2, clip, "video-under-min")).toBe(nb("Кадр 3: видео короче 0.5 с, 2.0 с"));
    expect(VIDEO_PROBLEM_TAGS).toEqual({ "video-too-short": "⚠ видео короче кадра", "media-unavailable": "⚠ файла больше нет", "video-under-min": nb("⚠ видео короче 0.5 с") });
  });
});
