import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openLibrary } from "./library";
import { PNG_1X1, SAMPLE_AVATAR, SAMPLE_IMPORTED_SOURCE, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
useNativeGlobals();

// S4.5c (plan §3.6 step 6): the photos of a run. The orchestrator collects a slice's new photos from `RunResult.photoIds`, and after a restart from the photos whose `attemptId` starts with
// the run id (`${runId}:slot-N#k`, the one place a generated photo's run is recorded). The prefix is the run id AND the colon: `run-00000001` is not `run-000000010`.

const root = useTempDir("studio-photos-of-run-");

async function fixture() {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Zoe" });
  const generated = (attemptId: string, category: string | null = "home") => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, attemptId, ...(category === null ? {} : { category }) } });
  return { library, avatar, other, generated };
}

describe("Library.photoIdsOfRun", () => {
  test("a run with no photos answers an empty list", async () => {
    const { library, avatar } = await fixture();
    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([]);
  });

  test("answers the run's photos in the order they were made, and no other run's", async () => {
    const { library, avatar, generated } = await fixture();
    const first = await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-1#1"));
    await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000002:slot-1#1"));
    const second = await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-2#1"));

    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([first.id, second.id]);
  });

  test("a run id that only begins the same does not match: run-00000001 is not run-000000010", async () => {
    const { library, avatar, generated } = await fixture();
    await library.addPhoto(avatar.id, PNG_1X1, generated("run-000000010:slot-1#1"));
    const mine = await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-1#1"));

    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([mine.id]);
  });

  test("another avatar's photos of a run of the same id are not this avatar's", async () => {
    const { library, avatar, other, generated } = await fixture();
    const mine = await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-1#1"));
    await library.addPhoto(other.id, PNG_1X1, generated("run-00000001:slot-1#1"));

    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([mine.id]);
  });

  test("an imported photo is never a photo of a run", async () => {
    const { library, avatar } = await fixture();
    await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE }));

    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([]);
  });

  test("a generated photo with no scene category (a candidate portrait) is not a photo of a run", async () => {
    const { library, avatar, generated } = await fixture();
    await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-1#1", null));

    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([]);
  });

  test("a rejected photo of the run is still listed: the caller judges eligibility", async () => {
    const { library, avatar, generated } = await fixture();
    const photo = await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-1#1"));
    await library.setRejected(avatar.id, photo.id, true);

    expect(library.photoIdsOfRun(avatar.id, "run-00000001")).toEqual([photo.id]);
  });

  test("an id that is not a run id (empty, a path) matches nothing", async () => {
    const { library, avatar, generated } = await fixture();
    await library.addPhoto(avatar.id, PNG_1X1, generated("run-00000001:slot-1#1"));

    expect(library.photoIdsOfRun(avatar.id, "")).toEqual([]);
    expect(library.photoIdsOfRun(avatar.id, "../run")).toEqual([]);
  });
});
