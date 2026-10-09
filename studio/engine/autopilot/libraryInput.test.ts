import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openLibrary, type Library, type LibraryDeps } from "../library/library";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_IMPORTED_SOURCE, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { planAvatarInput, type LibraryReads } from "./libraryInput";
import { planLaunch } from "./planner";
import { draft } from "./testing/planFixtures";
useNativeGlobals();

// S4.3: the adapter that reads one avatar out of a real library into the planner's input, so the planner's pool is the library's own verdict.

const root = useTempDir("studio-plan-input-");
const PDQ_A = "a".repeat(64);
const PDQ_B = "5".repeat(64);

async function fixture(extra: LibraryDeps = {}) {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds(), ...extra });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const generated = (category: string, qa: { pdq?: string; faceCos?: number } = {}) => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, category }, qa });
  return { library, avatar, generated };
}

describe("planAvatarInput", () => {
  test("a free generated photo comes through with its category, hash and face match", async () => {
    const { library, avatar, generated } = await fixture();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, generated("home", { pdq: PDQ_A, faceCos: 0.82 }));
    const out = planAvatarInput(library, avatar.id, false, true);
    expect(out.photos).toEqual([{ id: photo.id, avatarId: avatar.id, category: "home", pdq: PDQ_A, faceCos: 0.82, eligible: true, rejected: false, reserved: false, usedIn: [] }]);
    expect(out.usage).toEqual({ state: "ok" });
  });

  test("an imported photo has no category, so it can never match a chosen one", async () => {
    const { library, avatar } = await fixture();
    await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE }));
    expect(planAvatarInput(library, avatar.id, false, true).photos[0]?.category).toBeUndefined();
  });

  test("a rejected photo is marked rejected and the planner leaves it out", async () => {
    const { library, avatar, generated } = await fixture();
    const kept = await library.addPhoto(avatar.id, PNG_1X1, generated("home", { pdq: PDQ_A }));
    const rejected = await library.addPhoto(avatar.id, PNG_1X1, generated("home", { pdq: PDQ_B }));
    await library.setRejected(avatar.id, rejected.id, true);
    const input = planAvatarInput(library, avatar.id, false, true);
    expect(input.photos.find((p) => p.id === rejected.id)?.rejected).toBe(true);
    const plan = planLaunch({ draft: draft({ avatarIds: [avatar.id], videosPerAvatar: 2, mix: { single: 100, collage: 0, slides: 0 }, generate: false }), avatars: [input], draftHeldPhotoIds: new Set(), customPoses: new Map() });
    expect(plan.avatars[0]?.videos.flatMap((v) => v.photoIds)).toEqual([kept.id]);
  });

  test("a photo held by a saved draft is left out of the pool, though the library calls it free", async () => {
    const { library, avatar, generated } = await fixture();
    const held = await library.addPhoto(avatar.id, PNG_1X1, generated("home", { pdq: PDQ_A }));
    const input = planAvatarInput(library, avatar.id, false, true);
    const plan = planLaunch({ draft: draft({ avatarIds: [avatar.id] }), avatars: [input], draftHeldPhotoIds: new Set([held.id]), customPoses: new Map() });
    expect(plan.avatars[0]?.free).toBe(0);
  });

  test("the pool the planner sees equals the library's own eligible-and-unused list", async () => {
    const { library, avatar, generated } = await fixture();
    for (const category of ["home", "travel", "cat-sunsets-on-roofs", "glam"]) await library.addPhoto(avatar.id, PNG_1X1, generated(category));
    const rejected = await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    await library.setRejected(avatar.id, rejected.id, true);
    const plan = planLaunch({
      draft: draft({ avatarIds: [avatar.id], categories: ["home", "travel", "cat-sunsets-on-roofs", "glam", "fit", "shoot"] }),
      avatars: [planAvatarInput(library, avatar.id, false, true)],
      draftHeldPhotoIds: new Set(),
      customPoses: new Map(),
    });
    expect(plan.avatars[0]?.free).toBe(library.eligibleUnusedPhotos(avatar.id).length);
  });

  test("a library that cannot vouch for the avatar's usage gives an unknown usage with its reasons, and the planner uses no photo", async () => {
    const { library, avatar, generated } = await fixture();
    await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    const distrusting: LibraryReads = {
      photosByAvatar: (id) => library.photosByAvatar(id),
      photoStates: (id) => library.photoStates(id),
      usageReasons: () => ["index-stale"],
    };
    const input = planAvatarInput(distrusting, avatar.id, false, true);
    expect(input.usage).toEqual({ state: "unknown", reasons: ["index-stale"] });
    const plan = planLaunch({ draft: draft({ avatarIds: [avatar.id] }), avatars: [input], draftHeldPhotoIds: new Set(), customPoses: new Map() });
    expect(plan.avatars[0]).toMatchObject({ free: 0, fromLibrary: 0, blocked: "usage-unknown" });
  });

  test("the real Library satisfies the narrow reads the adapter needs", async () => {
    const { library } = await fixture();
    const reads: LibraryReads = library satisfies Pick<Library, keyof LibraryReads>;
    expect(typeof reads.usageReasons).toBe("function");
  });

  // The adapter must carry the library's own verdict on every axis: the planner's `free` equals `eligibleUnusedPhotos` (M2).
  const freeOf = (library: Library, avatarId: string): number =>
    planLaunch({ draft: draft({ avatarIds: [avatarId] }), avatars: [planAvatarInput(library, avatarId, false, true)], draftHeldPhotoIds: new Set(), customPoses: new Map() }).avatars[0]?.free ?? -1;

  test("a photo a video record lists carries usedIn and drops out of free, like the library's own list", async () => {
    const { library, avatar, generated } = await fixture();
    const used = await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    const free = await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    await writeVideoRecord(root(), "video-00000001", sceneSpec(avatar.id, [used.id]));
    const reopened = (await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("later") })).library;
    expect(planAvatarInput(reopened, avatar.id, false, true).photos.find((p) => p.id === used.id)?.usedIn).toEqual(["video-00000001"]);
    expect(freeOf(reopened, avatar.id)).toBe(1);
    expect(freeOf(reopened, avatar.id)).toBe(reopened.eligibleUnusedPhotos(avatar.id).length);
    expect(reopened.eligibleUnusedPhotos(avatar.id).map((p) => p.id)).toEqual([free.id]);
  });

  test("a photo a render reserves or a pending hold keeps carries reserved and drops out of free, like the library's own list", async () => {
    const reserved = new Set<string>();
    const { library, avatar, generated } = await fixture({ reservedPhotos: () => reserved });
    const byRender = await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    const byHold = await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    reserved.add(byRender.id);
    library.holdPendingPhotos(avatar.id, "video-00000009", [byHold.id]);
    const photos = planAvatarInput(library, avatar.id, false, true).photos;
    expect(photos.find((p) => p.id === byRender.id)?.reserved).toBe(true);
    expect(photos.find((p) => p.id === byHold.id)?.reserved).toBe(true);
    expect(freeOf(library, avatar.id)).toBe(1);
    expect(freeOf(library, avatar.id)).toBe(library.eligibleUnusedPhotos(avatar.id).length);
  });

  test("an imported photo and the master portrait carry eligible false and are not free, like the library's own list", async () => {
    const { library, avatar, generated } = await fixture();
    const master = await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    const imported = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE }));
    await library.addPhoto(avatar.id, PNG_1X1, generated("home"));
    const photos = planAvatarInput(library, avatar.id, false, true).photos;
    expect(photos.find((p) => p.id === master.id)?.eligible).toBe(false);
    expect(photos.find((p) => p.id === imported.id)?.eligible).toBe(false);
    expect(freeOf(library, avatar.id)).toBe(1);
    expect(freeOf(library, avatar.id)).toBe(library.eligibleUnusedPhotos(avatar.id).length);
  });
});
