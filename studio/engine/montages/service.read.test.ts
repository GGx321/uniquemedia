import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { MAX_LISTED_MONTAGES, Montage, MAX_MONTAGE_ISSUES } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { useWorld } from "../videos/testing/kit";
import { withOverrides } from "../videos/testing/serviceKit";
import { montageRig, scriptedFocus, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `montages.get` and `montages.list`: the drafts as stored, with the engine's verdict (K2, K3).

const world = useWorld();

async function failureOf(work: Promise<unknown>): Promise<EngineError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected the call to fail");
}

function draft(avatarId: string, montageId: string, photoIds: string[] = [], over: Partial<Montage> = {}): Montage {
  return Montage.parse({ montageId, name: null, spec: defaultSpec(avatarId, photoIds, 3), updatedAt: "2026-09-30T10:00:00.000Z", ...over });
}

describe("montages.get", () => {
  test("answers the stored draft, and no issues for a draft a render would accept", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    const stored = draft(w.avatar.id, "montage-0000001", [a], { name: "Кафе и город" });
    await r.store.write(w.library, stored);

    const answer = await r.service.get("montage-0000001");

    expect(answer).toEqual({ montage: stored, issues: [] });
  });

  test("an empty draft is answered with what a render would still need", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001"));

    const answer = await r.service.get("montage-0000001");

    expect(answer.montage.spec.clips).toEqual([]);
    expect(answer.issues).toEqual([{ code: "no-clips", path: ["clips"] }]);
  });

  test("a photo that was rejected since is photo-unavailable at its cell, and the draft is still answered", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", [a, b]));
    await w.library.setRejected(w.avatar.id, b, true);

    const answer = await r.service.get("montage-0000001");

    expect(answer.montage.spec.clips[0]).toMatchObject({ kind: "collage" });
    expect(answer.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cells", 1] }]);
  });

  test("the photos of a draft that was already rendered are photo-unavailable: one photo, one video", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", [a]));
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]), { montageId: "montage-0000001" });
    await w.library.reloadVideoRecords(w.avatar.id);

    const answer = await r.service.get("montage-0000001");

    expect(answer.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("finds a draft of any avatar by its id", async () => {
    const w = world();
    const r = montageRig(w);
    const other = await w.library.createAvatar({ name: "Lena", age: 25, traits: {}, descriptor: "a woman" });
    await r.store.write(w.library, draft(other.id, "montage-0000001"));

    expect((await r.service.get("montage-0000001")).montage.spec.avatarId).toBe(other.id);
  });

  test("a draft that does not exist is NOT_FOUND", async () => {
    const w = world();
    const r = montageRig(w);

    expect((await failureOf(r.service.get("montage-0000001"))).code).toBe("NOT_FOUND");
  });

  test("with no library open it says so", async () => {
    const w = world();
    const r = montageRig(w, { library: null });

    expect((await failureOf(r.service.get("montage-0000001"))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("a torn file is INTERNAL, and says nothing of its path or content", async () => {
    const w = world();
    const r = montageRig(w);
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    await writeFile(w.library.montageFilePath(w.avatar.id, "montage-0000001"), 'SECRET { "torn');

    const error = await failureOf(r.service.get("montage-0000001"));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").not.toContain(w.libraryRoot);
    expect(error.detail ?? "").not.toContain("SECRET");
  });

  test("a draft from a newer Studio says so: the owner is told to update, not that it is gone", async () => {
    const w = world();
    const r = montageRig(w);
    await mkdir(w.library.montagesDir(w.avatar.id), { recursive: true });
    await writeFile(w.library.montageFilePath(w.avatar.id, "montage-0000001"), JSON.stringify({ ...draft(w.avatar.id, "montage-0000001"), schemaVersion: 2 }));

    const error = await failureOf(r.service.get("montage-0000001"));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail).toMatch(/newer/);
  });

  test("the issues are cut at 64", async () => {
    const w = world();
    const r = montageRig(w);
    // 17 collages of 4 at 0.5 s: 68 cells that the library does not have
    const clips = Array.from({ length: 17 }, (_, i) => ({
      clipId: `clip-${String(i + 1).padStart(3, "0")}`,
      kind: "collage" as const,
      layout: "collage4" as const,
      cells: Array.from({ length: 4 }, (_, j) => ({ photo: { source: "scene" as const, photoId: `photo-gone-${String(i * 4 + j).padStart(4, "0")}` }, focus: null })),
      motion: "static" as const,
      stagger: false,
      durationMs: 500,
      transitionIn: "cut" as const,
    }));
    const stored = Montage.parse({ montageId: "montage-0000001", name: null, spec: { ...defaultSpec(w.avatar.id, [], 1), clips }, updatedAt: "2026-09-30T10:00:00.000Z" });
    await r.store.write(w.library, stored);

    const answer = await r.service.get("montage-0000001");

    expect(answer.issues).toHaveLength(MAX_MONTAGE_ISSUES);
  });
});

describe("montages.list", () => {
  test("answers an avatar's drafts newest first, with the total", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", [], { updatedAt: "2026-09-30T10:00:00.000Z" }));
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000002", [], { updatedAt: "2026-09-30T11:00:00.000Z" }));

    const answer = await r.service.list(w.avatar.id);

    expect(answer.items.map((item) => item.montage.montageId)).toEqual(["montage-0000002", "montage-0000001"]);
    expect(answer).toMatchObject({ total: 2, skippedTotal: 0 });
  });

  test("with no avatar it lists every avatar's drafts: the drafts screen's «Все»", async () => {
    const w = world();
    const r = montageRig(w);
    const other = await w.library.createAvatar({ name: "Lena", age: 25, traits: {}, descriptor: "a woman" });
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", [], { updatedAt: "2026-09-30T10:00:00.000Z" }));
    await r.store.write(w.library, draft(other.id, "montage-0000002", [], { updatedAt: "2026-09-30T11:00:00.000Z" }));

    const all = await r.service.list(undefined);
    const onlyMia = await r.service.list(w.avatar.id);

    expect(all.items.map((item) => item.montage.montageId)).toEqual(["montage-0000002", "montage-0000001"]);
    expect(onlyMia.items.map((item) => item.montage.montageId)).toEqual(["montage-0000001"]);
  });

  test("an avatar with no drafts has an empty list, not an error", async () => {
    const w = world();
    const r = montageRig(w);

    expect(await r.service.list(w.avatar.id)).toEqual({ items: [], total: 0, skippedTotal: 0 });
  });

  test("an avatar the library does not have is NOT_FOUND", async () => {
    const w = world();
    const r = montageRig(w);

    expect((await failureOf(r.service.list("avatar-nobody-1"))).code).toBe("NOT_FOUND");
  });

  test("with no library open it says so", async () => {
    const w = world();
    const r = montageRig(w, { library: null });

    expect((await failureOf(r.service.list(undefined))).code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("every item carries the issues of its own draft", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", [a], { updatedAt: "2026-09-30T10:00:00.000Z" }));
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000002", [b], { updatedAt: "2026-09-30T11:00:00.000Z" }));
    await w.library.setRejected(w.avatar.id, b, true);

    const answer = await r.service.list(w.avatar.id);

    expect(answer.items.map((item) => [item.montage.montageId, item.issues])).toEqual([
      ["montage-0000002", [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]],
      ["montage-0000001", []],
    ]);
  });

  test("the video count is how many records were rendered from the draft", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = "", b = "", c = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", [a], { updatedAt: "2026-09-30T11:00:00.000Z" }));
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000002", [], { updatedAt: "2026-09-30T10:00:00.000Z" }));
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]), { montageId: "montage-0000001" });
    await writeVideoRecord(w.libraryRoot, "video-0000002", sceneSpec(w.avatar.id, [b]), { montageId: "montage-0000001" });
    await writeVideoRecord(w.libraryRoot, "video-0000003", sceneSpec(w.avatar.id, [c]), { montageId: null });
    await w.library.reloadVideoRecords(w.avatar.id);

    const answer = await r.service.list(w.avatar.id);

    expect(answer.items.map((item) => [item.montage.montageId, item.videoCount])).toEqual([["montage-0000001", 2], ["montage-0000002", 0]]);
  });

  test("lists 200 drafts in full, and 201 as 200 with the real total beside them", async () => {
    const w = world();
    const r = montageRig(w);
    const at = (n: number) => new Date(Date.parse("2026-09-30T00:00:00.000Z") + n * 1000).toISOString();
    for (let n = 0; n < MAX_LISTED_MONTAGES; n++) await r.store.write(w.library, draft(w.avatar.id, `montage-${String(n).padStart(7, "0")}`, [], { updatedAt: at(n) }));

    const full = await r.service.list(w.avatar.id);
    expect(full.items).toHaveLength(200);
    expect(full.total).toBe(200);

    await r.store.write(w.library, draft(w.avatar.id, "montage-9999999", [], { updatedAt: at(500) }));
    const over = await r.service.list(w.avatar.id);

    expect(over.items).toHaveLength(200);
    expect(over.total).toBe(201);
    expect(over.items[0]?.montage.montageId).toBe("montage-9999999"); // the newest is kept, the oldest dropped
    expect(over.items.some((item) => item.montage.montageId === "montage-0000000")).toBe(false);
  });

  test("a corrupt draft file is left out, counted, and logged with no path", async () => {
    const w = world();
    const r = montageRig(w);
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001"));
    await writeFile(w.library.montageFilePath(w.avatar.id, "montage-0000002"), "SECRET { torn");

    const answer = await r.service.list(w.avatar.id);

    expect(answer.items.map((item) => item.montage.montageId)).toEqual(["montage-0000001"]);
    expect(answer).toMatchObject({ total: 1, skippedTotal: 1 });
    const said = r.logs.join("\n");
    expect(said).toMatch(/1 draft file/);
    expect(said).not.toContain(w.libraryRoot);
    expect(said).not.toContain("SECRET");
  });

  test("the photo state of an avatar is asked once for the whole list, not once per draft", async () => {
    const w = world();
    let asked = 0;
    const counting = withOverrides(w.library, {
      eligibleUnusedPhotos: (avatarId: string) => {
        asked++;
        return w.library.eligibleUnusedPhotos(avatarId);
      },
    });
    const r = montageRig(w, { library: counting });
    for (let n = 1; n <= 5; n++) await r.store.write(w.library, draft(w.avatar.id, `montage-000000${n}`));

    await r.service.list(w.avatar.id);

    expect(asked).toBe(1);
  });

  test("while an avatar's usage cannot be trusted its drafts are still listed, and the log says why once", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    for (let n = 1; n <= 3; n++) await r.store.write(w.library, draft(w.avatar.id, `montage-000000${n}`, [a]));
    w.library.flagVideoIndexStale(w.avatar.id, "video-0000001");

    const answer = await r.service.list(w.avatar.id);

    expect(answer.items).toHaveLength(3);
    expect(r.logs.filter((line) => /cannot be trusted/.test(line))).toHaveLength(1);
  });

  test("the focus resolver is never asked by a read", async () => {
    const w = world();
    const focus = scriptedFocus(() => "never");
    const r = montageRig(w, { focus });
    await r.store.write(w.library, draft(w.avatar.id, "montage-0000001", worldPhotoIds(w).slice(0, 2)));

    await r.service.list(w.avatar.id);
    await r.service.get("montage-0000001");

    expect(focus.started).toEqual([]);
  });
});
