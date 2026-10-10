import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AvatarSummary, Draft, MAX_UNREADABLE_AVATARS, type AvatarTraits, type UnreadableAvatar } from "../../shared/engine";
import { openLibrary, type QuarantineEntry } from "../library";
import { AvatarManifestSchema, type AvatarManifest, type PhotoSidecar } from "../library/schemas";
import { PNG_1X1, SAMPLE_IMPORTED_SOURCE, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { sceneSpec, writeVideoRecord } from "../library/testing/videoRecords";
import { avatarCounts, avatarSummaryFrom, combineUnreadable, draftFrom, isRewritable, libraryView, manifestTraits, promptDescriptorOf, unreadableFromQuarantine } from "./records";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles", "mole"],
  vibe: "coffee, travel, books",
};

const DESCRIPTOR = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair.";

function manifest(overrides: Partial<AvatarManifest> = {}): AvatarManifest {
  return AvatarManifestSchema.parse({
    schemaVersion: 2,
    id: "avatar-0001",
    name: "Mia",
    age: 25,
    traits: manifestTraits(TRAITS),
    descriptor: DESCRIPTOR,
    masterPhotoId: null,
    status: "draft",
    createdAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  });
}

/** A candidate that passes today's age threshold by default: a stored photo is always one that passed some age check (invariant 8). */
function photo(id: string, avatarId = "avatar-0001", qa: PhotoSidecar["qa"] = { age: { adult: true, confidence: 0.95 } }): PhotoSidecar {
  return {
    schemaVersion: 1,
    id,
    avatarId,
    file: `${id}.png`,
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: 1,
    sha256: "a".repeat(64),
    source: samplePhotoMeta().source,
    qa,
    createdAt: "2026-09-24T10:00:01.000Z",
  };
}

describe("manifestTraits: how a draft's traits are stored in avatar.json", () => {
  test("keeps every trait in its own type: marks stay a list", () => {
    const { age: _age, ...rest } = TRAITS;
    expect(manifestTraits(TRAITS)).toEqual(rest);
    expect(AvatarManifestSchema.parse({ ...manifest(), traits: manifestTraits(TRAITS) }).traits).toEqual(rest);
  });

  test("a record of the comma-joined format is not listed: it no longer fits the contract", () => {
    const joined = { ...manifestTraits(TRAITS), marks: "freckles,mole" };
    expect(draftFrom(manifest({ traits: joined }), [])).toBeNull();
  });

  test("keeps the age out: the manifest has its own age field", () => {
    expect(manifestTraits(TRAITS)).not.toHaveProperty("age");
  });

  const MARK_SETS: AvatarTraits["marks"][] = [["freckles", "mole"], [], ["freckles", "mole", "dimples", "nose-piercing", "wrist-tattoo"]];

  test.each(MARK_SETS.map((marks) => [marks]))("round-trips the marks %p through a draft", (marks) => {
    const traits: AvatarTraits = { ...TRAITS, marks };
    expect(draftFrom(manifest({ traits: manifestTraits(traits) }), [])?.traits).toEqual(traits);
  });

  test("round-trips an empty vibe", () => {
    const traits = { ...TRAITS, vibe: "" };
    expect(draftFrom(manifest({ traits: manifestTraits(traits) }), [])?.traits).toEqual(traits);
  });
});

describe("draftFrom", () => {
  test("builds the contract's draft: traits with the manifest's age, the descriptor as text, the photos as candidates", () => {
    const draft = draftFrom(manifest(), [photo("photo-0001"), photo("photo-0002")]);
    expect(draft).toEqual({
      avatarId: "avatar-0001",
      traits: TRAITS,
      descriptor: { age: 25, text: DESCRIPTOR },
      candidates: [
        { avatarId: "avatar-0001", photoId: "photo-0001" },
        { avatarId: "avatar-0001", photoId: "photo-0002" },
      ],
      hiddenBelowThreshold: 0,
      estimate: null,
    });
    expect(Draft.safeParse(draft).success).toBe(true);
  });

  test("a draft without photos has no candidates yet", () => {
    expect(draftFrom(manifest(), [])?.candidates).toEqual([]);
  });

  test("is null for a saved avatar", () => {
    expect(draftFrom(manifest({ status: "active", masterPhotoId: "photo-0001" }), [photo("photo-0001")])).toBeNull();
  });

  test("is null for traits the contract refuses (an early library's free-form traits)", () => {
    expect(draftFrom(manifest({ traits: { hair: "chestnut", eyes: "hazel" } }), [])).toBeNull();
  });

  test("is null when a stored trait is off the contract's list", () => {
    expect(draftFrom(manifest({ traits: { ...manifestTraits(TRAITS), hairColor: "green" } }), [])).toBeNull();
  });

  test("is null for a descriptor that does not state the age as '<age>-year-old'", () => {
    expect(draftFrom(manifest({ descriptor: "a woman with chestnut hair" }), [])).toBeNull();
  });

  test("is null for a candidate photo of another avatar", () => {
    expect(draftFrom(manifest(), [photo("photo-0001", "avatar-0002")])).toBeNull();
  });

  // Review (MEDIUM): pick used to refuse a candidate the UI still showed —
  // draftFrom listed every photo, whatever its stored age verdict. A
  // below-threshold candidate (e.g. a later, stricter calibration) is no
  // longer offered at all, so a NOT_FOUND at pick is honest.
  test("excludes a candidate whose stored verdict fails today's age threshold, but not one with no verdict at all", () => {
    const passing = photo("photo-0001");
    const stale = photo("photo-0002", "avatar-0001", { age: { adult: true, confidence: 0.5 } });
    // Owner's decision (2026-09-27): with the image age check off, a stored
    // candidate carries no qa.age verdict at all — pickable either way, since
    // the owner's own pick is the gate. Only a verdict that actually failed
    // (`stale` above) stays hidden.
    const neverChecked = photo("photo-0003", "avatar-0001", {});

    expect(draftFrom(manifest(), [passing, stale, neverChecked])?.candidates).toEqual([
      { avatarId: "avatar-0001", photoId: "photo-0001" },
      { avatarId: "avatar-0001", photoId: "photo-0003" },
    ]);
  });

  // The photos stay on disk (invariant 8 never deletes a stored, once-passing
  // photo), but a stricter calibration can hide all of them — this is what
  // tells that apart from a draft that never generated anything at all.
  test("hiddenBelowThreshold counts only candidates whose stored verdict fails, not ones with no verdict", () => {
    const passing = photo("photo-0001");
    const stale = photo("photo-0002", "avatar-0001", { age: { adult: true, confidence: 0.5 } });
    const neverChecked = photo("photo-0003", "avatar-0001", {});

    expect(draftFrom(manifest(), [passing, stale, neverChecked])?.hiddenBelowThreshold).toBe(1);
  });

  test("hiddenBelowThreshold is 0 when nothing is hidden, photos or not", () => {
    expect(draftFrom(manifest(), [])?.hiddenBelowThreshold).toBe(0);
    expect(draftFrom(manifest(), [photo("photo-0001"), photo("photo-0002")])?.hiddenBelowThreshold).toBe(0);
  });

  test("every candidate with no verdict at all (the image age check was off) is shown, and none is hidden", () => {
    const noVerdictA = photo("photo-0001", "avatar-0001", {});
    const noVerdictB = photo("photo-0002", "avatar-0001", {});

    const draft = draftFrom(manifest(), [noVerdictA, noVerdictB]);
    expect(draft?.candidates).toEqual([
      { avatarId: "avatar-0001", photoId: "photo-0001" },
      { avatarId: "avatar-0001", photoId: "photo-0002" },
    ]);
    expect(draft?.hiddenBelowThreshold).toBe(0);
  });

  test("a draft whose every candidate now falls below threshold still reports their count, not zero", () => {
    const stale1 = photo("photo-0001", "avatar-0001", { age: { adult: true, confidence: 0.5 } });
    const stale2 = photo("photo-0002", "avatar-0001", { age: { adult: true, confidence: 0.5 } });

    const draft = draftFrom(manifest(), [stale1, stale2]);
    expect(draft?.candidates).toEqual([]);
    expect(draft?.hiddenBelowThreshold).toBe(2);
  });
});

describe("avatarSummaryFrom", () => {
  const NO_PHOTOS = { photoCount: 0, videoCount: 0, eligibleUnusedCount: 0, usage: { state: "ok" } } as const;
  const active = manifest({ status: "active", masterPhotoId: "photo-0001", name: "Mia" });

  test("builds the contract's summary with the photo, video and eligible-unused counts", () => {
    const summary = avatarSummaryFrom(active, { photoCount: 3, videoCount: 2, eligibleUnusedCount: 1, usage: { state: "ok" } });
    expect(summary).toEqual({
      avatarId: "avatar-0001",
      name: "Mia",
      descriptor: { age: 25, text: DESCRIPTOR },
      masterPhotoId: "photo-0001",
      createdAt: "2026-09-24T10:00:00.000Z",
      status: "active",
      photoCount: 3,
      videoCount: 2,
      eligibleUnusedCount: 1,
      usage: { state: "ok" },
    });
    expect(AvatarSummary.safeParse(summary).success).toBe(true);
  });

  test("carries an unknown usage with its reasons (3e.2, K16)", () => {
    const summary = avatarSummaryFrom(active, { photoCount: 3, videoCount: 2, eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["record-unreadable", "rejects-unreadable"] } });
    expect(summary?.usage).toEqual({ state: "unknown", reasons: ["record-unreadable", "rejects-unreadable"] });
  });

  test("keeps an archived avatar archived", () => {
    expect(avatarSummaryFrom({ ...active, status: "archived" }, NO_PHOTOS)?.status).toBe("archived");
  });

  test("is null for a draft: drafts are listed separately", () => {
    expect(avatarSummaryFrom(manifest(), NO_PHOTOS)).toBeNull();
  });

  test("is null for a name the contract refuses", () => {
    expect(avatarSummaryFrom({ ...active, name: "x".repeat(61) }, NO_PHOTOS)).toBeNull();
  });
});

describe("isRewritable", () => {
  const active = manifest({ status: "active", masterPhotoId: "photo-0001", name: "Mia" });
  const BAD_DESCRIPTOR = "a young woman with hazel eyes";

  test("true for a draft or a saved avatar whose descriptor alone is bad: a good one would make it fit", () => {
    expect(isRewritable(manifest({ descriptor: BAD_DESCRIPTOR }))).toBe(true);
    expect(isRewritable({ ...active, descriptor: BAD_DESCRIPTOR })).toBe(true);
  });

  test("true even when the descriptor already fits: rewritability does not ask whether there is anything to fix", () => {
    expect(isRewritable(manifest())).toBe(true);
    expect(isRewritable(active)).toBe(true);
  });

  test("false for schema version 1 (free-form, untyped traits), whatever the descriptor says", () => {
    const v1 = AvatarManifestSchema.parse({ ...active, schemaVersion: 1, traits: { ethnicity: "european" }, descriptor: BAD_DESCRIPTOR });
    expect(isRewritable(v1)).toBe(false);
  });

  test("false when the stored traits (the vibe included) no longer parse as AvatarTraits: nothing valid to feed the descriptor job", () => {
    const badVibe = manifest({ traits: manifestTraits({ ...TRAITS, vibe: "teen look" }), descriptor: BAD_DESCRIPTOR });
    expect(isRewritable(badVibe)).toBe(false);
  });

  test("false for a name over 60 chars: no descriptor could make the record fit AvatarSummary", () => {
    expect(isRewritable({ ...active, name: "N".repeat(61), descriptor: BAD_DESCRIPTOR })).toBe(false);
  });

  test("does not require the master photo to exist: only the record's shape, never disk state", () => {
    expect(isRewritable({ ...active, masterPhotoId: "photo-does-not-exist", descriptor: BAD_DESCRIPTOR })).toBe(true);
  });
});

describe("libraryView over a real library", () => {
  const root = useTempDir("studio-records-");

  test("lists saved avatars and drafts apart, oldest first, and names every record it had to skip", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("avatar") });
    const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
    const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
    const candidate = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    const early = await library.createAvatar({ name: "Early", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR });

    const view = libraryView(library);

    // The master portrait is not a gallery photo, so a saved avatar with only it has none.
    expect(view.avatars.map((a) => [a.avatarId, a.photoCount])).toEqual([[saved.id, 0]]);
    expect(view.drafts.map((d) => [d.avatarId, d.candidates.map((c) => c.photoId)])).toEqual([[draft.id, [candidate.id]]]);
    expect(view.skipped).toEqual([{ avatarId: early.id, name: "Early", reason: "contract-mismatch" }]);
  });

  test("photoCount is the run photos only: a master, an unpicked candidate and an import are not gallery photos", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("count") });
    const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
    const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
    await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE }));
    await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
    const generated = samplePhotoMeta().source;
    if (generated.kind !== "generated") throw new Error("expected a generated sample source");
    for (const n of [1, 2]) await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta({ source: { ...generated, category: "home", attemptId: `run-00000001:slot-${n}#1`, slot: `slot-${n}` } }));

    expect(libraryView(library).avatars.map((a) => a.photoCount)).toEqual([2]);
  });

  /** A saved avatar with three scene photos (oldest first) in a real library; the master is a promoted candidate. */
  async function avatarWithScenes(prefix: string) {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds(prefix) });
    const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
    const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
    const generated = samplePhotoMeta().source;
    if (generated.kind !== "generated") throw new Error("expected a generated sample source");
    const photos = [];
    for (const n of [1, 2, 3]) photos.push(await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta({ source: { ...generated, category: "home", attemptId: `run-00000001:slot-${n}#1`, slot: `slot-${n}` } })));
    return { library, saved, photos };
  }

  test("videoCount counts the records and eligibleUnusedCount leaves out the used, the rejected and the reserved", async () => {
    const reserved = new Set<string>();
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("cnt"), reservedPhotos: () => reserved });
    const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
    const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
    const generated = samplePhotoMeta().source;
    if (generated.kind !== "generated") throw new Error("expected a generated sample source");
    const scenes = [];
    for (const n of [1, 2, 3, 4]) scenes.push(await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta({ source: { ...generated, category: "home", attemptId: `run-00000001:slot-${n}#1`, slot: `slot-${n}` } })));
    const [used, rejected, held, free] = scenes;
    if (used === undefined || rejected === undefined || held === undefined || free === undefined) throw new Error("expected four scene photos");
    await writeVideoRecord(root(), "video-00000001", sceneSpec(saved.id, [used.id]));
    await library.reloadVideoRecords(saved.id);
    await library.setRejected(saved.id, rejected.id, true);
    reserved.add(held.id);

    const [summary] = libraryView(library).avatars;
    expect(summary).toMatchObject({ photoCount: 4, videoCount: 1, eligibleUnusedCount: 1 });
  });

  test("an avatar whose video records cannot all be read is still listed, with no eligible-unused photo", async () => {
    const { library, saved } = await avatarWithScenes("brk");
    await mkdir(join(root(), "avatars", saved.id, "videos"), { recursive: true });
    await writeFile(join(root(), "avatars", saved.id, "videos", "video-00000001.json"), "{ not json");
    await library.reloadVideoRecords(saved.id);
    expect(libraryView(library).avatars.map((a) => [a.photoCount, a.videoCount, a.eligibleUnusedCount])).toEqual([[3, 0, 0]]);
  });

  test("a listed avatar says why its usage is unknown, from the library's own reasons; a sound one says ok (3e.2, K16)", async () => {
    const { library, saved } = await avatarWithScenes("usg");
    expect(libraryView(library).avatars.map((a) => a.usage)).toEqual([{ state: "ok" }]);
    await mkdir(join(root(), "avatars", saved.id, "videos"), { recursive: true });
    await writeFile(join(root(), "avatars", saved.id, "videos", "video-00000001.json"), "{ not json");
    await library.reloadVideoRecords(saved.id);
    library.flagVideoIndexStale(saved.id, "video-00000002");
    expect(libraryView(library).avatars.map((a) => a.usage)).toEqual([{ state: "unknown", reasons: ["index-stale", "record-unreadable"] }]);
    expect(avatarCounts(library, saved.id).usage).toEqual({ state: "unknown", reasons: ["index-stale", "record-unreadable"] });
  });

  test("names a saved avatar whose stored descriptor no longer fits today's rules with reason descriptor-invalid", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("bad") });
    const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });
    const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });

    expect(libraryView(library).skipped).toEqual([{ avatarId: saved.id, name: "Mia", reason: "descriptor-invalid" }]);
  });

  test("names a draft whose stored descriptor no longer fits today's rules with reason descriptor-invalid", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("bad-draft") });
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });

    expect(libraryView(library).skipped).toEqual([{ avatarId: draft.id, name: "Draft", reason: "descriptor-invalid" }]);
  });

  test("a draft whose vibe ALSO fails today's rules is contract-mismatch, not descriptor-invalid: rewriting the descriptor alone cannot fix it", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("bad-vibe") });
    const draft = await library.createAvatar({
      name: "Draft",
      age: 25,
      traits: manifestTraits({ ...TRAITS, vibe: "teen look" }),
      descriptor: "a young woman with hazel eyes",
    });

    expect(libraryView(library).skipped).toEqual([{ avatarId: draft.id, name: "Draft", reason: "contract-mismatch" }]);
  });

  test("an active avatar with a name over 60 chars and a bad descriptor is contract-mismatch: no descriptor could make it fit", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("long-name") });
    const avatar = await library.createAvatar({ name: "N".repeat(61), age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });

    expect(libraryView(library).skipped).toEqual([{ avatarId: avatar.id, name: null, reason: "contract-mismatch" }]);
  });

  test("an empty library has nothing to list", async () => {
    const { library } = await openLibrary(root());
    expect(libraryView(library)).toEqual({ avatars: [], drafts: [], skipped: [] });
  });

  test("carries the manifest's own name for a record it must skip, whatever the skip reason: the manifest was still read", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("named-skip") });
    const draft = await library.createAvatar({
      name: "Iris",
      age: 25,
      traits: manifestTraits({ ...TRAITS, vibe: "teen look" }),
      descriptor: "a young woman with hazel eyes",
    });

    expect(libraryView(library).skipped).toEqual([{ avatarId: draft.id, name: "Iris", reason: "contract-mismatch" }]);
  });

  test("gives no name when the manifest's own name no longer fits the contract (over 60 chars)", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("unnamed-skip") });
    const avatar = await library.createAvatar({ name: "N".repeat(61), age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });

    expect(libraryView(library).skipped).toEqual([{ avatarId: avatar.id, name: null, reason: "contract-mismatch" }]);
  });
});

describe("unreadableFromQuarantine", () => {
  function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
    return { from: join("avatars", "avatar-0001"), to: join("quarantine", "2026-09-24T10-00-00-000Z", "avatars", "avatar-0001"), reason: "invalid-manifest", ...overrides };
  }

  test("names the folder's id and a fixed, generic detail, never the quarantine's own diagnostics", () => {
    expect(unreadableFromQuarantine([entry({ detail: "unexpected token in the manifest, holding a secret nobody should echo" })])).toEqual([
      { avatarId: "avatar-0001", name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
    ]);
  });

  test("ignores every other quarantine reason: only a whole manifest failure belongs in the unreadable list", () => {
    const others: QuarantineEntry[] = [
      entry({ reason: "orphan-image", from: join("avatars", "avatar-0001", "photos", "photo-0001.png") }),
      entry({ reason: "orphan-sidecar", from: join("avatars", "avatar-0001", "photos", "photo-0001.json") }),
      entry({ reason: "invalid-sidecar", from: join("avatars", "avatar-0001", "photos", "photo-0001.json") }),
      entry({ reason: "invalid-image", from: join("avatars", "avatar-0001", "photos", "photo-0001.png") }),
      entry({ reason: "temp-file", from: join("avatars", ".avatar-0001.tmp-x") }),
    ];
    expect(unreadableFromQuarantine(others)).toEqual([]);
  });

  test("is null for a folder name that does not fit the library id pattern", () => {
    expect(unreadableFromQuarantine([entry({ from: join("avatars", "Not An Id") })])).toEqual([
      { avatarId: null, name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
    ]);
  });

  test("is bounded at MAX_UNREADABLE_AVATARS", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry({ from: join("avatars", `avatar-000${i}`) }));
    expect(unreadableFromQuarantine(many, 3)).toHaveLength(3);
  });

  test("gives no name: a quarantined manifest was never parsed, so no trustworthy name exists", () => {
    expect(unreadableFromQuarantine([entry()])).toEqual([
      { avatarId: "avatar-0001", name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
    ]);
  });
});

describe("combineUnreadable (L2, L11)", () => {
  const descriptorInvalid = (n: number): UnreadableAvatar => ({ avatarId: `avatar-fix-${n}`, name: `Fix ${n}`, reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" });
  const contractMismatch = (n: number): UnreadableAvatar => ({ avatarId: `avatar-mis-${n}`, name: `Mismatch ${n}`, reason: "contract-mismatch", detail: "its stored record no longer fits the contract" });
  const manifestUnreadable = (n: number): UnreadableAvatar => ({ avatarId: `avatar-qtn-${n}`, name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" });

  test("keeps every entry, uncut, when there are fewer than the bound", () => {
    const result = combineUnreadable([descriptorInvalid(1), contractMismatch(1)], [manifestUnreadable(1)], 10);
    expect(result.map((u) => u.avatarId)).toEqual(["avatar-fix-1", "avatar-mis-1", "avatar-qtn-1"]);
  });

  test("a rewritable (descriptor-invalid) entry survives the cut ahead of quarantined manifest-unreadable ones (L2)", () => {
    const quarantined = Array.from({ length: 5 }, (_, i) => manifestUnreadable(i));
    const result = combineUnreadable([descriptorInvalid(1)], quarantined, 3);

    expect(result).toHaveLength(3);
    expect(result[0]?.avatarId).toBe("avatar-fix-1");
  });

  test("a rewritable entry also survives ahead of contract-mismatch entries from the same library", () => {
    const mismatches = Array.from({ length: 5 }, (_, i) => contractMismatch(i));
    const result = combineUnreadable([descriptorInvalid(1), ...mismatches], [], 3);

    expect(result[0]?.avatarId).toBe("avatar-fix-1");
    expect(result).toHaveLength(3);
  });

  test("keeps the original order within one priority (oldest avatar first)", () => {
    const result = combineUnreadable([descriptorInvalid(1), descriptorInvalid(2), descriptorInvalid(3)], [], 10);
    expect(result.map((u) => u.avatarId)).toEqual(["avatar-fix-1", "avatar-fix-2", "avatar-fix-3"]);
  });

  test("defaults to MAX_UNREADABLE_AVATARS", () => {
    const many = Array.from({ length: MAX_UNREADABLE_AVATARS + 5 }, (_, i) => manifestUnreadable(i));
    expect(combineUnreadable([], many)).toHaveLength(MAX_UNREADABLE_AVATARS);
  });
});

// ---------- Stage 5, S5.2a: the body ----------

describe("promptDescriptorOf: the descriptor a prompt carries", () => {
  const BODY = { height: "tall", bust: "full", legLength: "long", legShape: "slim" } as const;
  const withBody = (body: Record<string, unknown>, extra: Partial<AvatarManifest> = {}): AvatarManifest =>
    manifest({ status: "active", masterPhotoId: "photo-0001", traits: { ...manifestTraits(TRAITS), ...body } as AvatarManifest["traits"], ...extra });

  test("an avatar with no body keys is her age and text and nothing else: no body key at all", () => {
    const descriptor = promptDescriptorOf(manifest());
    expect(descriptor).toEqual({ age: 25, text: DESCRIPTOR });
    expect("body" in descriptor).toBe(false);
  });

  test("carries the body phrase the code renders from her traits, apart from the text", () => {
    expect(promptDescriptorOf(withBody(BODY))).toEqual({ age: 25, text: DESCRIPTOR, body: "tall, a full bust and long slim legs" });
  });

  test("never writes the phrase into the text", () => {
    expect(promptDescriptorOf(withBody(BODY)).text).toBe(DESCRIPTOR);
  });

  test("a body key that does not parse drops the whole body, not the avatar", () => {
    const descriptor = promptDescriptorOf(withBody({ ...BODY, bust: "gigantic" }));
    expect(descriptor).toEqual({ age: 25, text: DESCRIPTOR });
  });

  test("a body of an empty list of marks adds nothing", () => {
    expect("body" in promptDescriptorOf(withBody({ bodyMarks: [] }))).toBe(false);
  });

  test("a schema-version-1 record has no body: its traits are free text", () => {
    expect("body" in promptDescriptorOf(withBody({ height: "tall" }, { schemaVersion: 1, traits: { height: "tall" } }))).toBe(false);
  });

  test("the text of the stored body proposal is never a body: only traits are", () => {
    const proposed = withBody({}, { bodyProposal: { values: { height: "tall" }, seen: { height: "photo" }, at: "2026-10-10T10:00:00.000Z" } });
    expect("body" in promptDescriptorOf(proposed)).toBe(false);
  });
});

describe("the body in a draft and a summary", () => {
  const active = (traits: Record<string, unknown>, extra: Partial<AvatarManifest> = {}): AvatarManifest =>
    manifest({ status: "active", masterPhotoId: "photo-0001", traits: traits as AvatarManifest["traits"], ...extra });
  const COUNTS = { photoCount: 0, videoCount: 0, eligibleUnusedCount: 0, usage: { state: "ok" } } as const;

  test("a summary of an avatar with no body carries neither body nor bodyProposal", () => {
    const summary = avatarSummaryFrom(active(manifestTraits(TRAITS)), COUNTS);
    expect(summary).not.toBeNull();
    expect("body" in (summary ?? {})).toBe(false);
    expect("bodyProposal" in (summary ?? {})).toBe(false);
  });

  test("a summary carries her body traits, parsed", () => {
    const summary = avatarSummaryFrom(active({ ...manifestTraits(TRAITS), height: "tall", bodyMarks: ["mole-back"] }), COUNTS);
    expect(summary?.body).toEqual({ height: "tall", bodyMarks: ["mole-back"] });
  });

  test("a body key that fails to parse drops the body: the avatar is still listed", () => {
    const summary = avatarSummaryFrom(active({ ...manifestTraits(TRAITS), height: "tall", figure: "triangle" }), COUNTS);
    expect(summary).not.toBeNull();
    expect("body" in (summary ?? {})).toBe(false);
  });

  test("three body marks drop the body, not the avatar", () => {
    const summary = avatarSummaryFrom(active({ ...manifestTraits(TRAITS), bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] }), COUNTS);
    expect(summary).not.toBeNull();
    expect("body" in (summary ?? {})).toBe(false);
  });

  test("a stored body proposal is carried", () => {
    const bodyProposal = { values: { bust: "full" }, seen: { bust: "photo" }, at: "2026-10-10T10:00:00.000Z" };
    expect<unknown>(avatarSummaryFrom(active(manifestTraits(TRAITS), { bodyProposal }), COUNTS)?.bodyProposal).toEqual(bodyProposal);
  });

  test("a stored body proposal that no longer fits the contract is left out: the avatar is still listed", () => {
    const bodyProposal = { values: { bust: "gigantic" }, seen: { bust: "photo" }, at: "2026-10-10T10:00:00.000Z" };
    const summary = avatarSummaryFrom(active(manifestTraits(TRAITS), { bodyProposal }), COUNTS);
    expect(summary).not.toBeNull();
    expect("bodyProposal" in (summary ?? {})).toBe(false);
  });

  test("the summary's descriptor never holds the phrase", () => {
    const summary = avatarSummaryFrom(active({ ...manifestTraits(TRAITS), height: "tall" }), COUNTS);
    expect(summary?.descriptor).toEqual({ age: 25, text: DESCRIPTOR });
  });

  test("a draft keeps its body traits, and a bad body key does not make the draft unreadable", () => {
    const traits = { ...TRAITS, height: "tall", bust: "full" } satisfies AvatarTraits;
    expect(draftFrom(manifest({ traits: manifestTraits(traits) }), [])?.traits).toEqual(traits);
    expect(draftFrom(manifest({ traits: { ...manifestTraits(TRAITS), height: "gigantic" } as AvatarManifest["traits"] }), [])?.traits).toEqual(TRAITS);
  });

  test("a bad body key does not make an avatar unrewritable", () => {
    expect(isRewritable(active({ ...manifestTraits(TRAITS), legShape: "wooden" }, { descriptor: "a woman with chestnut hair" }))).toBe(true);
  });

  test("manifestTraits stores an empty list of body marks as absent, as setBody does", () => {
    const stored = manifestTraits({ ...TRAITS, height: "tall", bodyMarks: [] });
    expect(stored).toHaveProperty("height", "tall");
    expect("bodyMarks" in stored).toBe(false);
  });

  test("a summary never carries bodyMarks: [] even when the record holds one beside other body keys", () => {
    const summary = avatarSummaryFrom(active({ ...manifestTraits(TRAITS), height: "tall", bodyMarks: [] }), COUNTS);
    expect(summary?.body).toEqual({ height: "tall" });
    expect(summary?.body !== undefined && "bodyMarks" in summary.body).toBe(false);
  });

  test("manifestTraits leaves a body key that was never set out of the record", () => {
    const traits = { ...TRAITS, height: "tall", bust: undefined } satisfies AvatarTraits;
    const stored = manifestTraits(traits);
    expect(stored).toHaveProperty("height", "tall");
    expect("bust" in stored).toBe(false);
  });
});
