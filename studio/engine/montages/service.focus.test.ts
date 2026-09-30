import { describe, expect, test } from "bun:test";
import { EngineFailure } from "../engineFailure";
import type { EngineError } from "../../shared/engine";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { useWorld } from "../videos/testing/kit";
import { addScenePhotos, montageRig, scriptedFocus, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// `montages.focus` (K6): the focus of one photo the owner has just placed, so the preview shows the crop the render will use.

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

const scene = (photoId: string) => ({ source: "scene" as const, photoId });
const FACE = { resolved: { x: 0.44, y: 0.29 } };

describe("montages.focus: the answer", () => {
  test("a photo that was judged answers its point", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });
    const [a = ""] = worldPhotoIds(w);

    expect(await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) })).toEqual({ focus: { x: 0.44, y: 0.29 } });
  });

  test("a photo that could not be judged answers null: the draft stores null and the preview draws the stand-in", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => "unresolved") });
    const [a = ""] = worldPhotoIds(w);

    expect(await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) })).toEqual({ focus: null });
  });

  test("a resolver that throws answers null, not an error", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => "throws") });
    const [a = ""] = worldPhotoIds(w);

    expect(await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) })).toEqual({ focus: null });
  });

  test("a resolver that never answers cannot hold the command past its budget", async () => {
    const w = world();
    const focus = scriptedFocus(() => "never");
    const r = montageRig(w, { focus, deps: { focusBudgetMs: 50 } });
    const [a = ""] = worldPhotoIds(w);
    const started = performance.now();

    const answer = await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) });

    expect(answer).toEqual({ focus: null });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(focus.signals[0]?.aborted).toBe(true);
  });

  test("logs that the photo could not be judged, and no id, path or error text", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => "throws") });
    const [a = ""] = worldPhotoIds(w);

    await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) });

    const said = r.logs.join("\n");
    expect(said).toMatch(/1 of 1 photo/);
    for (const secret of [a, w.libraryRoot, "face worker broke"]) expect(said).not.toContain(secret);
  });

  test("a photo that is already in a video still has a focus: the owner may be editing the draft it came from", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });
    const [a = ""] = worldPhotoIds(w);
    await writeVideoRecord(w.libraryRoot, "video-0000001", sceneSpec(w.avatar.id, [a]));
    await w.library.reloadVideoRecords(w.avatar.id);

    expect(await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) })).toEqual({ focus: { x: 0.44, y: 0.29 } });
  });

  test("while the avatar's usage cannot be trusted it still answers: a focus needs the photo, not its usage", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });
    const [a = ""] = worldPhotoIds(w);
    w.library.flagVideoIndexStale(w.avatar.id, "video-0000001");

    expect(await r.service.focus({ avatarId: w.avatar.id, photo: scene(a) })).toEqual({ focus: { x: 0.44, y: 0.29 } });
  });
});

describe("montages.focus: what it refuses", () => {
  const issue = { code: "photo-unavailable", path: ["photo"] };

  test("a rejected photo is PHOTO_UNAVAILABLE, and the resolver is never asked", async () => {
    const w = world();
    const focus = scriptedFocus(() => FACE);
    const r = montageRig(w, { focus });
    const [a = ""] = worldPhotoIds(w);
    await w.library.setRejected(w.avatar.id, a, true);

    const error = await failureOf(r.service.focus({ avatarId: w.avatar.id, photo: scene(a) }));

    expect(error).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [issue] });
    expect(focus.started).toEqual([]);
  });

  test("a photo the library does not have, another avatar's, and the master are PHOTO_UNAVAILABLE", async () => {
    const w = world();
    const r = montageRig(w, { focus: scriptedFocus(() => FACE) });
    const other = await w.library.createAvatar({ name: "Lena", age: 25, traits: {}, descriptor: "a woman" });
    const [foreign = ""] = await addScenePhotos(w, 1, other.id);

    for (const photoId of ["photo-nobody-1", foreign, w.avatar.masterPhotoId ?? ""]) {
      expect(await failureOf(r.service.focus({ avatarId: w.avatar.id, photo: scene(photoId) }))).toMatchObject({ code: "PHOTO_UNAVAILABLE", issues: [issue] });
    }
  });

  test("an own upload is NOT_FOUND until the media store exists (slice 3f)", async () => {
    const w = world();
    const r = montageRig(w);

    expect((await failureOf(r.service.focus({ avatarId: w.avatar.id, photo: { source: "own", mediaId: "media-0000001" } }))).code).toBe("NOT_FOUND");
  });

  test("an avatar the library does not have, a draft avatar and an archived one are NOT_FOUND", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    const draft = await w.library.createAvatar({ name: "Draft", age: 25, traits: {}, descriptor: "a woman" });

    expect((await failureOf(r.service.focus({ avatarId: "avatar-nobody-1", photo: scene(a) }))).code).toBe("NOT_FOUND");
    expect((await failureOf(r.service.focus({ avatarId: draft.id, photo: scene(a) }))).code).toBe("NOT_FOUND");
    await w.library.updateAvatar(w.avatar.id, { status: "archived" });
    expect((await failureOf(r.service.focus({ avatarId: w.avatar.id, photo: scene(a) }))).code).toBe("NOT_FOUND");
  });

  test("with no library open it says so", async () => {
    const w = world();
    const r = montageRig(w, { library: null });
    const [a = ""] = worldPhotoIds(w);

    expect((await failureOf(r.service.focus({ avatarId: w.avatar.id, photo: scene(a) }))).code).toBe("LIBRARY_UNAVAILABLE");
  });
});
