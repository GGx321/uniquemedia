import { describe, expect, test } from "bun:test";
import { openLibrary, type LibraryDeps } from "./library";
import { JPEG_HEADER_ONLY, PNG_1X1, SAMPLE_AVATAR, SAMPLE_IMPORTED_SOURCE, SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA5, plan s5a4 I5.74, §5.6, §8 S5.BA5): whether an avatar was created in Studio. A POSITIVE wizard check: an active avatar with no imported photo whose master is a generated
// `candidate-N` photo (a wizard candidate, avatars/candidateJob.ts). Anything else reads as imported, the fail-closed side: an imported photo, a `portrait-N` master, a master with no
// wizard slot (a record from before the slot was written, the parity world's Mia), a draft, an unknown avatar. The fixtures Ava, Bea and Cleo stand for the three shapes.

const root = useTempDir("studio-origin-");

function deps(): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds() };
}

const generated = (slot: string | undefined) => samplePhotoMeta({ source: { ...SAMPLE_SOURCE, ...(slot === undefined ? {} : { slot }) } });

/** An active avatar whose master is a generated photo in `slot` (no slot at all when undefined). */
async function wizardAvatar(slot: string | undefined) {
  const { library } = await openLibrary(root(), deps());
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const master = await library.addPhoto(avatar.id, PNG_1X1, generated(slot));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return { library, avatar, master };
}

describe("studioCreated", () => {
  test("Ava, made in the wizard: the master is its candidate-4 and there is no imported photo", async () => {
    const { library, avatar } = await wizardAvatar("candidate-4");
    expect(library.studioCreated(avatar.id)).toBe(true);
  });

  test("Bea, imported: a portrait-1 master drawn from her imported photo", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar({ ...SAMPLE_AVATAR, photoBytes: JPEG_HEADER_ONLY, photoMeta: samplePhotoMeta({ mediaType: "image/jpeg", source: SAMPLE_IMPORTED_SOURCE }) });
    const portrait = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, slot: "portrait-1" }, qa: { faceCos: 0.8, age: { adult: true, confidence: 0.95 } } }));
    await library.switchMaster(avatar.id, portrait.id);
    expect(library.getAvatar(avatar.id)?.masterPhotoId).toBe(portrait.id);
    expect(library.studioCreated(avatar.id)).toBe(false);
  });

  test("Cleo, imported: the master is the imported photo itself", async () => {
    const { library } = await openLibrary(root(), deps());
    const { avatar } = await library.createImportedAvatar({ ...SAMPLE_AVATAR, photoBytes: JPEG_HEADER_ONLY, photoMeta: samplePhotoMeta({ mediaType: "image/jpeg", source: SAMPLE_IMPORTED_SOURCE }) });
    expect(library.studioCreated(avatar.id)).toBe(false);
  });

  test("a wizard master beside an imported photo reads as imported", async () => {
    const { library, avatar } = await wizardAvatar("candidate-1");
    await library.addPhoto(avatar.id, JPEG_HEADER_ONLY, samplePhotoMeta({ mediaType: "image/jpeg", source: SAMPLE_IMPORTED_SOURCE }));
    expect(library.studioCreated(avatar.id)).toBe(false);
  });

  test.each([
    ["no slot (the parity world's Mia, SAMPLE_SOURCE)", undefined],
    ["a portrait slot", "portrait-2"],
    ["a run's slot", "slot-1"],
    ["a candidate-0", "candidate-0"],
    ["a slot that only starts like a candidate's", "candidate-1x"],
  ])("a generated master with %s reads as imported", async (_name, slot) => {
    const { library, avatar } = await wizardAvatar(slot);
    expect(library.studioCreated(avatar.id)).toBe(false);
  });

  test("a run photo as the master reads as imported: it carries a scene category", async () => {
    const { library } = await openLibrary(root(), deps());
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ source: { ...SAMPLE_SOURCE, slot: "candidate-1", category: "home" } }));
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
    expect(library.studioCreated(avatar.id)).toBe(false);
  });

  test("a draft is not yet an avatar made in Studio", async () => {
    const { library } = await openLibrary(root(), deps());
    const draft = await library.createAvatar(SAMPLE_AVATAR);
    await library.addPhoto(draft.id, PNG_1X1, generated("candidate-2"));
    expect(library.studioCreated(draft.id)).toBe(false);
  });

  test("an unknown avatar reads as imported", async () => {
    const { library } = await openLibrary(root(), deps());
    expect(library.studioCreated("avatar-unknown-0001")).toBe(false);
  });
});
