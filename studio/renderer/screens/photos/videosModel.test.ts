import { describe, expect, test } from "bun:test";
import type { AvatarSummary, PhotoSummary, VideoSummary } from "../../../shared/engine";
import type { JobView } from "../../engine/store";
import { MIA, scenePhoto } from "../../engine/mockEngine.testkit";
import {
  deleteConfirmText,
  deleteOutcomeText,
  durationPill,
  failedRenderLine,
  filterCounts,
  galleryPhotos,
  headerCounts,
  avatarFolderDisplay,
  megabytesLabel,
  renderCardsOf,
  usageActions,
  videoCardView,
  videoMeta,
  visibleItems,
} from "./videosModel";

// 3e.2: the Photos screen's own logic, pure (no screen): the header counts, the gallery's filters, the «Видео» tab's cards per
// file state and render job, its filters, and the words of its confirmations and outcomes.

const NBSP = "\u00a0";

function video(n: number, patch: Partial<VideoSummary> = {}): VideoSummary {
  return {
    videoId: `video-${String(n).padStart(8, "0")}`,
    avatarId: MIA.avatarId,
    kind: "collage3",
    durationMs: 8_000,
    bytes: 2_400_000,
    createdAt: "2026-09-29T11:04:00.000Z",
    relPath: `Mia/2026-09-29_collage3_00${n}.mp4`,
    fileState: "present",
    montageId: "montage-00000001",
    photoCount: 3,
    music: null,
    hasPoster: false,
    title: "утро дома",
    firstClip: null,
    ...patch,
  };
}

function job(n: number, patch: Partial<JobView> = {}): JobView {
  return {
    jobId: `job-${String(n).padStart(8, "0")}`,
    kind: "render",
    avatarId: MIA.avatarId,
    runId: null,
    montageId: `montage-${String(n).padStart(8, "0")}`,
    videoId: `video-9${String(n).padStart(7, "0")}`,
    status: "running",
    saving: false,
    done: 121,
    total: 288,
    result: null,
    error: null,
    ...patch,
  };
}

const avatar = (patch: Partial<AvatarSummary> = {}): AvatarSummary => ({ ...MIA, photoCount: 124, eligibleUnusedCount: 31, videoCount: 18, ...patch });

describe("headerCounts: «124 фото · 31 не использовано · 18 видео»", () => {
  test("the three counts of the avatar's summary, the one eligibility function's", () => {
    expect(headerCounts(avatar())).toEqual({ photos: `124${NBSP}фото`, unused: `31${NBSP}не использовано`, videos: `18${NBSP}видео`, unknown: false });
  });

  test("a usage that cannot be trusted says so instead of a number that would read as free photos", () => {
    expect(headerCounts(avatar({ eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } }))).toEqual({
      photos: `124${NBSP}фото`,
      unused: "использование неизвестно",
      videos: `18${NBSP}видео`,
      unknown: true,
    });
  });

  test("large numbers are grouped", () => {
    expect(headerCounts(avatar({ photoCount: 1248 })).photos).toBe(`1${NBSP}248${NBSP}фото`);
  });
});

describe("usageActions: what the «использование неизвестно» notice offers", () => {
  test("a broken record offers «Убрать повреждённую запись», broken marks «Восстановить отметки», each with its confirmation", () => {
    const actions = usageActions({ state: "unknown", reasons: ["record-unreadable", "rejects-unreadable"] });
    expect(actions.map((a) => a.command)).toEqual(["videos.quarantineRecords", "photos.rebuildRejected"]);
    expect(actions.map((a) => a.label)).toEqual(["Убрать повреждённую запись", "Восстановить отметки"]);
    expect(actions.every((a) => a.confirm.length > 40)).toBe(true);
    expect(actions[0]?.confirm).toMatch(/карантин/);
    expect(actions[1]?.confirm).toMatch(/копи/);
  });

  test("a newer record and a stale index offer nothing to press: the app's update and a re-read are their fixes", () => {
    expect(usageActions({ state: "unknown", reasons: ["library-too-new", "index-stale"] })).toEqual([]);
    expect(usageActions({ state: "ok" })).toEqual([]);
  });

  test("a record the disk would not open offers nothing to press: its bytes may be sound, and only access fixes it", () => {
    expect(usageActions({ state: "unknown", reasons: ["record-inaccessible"] })).toEqual([]);
    // Beside a broken record, the quarantine is offered for that one (the engine never moves the one it could not open).
    expect(usageActions({ state: "unknown", reasons: ["record-unreadable", "record-inaccessible"] }).map((a) => a.command)).toEqual(["videos.quarantineRecords"]);
  });
});

describe("galleryPhotos: the gallery's «Все / Неиспользованные / Отклонённые»", () => {
  const free = scenePhoto(1);
  const used = scenePhoto(2, { used: true, usedIn: ["video-00000001"] });
  const reserved = scenePhoto(3, { reserved: true });
  const rejected = scenePhoto(4, { rejected: true, eligible: false });
  const ageFailed = scenePhoto(5, { eligible: false });
  const photos: PhotoSummary[] = [free, used, reserved, rejected, ageFailed];

  test("«Все» is every photo, in the list's order", () => {
    expect(galleryPhotos(photos, "all", { state: "ok" })).toEqual(photos);
  });

  test("«Неиспользованные» is what a montage may still take: eligible, in no video and in no render", () => {
    expect(galleryPhotos(photos, "unused", { state: "ok" })).toEqual([free]);
  });

  test("«Неиспользованные» is empty while the usage cannot be trusted: a photo that looks free may be in a video", () => {
    expect(galleryPhotos(photos, "unused", { state: "unknown", reasons: ["record-unreadable"] })).toEqual([]);
  });

  test("«Отклонённые» is the owner's own marks, whatever else holds them", () => {
    const usedAndRejected = scenePhoto(6, { used: true, usedIn: ["video-00000002"], rejected: true, eligible: false });
    expect(galleryPhotos([...photos, usedAndRejected], "rejected", { state: "ok" })).toEqual([rejected, usedAndRejected]);
  });
});

describe("renderCardsOf: the render jobs the «Видео» tab draws as cards", () => {
  test("this avatar's queued, running and failed renders, newest first; done and cancelled ones are not cards (the record shows a done one)", () => {
    const jobs = [
      job(1, { status: "done" }),
      job(2, { status: "failed", error: { code: "RENDER_FAILED" } }),
      job(3, { status: "cancelled" }),
      job(4, { status: "running" }),
      job(5, { status: "queued", done: 0 }),
      job(6, { avatarId: "avatar-other-0001" }),
      { ...job(7), kind: "run" as const, montageId: null, videoId: null, runId: "run-00000001" },
    ];
    expect(renderCardsOf(jobs, MIA.avatarId, new Set()).map((j) => j.jobId)).toEqual(["job-00000005", "job-00000004", "job-00000002"]);
  });

  test("a failed card the owner dismissed stays away", () => {
    const jobs = [job(2, { status: "failed", error: { code: "RENDER_FAILED" } })];
    expect(renderCardsOf(jobs, MIA.avatarId, new Set(["job-00000002"]))).toEqual([]);
  });
});

describe("the tab's filter: «Все 18», «В работе 2», «С ошибкой 1» (AM5)", () => {
  const cards = [job(5, { status: "queued", done: 0 }), job(4), job(2, { status: "failed", error: { code: "RENDER_FAILED" } })];
  const videos = [video(1, { fileState: "missing" }), video(2)];

  test("counts: every card and record; the renders queued or running; the renders that failed (file problems are not errors)", () => {
    expect(filterCounts(cards, videos)).toEqual({ all: 5, work: 2, failed: 1 });
  });

  test("each filter shows its own, cards first", () => {
    expect(visibleItems("all", cards, videos).map((i) => (i.kind === "job" ? i.job.jobId : i.video.videoId))).toEqual(["job-00000005", "job-00000004", "job-00000002", "video-00000001", "video-00000002"]);
    expect(visibleItems("work", cards, videos).map((i) => (i.kind === "job" ? i.job.jobId : ""))).toEqual(["job-00000005", "job-00000004"]);
    expect(visibleItems("failed", cards, videos).map((i) => (i.kind === "job" ? i.job.jobId : ""))).toEqual(["job-00000002"]);
  });
});

describe("videoCardView: a record's card in each file state", () => {
  test("present: «✓ в «Готовых видео»», play, «Открыть в папке», and the trash asks to delete the file too", () => {
    const view = videoCardView(video(1), { status: "ok" });
    expect(view).toMatchObject({ pill: null, dim: false, status: { text: "✓ в «Готовых видео»", tone: "ok" }, canPlay: true, canReveal: true, trash: true, recordDelete: null, recheck: false });
  });

  test("missing: «Файл удалён», the photos still held, and «Удалить запись» at once (the file is gone already)", () => {
    const view = videoCardView(video(1, { photoCount: 3 }), { status: "ok" });
    const missing = videoCardView(video(1, { fileState: "missing", photoCount: 3 }), { status: "ok" });
    expect(view.trash).toBe(true);
    expect(missing).toMatchObject({ pill: { text: "Файл удалён", tone: "muted" }, dim: true, canPlay: false, canReveal: false, trash: false, recordDelete: { confirm: null } });
    expect(missing.status.text).toBe(`Файл удалён из «Готовых видео». Пока есть запись, 3${NBSP}фото считаются занятыми.`);
  });

  test("changed: «файл изменён вне Studio», still playable, never revealed or deleted by Studio; «Удалить запись» confirms the file stays", () => {
    const view = videoCardView(video(1, { fileState: "changed" }), { status: "ok" });
    expect(view).toMatchObject({ pill: { text: "Изменён", tone: "warn" }, dim: false, canPlay: true, canReveal: false, trash: false });
    expect(view.status.text).toMatch(/^Файл изменён вне Studio/);
    expect(view.recordDelete?.confirm).toMatch(/Файл останется/);
  });

  test("elsewhere with a usable export folder: «файл в другой папке», and «Удалить запись» behind the owner's own confirmation (Q6)", () => {
    const view = videoCardView(video(1, { fileState: "elsewhere" }), { status: "ok" });
    expect(view).toMatchObject({ pill: { text: "Другая папка", tone: "muted" }, dim: true, canPlay: false, canReveal: false, trash: false });
    expect(view.status.text).toMatch(/^Файл в другой папке «Готовые видео»/);
    expect(view.recordDelete?.confirm).toBe("Удалить запись? Файл останется в прежней папке, а фото снова станут свободными.");
  });

  test("elsewhere because the export folder cannot be looked in: «не удалось проверить», never «another folder»", () => {
    const view = videoCardView(video(1, { fileState: "elsewhere" }), { status: "unavailable", reason: "missing" });
    expect(view.pill).toEqual({ text: "Не проверен", tone: "muted" });
    expect(view.status.text).toMatch(/^Не удалось проверить файл: папка «Готовые видео» сейчас недоступна/);
    expect(view.status.text).not.toMatch(/другой папке/);
    expect(view.recordDelete?.confirm).toBe("Удалить запись? Файл останется в прежней папке, а фото снова станут свободными.");
  });

  test("unchecked (K15): «не удалось проверить файл», a way to look again, and «Удалить запись» confirms the file stays where it is", () => {
    const view = videoCardView(video(1, { fileState: "unchecked" }), { status: "ok" });
    expect(view).toMatchObject({ pill: { text: "Не проверен", tone: "muted" }, dim: true, canPlay: false, canReveal: false, trash: false, recheck: true });
    expect(view.status.text).toMatch(/^Не удалось проверить файл\./);
    expect(view.recordDelete?.confirm).toMatch(/^Удалить запись\? Файл останется/);
  });

  test("one photo agrees in number: «1 фото считается занятым»", () => {
    expect(videoCardView(video(1, { fileState: "missing", photoCount: 1 }), { status: "ok" }).status.text).toBe(`Файл удалён из «Готовых видео». Пока есть запись, 1${NBSP}фото считается занятым.`);
  });
});

describe("the words around a delete", () => {
  test("«Удалить видео?» names the photos it frees, in number (A27)", () => {
    expect(deleteConfirmText(4)).toBe(`Удалить видео? Файл в «Готовых видео» тоже удалится, 4${NBSP}фото снова станут свободными.`);
    expect(deleteConfirmText(1)).toBe(`Удалить видео? Файл в «Готовых видео» тоже удалится, 1${NBSP}фото снова станет свободным.`);
    expect(deleteConfirmText(21)).toBe(`Удалить видео? Файл в «Готовых видео» тоже удалится, 21${NBSP}фото снова станет свободным.`);
    expect(deleteConfirmText(11)).toBe(`Удалить видео? Файл в «Готовых видео» тоже удалится, 11${NBSP}фото снова станут свободными.`);
  });

  test("the outcome says what the answer says: a file deleted needs no word, a file kept is told why", () => {
    expect(deleteOutcomeText("video", { fileDeleted: true, fileState: "present" })).toBeNull();
    expect(deleteOutcomeText("video", { fileDeleted: false, fileState: "changed" })).toMatch(/файл оставлен.*изменён вне Studio/);
    expect(deleteOutcomeText("video", { fileDeleted: false, fileState: "missing" })).toMatch(/файла .*уже не было/);
    expect(deleteOutcomeText("video", { fileDeleted: false, fileState: "present" })).toMatch(/файл оставлен/);
    expect(deleteOutcomeText("record", { fileDeleted: false, fileState: "missing" })).toBe("Запись удалена, фото снова свободны.");
    expect(deleteOutcomeText("record", { fileDeleted: false, fileState: "elsewhere" })).toBe("Запись удалена, фото снова свободны. Файл остался в прежней папке.");
    expect(deleteOutcomeText("record", { fileDeleted: false, fileState: "unchecked" })).toBe("Запись удалена, фото снова свободны. Файл, если он есть, остался на месте.");
  });
});

describe("the small words of a card", () => {
  test("the length pill reads whole seconds: «0:08», «0:09» for 9.6 s, «0:12»", () => {
    expect([8_000, 9_600, 10_400, 12_000, 15_000].map(durationPill)).toEqual(["0:08", "0:09", "0:10", "0:12", "0:15"]);
  });

  test("the facts line: «8.0 с · 3 фото · 2.4 МБ» (A12, from photoCount)", () => {
    expect(videoMeta(video(1))).toBe(`8.0${NBSP}с · 3${NBSP}фото · 2.4${NBSP}МБ`);
  });

  test("the size of the list: «52 МБ», decimal megabytes, whole", () => {
    expect(megabytesLabel([video(1, { bytes: 26_000_000 }), video(2, { bytes: 26_400_000 })])).toBe(`52${NBSP}МБ`);
    expect(megabytesLabel([])).toBe(`0${NBSP}МБ`);
  });

  test("the avatar's folder as a person reads it: the export folder's display and the folder of its newest video in this folder", () => {
    expect(avatarFolderDisplay("~/Studio/export", [video(1, { relPath: "Mia/2026-09-29_photo_001.mp4" })])).toBe("~/Studio/export/Mia");
    expect(avatarFolderDisplay("D:\\Reels", [video(1, { relPath: "Mia_ab12cd34/2026-09-29_photo_001.mp4" })])).toBe("D:\\Reels\\Mia_ab12cd34");
    expect(avatarFolderDisplay("~/Studio/export", [video(1, { fileState: "elsewhere", relPath: "Old/2026-09-29_photo_001.mp4" })])).toBe("~/Studio/export");
    expect(avatarFolderDisplay("~/Studio/export", [])).toBe("~/Studio/export");
    expect(avatarFolderDisplay(null, [video(1)])).toBeNull();
  });

  test("a failed render says why in a few words, and that its photos are free again", () => {
    expect(failedRenderLine({ code: "MONTAGE_INVALID", issues: [{ code: "track-unavailable", path: ["music"] }] })).toBe("Не собралось: трек больше недоступен. Фото остались свободными.");
    expect(failedRenderLine({ code: "EXPORT_UNAVAILABLE", exportReason: "missing" })).toBe("Не собралось: папка «Готовые видео» недоступна. Фото остались свободными.");
    expect(failedRenderLine({ code: "RENDER_FAILED" })).toBe("Не собралось: сборка не удалась. Фото остались свободными.");
    expect(failedRenderLine({ code: "INTERNAL", detail: "x" })).toBe("Не собралось: внутренняя ошибка. Фото остались свободными.");
  });
});
