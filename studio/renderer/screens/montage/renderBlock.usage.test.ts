import { describe, expect, test } from "bun:test";
import type { MontageIssue, PhotoSummary } from "../../../shared/engine";
import { renderBlock, type RenderBlockInput } from "./renderBlock";
import { AVATAR_ID, draftSpec } from "./testkit";

// While the avatar's photo usage is unknown the engine refuses EVERY photo of it: the reason names that, not «замените фото» (one replacement cannot help).

const READY = draftSpec(2);
const photo = (n: number): PhotoSummary => ({ photoId: `photo-mia-${String(n).padStart(4, "0")}`, avatarId: AVATAR_ID, runId: null, category: "home", createdAt: "2026-09-30T10:00:00.000Z", used: false, usedIn: [], rejected: false, reserved: false, eligible: true });
const flagged = (...clips: number[]): MontageIssue[] => clips.map((i) => ({ code: "photo-unavailable", path: ["clips", i, "cell"] }));

function input(patch: Partial<RenderBlockInput> = {}): RenderBlockInput {
  return { spec: READY, exportStatus: { status: "ok" }, avatarActive: true, verdict: { spec: READY, issues: flagged(0, 1) }, photos: new Map([photo(1), photo(2)].map((p) => [p.photoId, p])), usedVideo: null, ...patch };
}

describe("a render blocked while the avatar's usage is unknown", () => {
  test("without the usage it reads as before: replace the photo", () => {
    expect(renderBlock(input())?.text).toBe("Кадр 1: фото недоступно — замените его");
  });

  test.each([
    ["library-too-new", "Записи видео этого аватара созданы более новой версией Studio — обновите приложение"],
    ["index-stale", "Studio перечитывает записи видео этого аватара — подождите немного"],
    ["record-unreadable", "Записи этого аватара повреждены или недоступны — откройте «Фото» этого аватара"],
    ["record-inaccessible", "Записи этого аватара повреждены или недоступны — откройте «Фото» этого аватара"],
    ["rejects-unreadable", "Записи этого аватара повреждены или недоступны — откройте «Фото» этого аватара"],
  ] as const)("%s says what is wrong with the avatar", (reason, text) => {
    expect(renderBlock(input({ avatarUsage: { state: "unknown", reasons: [reason] } }))?.text).toBe(text);
  });

  test("the decisive reason is the first of the list", () => {
    const block = renderBlock(input({ avatarUsage: { state: "unknown", reasons: ["library-too-new", "record-unreadable"] } }));
    expect(block?.text).toContain("более новой версией");
  });

  test("it marks every flagged clip, not only the first", () => {
    expect(renderBlock(input({ avatarUsage: { state: "unknown", reasons: ["record-unreadable"] } }))?.clips).toEqual([0, 1]);
  });

  test("a sound usage changes nothing", () => {
    expect(renderBlock(input({ avatarUsage: { state: "ok" } }))?.text).toBe("Кадр 1: фото недоступно — замените его");
  });
});
