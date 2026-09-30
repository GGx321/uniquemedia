import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { Montage } from "../../shared/engine/montage";
import { openLibrary } from "../library";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { useWorld, type World } from "../videos/testing/kit";
import { MONTAGE_COMMAND_DEADLINE_MS, MONTAGE_COMMAND_MARGIN_MS, MONTAGE_FOCUS_BUDGET_MS } from "./service";
import { addScenePhotos, montageRig, scriptedFocus, worldPhotoIds, type FocusScript } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `montages.create`: the draft a set of scene photos starts, with the focus of every photo resolved under ONE budget, and
// the owner's rule that one photo goes into one video (K11).

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

const draftFiles = (w: World, avatarId = w.avatar.id): Promise<string[]> => readdir(join(w.libraryRoot, "avatars", avatarId, "montages")).catch(() => []);

const FACE: FocusScript = { resolved: { x: 0.41, y: 0.33 } };

describe("montages.create: the draft it makes", () => {
  test("with no photo it makes an empty draft with no name: «Новый монтаж»", async () => {
    const w = world();
    const r = montageRig(w);

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    expect(montage.name).toBeNull();
    expect(montage.spec).toEqual({ schemaVersion: 1, avatarId: w.avatar.id, clips: [], layers: [], music: null, seed: 4242 });
    expect(Montage.safeParse(montage).success).toBe(true);
    expect(r.focus.started).toEqual([]); // nothing to judge, so the resolver is never asked
  });

  test("with one photo it makes one photo clip of 8 s with the photo's focus", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });
    const [photo = ""] = worldPhotoIds(w);

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [photo] });

    expect(montage.spec.clips).toHaveLength(1);
    expect(montage.spec.clips[0]).toMatchObject({ kind: "photo", durationMs: 8_000, cell: { photo: { source: "scene", photoId: photo }, focus: { x: 0.41, y: 0.33 } } });
  });

  test("with 2 to 4 photos it makes one collage, every cell with its own focus", async () => {
    const w = world();
    const [a = "", b = "", c = ""] = worldPhotoIds(w);
    const points: Record<string, FocusScript> = { [a]: { resolved: { x: 0.1, y: 0.2 } }, [b]: { resolved: { x: 0.3, y: 0.4 } }, [c]: { resolved: { x: 0.5, y: 0.6 } } };
    const r = montageRig(w, { focus: scriptedFocus((id) => points[id] ?? "unresolved") });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [a, b, c] });

    const [clip] = montage.spec.clips;
    expect(clip).toMatchObject({ kind: "collage", layout: "collage3" });
    expect(clip?.kind === "collage" ? clip.cells.map((cell) => cell.focus) : null).toEqual([{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }, { x: 0.5, y: 0.6 }]);
  });

  test("with 20 photos, the most, it makes 20 slides", async () => {
    const w = world();
    const photos = await addScenePhotos(w, 20);
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: photos });

    expect(montage.spec.clips).toHaveLength(20);
    expect(montage.spec.clips.every((clip) => clip.kind === "photo" && clip.cell.focus?.x === 0.41)).toBe(true);
  });

  test("with 21 photos it refuses, and stores nothing: the contract's cap holds here too", async () => {
    const w = world();
    const photos = await addScenePhotos(w, 21);
    const r = montageRig(w);

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: photos }));

    expect(error.code).toBe("VALIDATION");
    expect(await draftFiles(w)).toEqual([]);
    expect(r.focus.started).toEqual([]);
  });

  test("the same photo twice is refused as VALIDATION, not as a crash", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const r = montageRig(w);

    expect((await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [a, a] }))).code).toBe("VALIDATION");
    expect(await draftFiles(w)).toEqual([]);
  });

  test("the draft is stored: what is answered is what get would read", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });
    const [a = ""] = worldPhotoIds(w);

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [a] });

    expect(await draftFiles(w)).toEqual([`${montage.montageId}.json`]);
    expect(await r.store.read(w.library, w.avatar.id, montage.montageId)).toEqual({ kind: "ok", montage });
  });

  test("its updatedAt is the clock's now", async () => {
    const w = world();
    const r = montageRig(w, { now: () => new Date("2026-09-30T12:34:56.000Z") });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    expect(montage.updatedAt).toBe("2026-09-30T12:34:56.000Z");
  });

  test("announces the draft once, as an upsert of exactly what it answered", async () => {
    const w = world();
    const r = montageRig(w);

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    expect(r.stamped().map((e) => [e.type, e.payload])).toEqual([["montage.changed", { change: "upserted", montage }]]);
  });

  test("a listener that throws does not fail the create: the draft is stored", async () => {
    const w = world();
    const r = montageRig(w, {
      deps: {
        emit: () => {
          throw new Error("the window is closed");
        },
      },
    });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    expect(await draftFiles(w)).toEqual([`${montage.montageId}.json`]);
  });

  test("an id that is already a draft is never overwritten: another one is taken", async () => {
    const w = world();
    const taken = "montage-00000001";
    const ids = [taken, taken, "montage-00000002"];
    const r = montageRig(w, { deps: { newId: () => ids.shift() ?? "montage-00000099" } });
    const first = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    const second = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    expect(first.montage.montageId).toBe(taken);
    expect(second.montage.montageId).toBe("montage-00000002");
    expect((await draftFiles(w)).sort()).toEqual([`${taken}.json`, "montage-00000002.json"]);
  });

  test("a failing disk is an INTERNAL that names no path, nothing is announced and no draft is left", async () => {
    const w = world();
    const r = montageRig(w, {
      store: {
        beforeRename: () => {
          throw Object.assign(new Error(`EIO: i/o error, rename '${w.libraryRoot}/secret'`), { code: "EIO" });
        },
      },
    });

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [] }));

    expect(error.code).toBe("INTERNAL");
    expect(error.detail ?? "").not.toContain(w.libraryRoot);
    expect(error.detail ?? "").toContain("EIO");
    expect(r.events).toEqual([]);
    expect((await draftFiles(w)).filter((n) => n.endsWith(".json"))).toEqual([]);
  });
});

describe("montages.create: the avatar", () => {
  test("an avatar the library does not have is NOT_FOUND", async () => {
    const w = world();
    const r = montageRig(w);

    expect((await failureOf(r.service.create({ avatarId: "avatar-nobody-1", photoIds: [] }))).code).toBe("NOT_FOUND");
    expect(r.events).toEqual([]);
  });

  test("a draft avatar has no scene photos and no montages: NOT_FOUND", async () => {
    const w = world();
    const draft = await w.library.createAvatar({ name: "Draft", age: 25, traits: {}, descriptor: "a woman" });
    const r = montageRig(w);

    expect((await failureOf(r.service.create({ avatarId: draft.id, photoIds: [] }))).code).toBe("NOT_FOUND");
  });

  test("an archived avatar makes no new content: NOT_FOUND", async () => {
    const w = world();
    await w.library.updateAvatar(w.avatar.id, { status: "archived" });
    const r = montageRig(w);

    expect((await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [] }))).code).toBe("NOT_FOUND");
  });

  test("with no library open it says so", async () => {
    const w = world();
    const r = montageRig(w, { library: null });

    expect((await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [] }))).code).toBe("LIBRARY_UNAVAILABLE");
  });
});

describe("montages.create: one photo goes into one video (K11)", () => {
  const cellIssue = (i: number) => ({ code: "photo-unavailable", path: ["photoIds", i] });

  test("a rejected photo is refused at its own index, and nothing is stored, judged or announced", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    await w.library.setRejected(w.avatar.id, b, true);
    const r = montageRig(w);

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [a, b] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [cellIssue(1)] });
    expect(await draftFiles(w)).toEqual([]);
    expect(r.events).toEqual([]);
    expect(r.focus.started).toEqual([]);
  });

  test("a photo already in a video is refused", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]));
    await w.library.reloadVideoRecords(w.avatar.id);
    const r = montageRig(w);

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [b, a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [cellIssue(1)] });
  });

  test("a photo a queued or running render holds is refused", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    const { library } = await openLibrary(w.libraryRoot, { reservedPhotos: () => new Set([a]) });
    const r = montageRig(w, { library });

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [a, b] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [cellIssue(0)] });
  });

  test("a photo the library does not have, another avatar's and the master are refused, each at its index", async () => {
    const w = world();
    const other = await w.library.createAvatar({ name: "Lena", age: 25, traits: {}, descriptor: "a woman" });
    const [foreign = ""] = await addScenePhotos(w, 1, other.id);
    const [a = ""] = worldPhotoIds(w);
    const master = w.avatar.masterPhotoId ?? "";
    const r = montageRig(w);

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: ["photo-nobody-1", a, foreign, master] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [cellIssue(0), cellIssue(2), cellIssue(3)] });
  });

  test("every refused photo of a 20-photo request is listed", async () => {
    const w = world();
    const photos = await addScenePhotos(w, 20);
    for (const id of photos) await w.library.setRejected(w.avatar.id, id, true);
    const r = montageRig(w);

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: photos }));

    expect(error.issues).toHaveLength(20);
    expect(error.issues?.map((i) => i.path[1])).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  test("while the avatar's usage cannot be trusted every photo is refused, like a render would", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    w.library.flagVideoIndexStale(w.avatar.id, "video-0000001");
    const r = montageRig(w);

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [a] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [cellIssue(0)] });
    expect(error.detail).toMatch(/index-stale/);
    expect(await draftFiles(w)).toEqual([]);
  });

  test("a video record from a newer Studio is LIBRARY_TOO_NEW, not a photo problem", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]), { schemaVersion: 2 });
    await w.library.reloadVideoRecords(w.avatar.id);
    const r = montageRig(w);

    expect((await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [a] }))).code).toBe("LIBRARY_TOO_NEW");
  });

  test("an empty draft is fine even while usage cannot be trusted: it names no photo", async () => {
    const w = world();
    w.library.flagVideoIndexStale(w.avatar.id, "video-0000001");
    const r = montageRig(w);

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [] });

    expect(montage.spec.clips).toEqual([]);
  });

  test("a photo rejected while its focus was being judged is caught by the second look, and nothing is stored", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    const focus = scriptedFocus(() => FACE);
    const inner = focus.resolver.focusFor;
    focus.resolver.focusFor = async (avatarId, photoId, signal) => {
      await w.library.setRejected(w.avatar.id, b, true); // the owner rejects it in another tab of the window
      return inner(avatarId, photoId, signal);
    };
    const r = montageRig(w, { focus });

    const error = await failureOf(r.service.create({ avatarId: w.avatar.id, photoIds: [a, b] }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [cellIssue(1)] });
    expect(await draftFiles(w)).toEqual([]);
    expect(r.events).toEqual([]);
  });
});

describe("montages.create: the focus, under one budget", () => {
  test("every photo's focus is asked at the same time", async () => {
    const w = world();
    const photos = await addScenePhotos(w, 8);
    const focus = scriptedFocus(() => FACE, 15);
    const r = montageRig(w, { focus });

    await r.service.create({ avatarId: w.avatar.id, photoIds: photos });

    expect(focus.started.slice().sort()).toEqual(photos.slice().sort());
    expect(focus.maxInFlight).toBe(8);
  });

  test("a photo whose focus is not resolved is stored as null, the others keep theirs", async () => {
    const w = world();
    const [a = "", b = "", c = ""] = worldPhotoIds(w);
    const script: Record<string, FocusScript> = { [a]: FACE, [b]: "unresolved", [c]: FACE };
    const r = montageRig(w, { focus: scriptedFocus((id) => script[id] ?? "unresolved") });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [a, b, c] });

    const [clip] = montage.spec.clips;
    expect(clip?.kind === "collage" ? clip.cells.map((cell) => cell.focus) : null).toEqual([{ x: 0.41, y: 0.33 }, null, { x: 0.41, y: 0.33 }]);
  });

  test("a resolver that throws for one photo leaves that focus null and fails nothing", async () => {
    const w = world();
    const [a = "", b = ""] = worldPhotoIds(w);
    const r = montageRig(w, { focus: scriptedFocus((id) => (id === a ? "throws" : FACE)) });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [a, b] });

    const [clip] = montage.spec.clips;
    expect(clip?.kind === "collage" ? clip.cells.map((cell) => cell.focus) : null).toEqual([null, { x: 0.41, y: 0.33 }]);
  });

  test("a resolver that says the photo is gone leaves the focus null; the second look decides about the photo", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const r = montageRig(w, { focus: scriptedFocus(() => "not-found") });

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [a] });

    expect(montage.spec.clips[0]).toMatchObject({ cell: { focus: null } });
  });

  test("logs how many photos could not be judged, and no photo, path or error text", async () => {
    const w = world();
    const [a = "", b = "", c = ""] = worldPhotoIds(w);
    const r = montageRig(w, { focus: scriptedFocus((id) => (id === a ? "throws" : id === b ? "unresolved" : FACE)) });

    await r.service.create({ avatarId: w.avatar.id, photoIds: [a, b, c] });

    const said = r.logs.join("\n");
    expect(said).toMatch(/2 of 3 photo/);
    for (const secret of [a, b, c, w.libraryRoot, "face worker broke"]) expect(said).not.toContain(secret);
  });

  test("says nothing when every focus was judged", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });

    await r.service.create({ avatarId: w.avatar.id, photoIds: [a] });

    expect(r.logs).toEqual([]);
  });

  test("a resolver that never answers cannot push create past its budget: the photo gets null and the draft is stored", async () => {
    const w = world();
    const [a = "", b = "", c = ""] = worldPhotoIds(w);
    const script: Record<string, FocusScript> = { [a]: FACE, [b]: "never", [c]: "never" };
    const r = montageRig(w, { deps: { focusBudgetMs: 60 }, focus: scriptedFocus((id) => script[id] ?? "never") });
    const started = performance.now();

    const { montage } = await r.service.create({ avatarId: w.avatar.id, photoIds: [a, b, c] });

    expect(performance.now() - started).toBeLessThan(1_000);
    const [clip] = montage.spec.clips;
    expect(clip?.kind === "collage" ? clip.cells.map((cell) => cell.focus) : null).toEqual([{ x: 0.41, y: 0.33 }, null, null]);
    expect(await draftFiles(w)).toEqual([`${montage.montageId}.json`]);
  });

  test("the budget is ONE for all photos, not one per photo: 20 stuck photos cost the budget once", async () => {
    const w = world();
    const photos = await addScenePhotos(w, 20);
    const r = montageRig(w, { deps: { focusBudgetMs: 80 }, focus: scriptedFocus(() => "never") });
    const started = performance.now();

    await r.service.create({ avatarId: w.avatar.id, photoIds: photos });

    expect(performance.now() - started).toBeLessThan(600);
  });

  test("when the budget runs out the resolver is told to stop", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const focus = scriptedFocus(() => "never");
    const r = montageRig(w, { deps: { focusBudgetMs: 30 }, focus });

    await r.service.create({ avatarId: w.avatar.id, photoIds: [a] });

    expect(focus.signals).toHaveLength(1);
    expect(focus.signals[0]?.aborted).toBe(true);
  });

  test("a resolver that answers in time is not told to stop", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const focus = scriptedFocus(() => FACE);
    const r = montageRig(w, { focus });

    await r.service.create({ avatarId: w.avatar.id, photoIds: [a] });

    expect(focus.signals[0]?.aborted).toBe(false);
  });

  test("the budget is what the command's deadline leaves after the margin, when that is less than the budget", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const r = montageRig(w, { deps: { commandDeadlineMs: 200, commandMarginMs: 140, focusBudgetMs: 10_000 }, focus: scriptedFocus(() => "never") });
    const started = performance.now();

    await r.service.create({ avatarId: w.avatar.id, photoIds: [a] });

    expect(performance.now() - started).toBeLessThan(500);
  });

  test("the numbers fit main's 30 s command deadline with room to spare", () => {
    expect(MONTAGE_COMMAND_DEADLINE_MS).toBeLessThan(30_000);
    expect(MONTAGE_FOCUS_BUDGET_MS + MONTAGE_COMMAND_MARGIN_MS).toBeLessThanOrEqual(MONTAGE_COMMAND_DEADLINE_MS);
    expect(MONTAGE_FOCUS_BUDGET_MS).toBeLessThanOrEqual(20_000); // the resolver's own bound for one detect
  });
});
