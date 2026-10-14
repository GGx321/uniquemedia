import { afterEach, describe, expect, test } from "bun:test";
import { ClipSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { ClipRecordsDeps } from "./records";
import { AVATAR, CLIP, createRecordsRig, failedRecord, readyRecord, reserve, settle, type RecordsRig } from "./testing/recordsRig";
import { clipAttemptId } from "./journal";
useNativeGlobals();

// 5b.2, S5.WA2 (Q-F = 1): `ClipSummary.use`, filled by clips.list and clips.get for READY clips only. `inVideo` says how a finished video uses the clip's frame (the used index), `inDrafts` how many saved
// drafts hold its copy (and, for exactly one, which). A clip nothing uses has no `use` key.

const rigs: RecordsRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.cleanup()));
});

const CLIP_B = "clip-0000002";
const CLIP_C = "clip-0000003";

async function world(uses: ClipRecordsDeps["uses"]) {
  const rig = await createRecordsRig({ deps: uses === undefined ? {} : { uses } });
  rigs.push(rig);
  await rig.ledgerWith([reserve(clipAttemptId(CLIP, 1), CLIP, 504_000), settle(clipAttemptId(CLIP, 1), 420_000, false)]);
  await rig.put(readyRecord({ createdAt: "2026-10-13T10:00:00.000Z" }));
  await rig.put(readyRecord({ id: CLIP_B, createdAt: "2026-10-13T11:00:00.000Z", sourcePhotoId: "photo-0002" }));
  await rig.put(readyRecord({ id: CLIP_C, createdAt: "2026-10-13T12:00:00.000Z", sourcePhotoId: "photo-0003" }));
  return rig;
}

const useOf = async (rig: RecordsRig, clipId: string) => {
  const { clips } = await rig.records.list({ avatarId: AVATAR });
  return clips.find((c) => c.clipId === clipId);
};

describe("ClipSummary.use", () => {
  test("is absent from every clip when the service has no uses reader (as before 5b.2)", async () => {
    const rig = await world(undefined);
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.every((c) => !("use" in c))).toBe(true);
  });

  test("says inVideo for the clip a finished video holds and for a clip whose photo it uses; the others have no use", async () => {
    const rig = await world({
      videoUse: (_avatarId, clipId) => (clipId === CLIP ? "clip" : clipId === CLIP_B ? "photo" : undefined),
      draftsOf: async () => new Map(),
    });
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    const by = new Map(clips.map((c) => [c.clipId, c]));
    expect(by.get(CLIP)).toMatchObject({ use: { inVideo: "clip" } });
    expect(by.get(CLIP_B)).toMatchObject({ use: { inVideo: "photo" } });
    expect("use" in (by.get(CLIP_C) ?? {})).toBe(false);
  });

  test("asks the used index with the clip and the photo it was made from", async () => {
    const asked: string[] = [];
    const rig = await world({
      videoUse: (avatarId, clipId, photoId) => {
        asked.push(`${avatarId} ${clipId} ${photoId}`);
        return undefined;
      },
      draftsOf: async () => new Map(),
    });
    await rig.records.list({ avatarId: AVATAR });
    expect(asked.sort()).toEqual([`${AVATAR} ${CLIP} photo-0001`, `${AVATAR} ${CLIP_B} photo-0002`, `${AVATAR} ${CLIP_C} photo-0003`].sort());
  });

  test("says inDrafts with the one draft's name and place, or only the count for several", async () => {
    const rig = await world({
      videoUse: () => undefined,
      draftsOf: async () =>
        new Map([
          [CLIP, { count: 1, first: { name: "Лето", frame: 2 } }],
          [CLIP_B, { count: 3 }],
        ]),
    });
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    const by = new Map(clips.map((c) => [c.clipId, c]));
    expect(by.get(CLIP)).toMatchObject({ use: { inDrafts: { count: 1, first: { name: "Лето", frame: 2 } } } });
    expect(by.get(CLIP_B)).toMatchObject({ use: { inDrafts: { count: 3 } } });
    expect("first" in ((by.get(CLIP_B) as { use?: { inDrafts?: object } }).use?.inDrafts ?? {})).toBe(false);
  });

  test("says both when a finished video and a draft use the clip, and every summary stays a contract summary", async () => {
    const rig = await world({ videoUse: () => "clip", draftsOf: async () => new Map([[CLIP, { count: 2 }]]) });
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips.every((c) => ClipSummary.safeParse(c).success)).toBe(true);
    expect((clips.find((c) => c.clipId === CLIP) as { use?: object }).use).toEqual({ inVideo: "clip", inDrafts: { count: 2 } });
  });

  test("a clip that is not ready has no use, whatever the readers say", async () => {
    const rig = await world({ videoUse: () => "clip", draftsOf: async () => new Map([["clip-0000009", { count: 1 }]]) });
    await rig.put(failedRecord("refused-free", undefined, { id: "clip-0000009", createdAt: "2026-10-13T13:00:00.000Z" }));
    const failed = await useOf(rig, "clip-0000009");
    expect(failed).toBeDefined();
    expect("use" in (failed ?? {})).toBe(false);
  });

  test("reads the drafts once for a whole list, not once per clip", async () => {
    let reads = 0;
    const rig = await world({
      videoUse: () => undefined,
      draftsOf: async () => {
        reads++;
        return new Map();
      },
    });
    await rig.records.list({ avatarId: AVATAR });
    expect(reads).toBe(1);
  });

  test("a reader that fails leaves the list whole, with the use it could not read left out", async () => {
    const rig = await world({
      videoUse: () => {
        throw new Error("the index is not readable");
      },
      draftsOf: async () => {
        throw new Error("the drafts are not readable");
      },
    });
    const { clips } = await rig.records.list({ avatarId: AVATAR });
    expect(clips).toHaveLength(3);
    expect(clips.every((c) => !("use" in c))).toBe(true);
    expect(rig.logs.length).toBeGreaterThan(0);
  });

  test("clips.get says the same as the list", async () => {
    const rig = await world({ videoUse: (_a, clipId) => (clipId === CLIP ? "clip" : undefined), draftsOf: async () => new Map([[CLIP, { count: 1, first: { name: null, frame: 1 } }]]) });
    const { clip } = await rig.records.get({ avatarId: AVATAR, clipId: CLIP });
    expect(ClipSummary.safeParse(clip).success).toBe(true);
    expect((clip as { use?: object }).use).toEqual({ inVideo: "clip", inDrafts: { count: 1, first: { name: null, frame: 1 } } });
  });
});
