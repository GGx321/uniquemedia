import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Montage } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { openLibrary, type Library } from "../library";
import { SAMPLE_AVATAR, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { DraftStore } from "./store";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S4.5c (plan §5.1): `photoIdsInDrafts(avatarId)`. A saved draft reserves nothing (`montages/service.ts`), so a photo the autopilot takes for a launch video could be one a draft
// holds, and the owner's manual render of that draft would hit PHOTO_UNAVAILABLE. The autopilot's planner leaves the photos this answers out of its pool (`draftHeldPhotoIds`).

const root = useTempDir("studio-draft-photos-");
const store = (): DraftStore => new DraftStore({ log: () => undefined });

async function openWithAvatars(count = 1): Promise<{ library: Library; avatarIds: string[] }> {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatarIds: string[] = [];
  for (let i = 0; i < count; i++) avatarIds.push((await library.createAvatar({ ...SAMPLE_AVATAR, name: `Mia ${i}` })).id);
  return { library, avatarIds };
}

function draft(avatarId: string, montageId: string, photoIds: readonly string[]): Montage {
  return Montage.parse({ montageId, name: null, spec: defaultSpec(avatarId, photoIds, 7), updatedAt: "2026-10-09T10:00:00.000Z" });
}

describe("DraftStore.photoIdsInDrafts", () => {
  test("an avatar with no drafts holds no photo, and the answer is complete", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const answer = await store().photoIdsInDrafts(library, avatarIds[0] ?? "");
    expect([...answer.photoIds]).toEqual([]);
    expect(answer.complete).toBe(true);
  });

  test("covers every draft of the avatar, not only the newest", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const s = store();
    await s.write(library, draft(avatarId, "montage-0000001", ["photo-0000001"]));
    await s.write(library, draft(avatarId, "montage-0000002", ["photo-0000002"]));
    await s.write(library, draft(avatarId, "montage-0000003", ["photo-0000003"]));

    const answer = await s.photoIdsInDrafts(library, avatarId);

    expect([...answer.photoIds].sort()).toEqual(["photo-0000001", "photo-0000002", "photo-0000003"]);
    expect(answer.complete).toBe(true);
  });

  test.each([
    ["a collage", ["photo-0000001", "photo-0000002", "photo-0000003"]],
    ["slides", ["photo-0000001", "photo-0000002", "photo-0000003", "photo-0000004", "photo-0000005", "photo-0000006"]],
  ])("holds every photo of %s", async (_name, photoIds) => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const s = store();
    await s.write(library, draft(avatarId, "montage-0000001", photoIds));

    const answer = await s.photoIdsInDrafts(library, avatarId);

    expect([...answer.photoIds].sort()).toEqual([...photoIds].sort());
  });

  test("a photo two drafts share is in the answer once", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const s = store();
    await s.write(library, draft(avatarId, "montage-0000001", ["photo-0000001"]));
    await s.write(library, draft(avatarId, "montage-0000002", ["photo-0000001", "photo-0000002"]));

    const answer = await s.photoIdsInDrafts(library, avatarId);

    expect([...answer.photoIds].sort()).toEqual(["photo-0000001", "photo-0000002"]);
  });

  test("an own photo is no scene photo: it is not in the answer", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const s = store();
    const base = draft(avatarId, "montage-0000001", ["photo-0000001"]);
    const own = { ...base, spec: { ...base.spec, clips: [{ clipId: "clip-0000001", kind: "photo" as const, durationMs: 4000, transitionIn: "cut" as const, motion: "static" as const, cell: { photo: { source: "own" as const, mediaId: "media-0000001" }, focus: null } }] } };
    await s.write(library, Montage.parse(own));

    const answer = await s.photoIdsInDrafts(library, avatarId);

    expect([...answer.photoIds]).toEqual([]);
  });

  test("another avatar's drafts are not this avatar's", async () => {
    const { library, avatarIds } = await openWithAvatars(2);
    const [first = "", second = ""] = avatarIds;
    const s = store();
    await s.write(library, draft(first, "montage-0000001", ["photo-0000001"]));
    await s.write(library, draft(second, "montage-0000002", ["photo-0000002"]));

    expect([...(await s.photoIdsInDrafts(library, first)).photoIds]).toEqual(["photo-0000001"]);
    expect([...(await s.photoIdsInDrafts(library, second)).photoIds]).toEqual(["photo-0000002"]);
  });

  test("a draft file that cannot be read makes the answer incomplete, and the readable drafts are still in it", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const s = store();
    await s.write(library, draft(avatarId, "montage-0000001", ["photo-0000001"]));
    await mkdir(library.montagesDir(avatarId), { recursive: true });
    await writeFile(join(library.montagesDir(avatarId), "montage-0000002.json"), "{ not json");

    const answer = await s.photoIdsInDrafts(library, avatarId);

    expect([...answer.photoIds]).toEqual(["photo-0000001"]);
    expect(answer.complete).toBe(false);
  });

  test("a draft deleted is no longer held", async () => {
    const { library, avatarIds } = await openWithAvatars();
    const [avatarId = ""] = avatarIds;
    const s = store();
    await s.write(library, draft(avatarId, "montage-0000001", ["photo-0000001"]));
    await s.remove(library, avatarId, "montage-0000001");

    expect([...(await s.photoIdsInDrafts(library, avatarId)).photoIds]).toEqual([]);
  });
});
