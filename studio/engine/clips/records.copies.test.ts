import { afterEach, describe, expect, test } from "bun:test";
import { stat, writeFile } from "node:fs/promises";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { AVATAR, CLIP, clipFilePath, clipRecordPath, createRecordsRig, posterPath, readyRecord, type RecordsRig } from "./testing/recordsRig";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.59): a clips.delete removes the clip's montage copy FIRST, under the clip's lock, and the clip only then. The copy rules themselves are pinned in copies.test.ts; here the delete's
// order and what a refusal of the copy leaves behind.

const rigs: RecordsRig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.cleanup()));
});

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

async function world(removeOf: (clipId: string) => Promise<unknown>) {
  const asked: string[] = [];
  const rig = await createRecordsRig({
    deps: {
      copies: {
        removeOf: async (clipId) => {
          asked.push(clipId);
          return removeOf(clipId);
        },
      },
    },
  });
  rigs.push(rig);
  await writeFile(clipFilePath(rig.clipsDir, CLIP), "clip");
  await writeFile(posterPath(rig.clipsDir, CLIP), "poster");
  await rig.put(readyRecord());
  const survivors = async (): Promise<boolean[]> => Promise.all([exists(clipRecordPath(rig.clipsDir, CLIP)), exists(clipFilePath(rig.clipsDir, CLIP)), exists(posterPath(rig.clipsDir, CLIP))]);
  return { rig, asked, survivors };
}

describe("clips.delete and the clip's copy", () => {
  test("removes the copy first: when it is asked the clip is still whole, and afterwards the clip is gone", async () => {
    let seen: boolean[] = [];
    const w = await world(async () => {
      seen = await w.survivors();
    });

    await w.rig.records.delete({ avatarId: AVATAR, clipId: CLIP });

    expect(w.asked).toEqual([CLIP]);
    expect(seen).toEqual([true, true, true]);
    expect(await w.survivors()).toEqual([false, false, false]);
  });

  test("a copy a render holds: IN_FLIGHT in-use, and the record, the file and the poster stay", async () => {
    const w = await world(async () => {
      throw new EngineFailure({ code: "IN_FLIGHT", clipReason: "in-use", detail: "a render holds the copy" });
    });

    let error: unknown;
    await w.rig.records.delete({ avatarId: AVATAR, clipId: CLIP }).catch((e: unknown) => (error = e));

    expect(error instanceof EngineFailure && error.error).toMatchObject({ code: "IN_FLIGHT", clipReason: "in-use" });
    expect(await w.survivors()).toEqual([true, true, true]);
  });

  test("a copy that cannot be removed leaves the clip whole too", async () => {
    const w = await world(async () => {
      throw new EngineFailure({ code: "INTERNAL", detail: "the clip's copy for the montage could not be removed" });
    });
    await expect(w.rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toBeInstanceOf(EngineFailure);
    expect(await w.survivors()).toEqual([true, true, true]);
  });

  test("a clip another job works on is job-running before the copy is touched", async () => {
    const w = await world(async () => undefined);
    w.rig.state.busy.add(CLIP);
    await expect(w.rig.records.delete({ avatarId: AVATAR, clipId: CLIP })).rejects.toMatchObject({ error: { code: "IN_FLIGHT", clipReason: "job-running" } });
    expect(w.asked).toEqual([]);
  });

  test("a clip that is not there is NOT_FOUND before the copy is touched", async () => {
    const w = await world(async () => undefined);
    await expect(w.rig.records.delete({ avatarId: AVATAR, clipId: "clip-0000099" })).rejects.toMatchObject({ error: { code: "NOT_FOUND" } });
    expect(w.asked).toEqual([]);
  });
});
