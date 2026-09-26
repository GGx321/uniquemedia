import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AvatarSummary, Draft, MAX_UNREADABLE_AVATARS, type AvatarTraits, type UnreadableAvatar } from "../../shared/engine";
import { openLibrary, type QuarantineEntry } from "../library";
import { AvatarManifestSchema, type AvatarManifest, type PhotoSidecar } from "../library/schemas";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { avatarSummaryFrom, combineUnreadable, draftFrom, isRewritable, libraryView, manifestTraits, unreadableFromQuarantine } from "./records";

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

function photo(id: string, avatarId = "avatar-0001"): PhotoSidecar {
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
    qa: {},
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
});

describe("avatarSummaryFrom", () => {
  const active = manifest({ status: "active", masterPhotoId: "photo-0001", name: "Mia" });

  test("builds the contract's summary with the photo count", () => {
    const summary = avatarSummaryFrom(active, 3);
    expect(summary).toEqual({
      avatarId: "avatar-0001",
      name: "Mia",
      descriptor: { age: 25, text: DESCRIPTOR },
      masterPhotoId: "photo-0001",
      createdAt: "2026-09-24T10:00:00.000Z",
      status: "active",
      photoCount: 3,
    });
    expect(AvatarSummary.safeParse(summary).success).toBe(true);
  });

  test("keeps an archived avatar archived", () => {
    expect(avatarSummaryFrom({ ...active, status: "archived" }, 0)?.status).toBe("archived");
  });

  test("is null for a draft: drafts are listed separately", () => {
    expect(avatarSummaryFrom(manifest(), 0)).toBeNull();
  });

  test("is null for a name the contract refuses", () => {
    expect(avatarSummaryFrom({ ...active, name: "x".repeat(61) }, 0)).toBeNull();
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
    const candidate = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
    const early = await library.createAvatar({ name: "Early", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR });

    const view = libraryView(library);

    expect(view.avatars.map((a) => [a.avatarId, a.photoCount])).toEqual([[saved.id, 1]]);
    expect(view.drafts.map((d) => [d.avatarId, d.candidates.map((c) => c.photoId)])).toEqual([[draft.id, [candidate.id]]]);
    expect(view.skipped).toEqual([{ avatarId: early.id, reason: "contract-mismatch" }]);
  });

  test("names a saved avatar whose stored descriptor no longer fits today's rules with reason descriptor-invalid", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("bad") });
    const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });
    const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });

    expect(libraryView(library).skipped).toEqual([{ avatarId: saved.id, reason: "descriptor-invalid" }]);
  });

  test("names a draft whose stored descriptor no longer fits today's rules with reason descriptor-invalid", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("bad-draft") });
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });

    expect(libraryView(library).skipped).toEqual([{ avatarId: draft.id, reason: "descriptor-invalid" }]);
  });

  test("a draft whose vibe ALSO fails today's rules is contract-mismatch, not descriptor-invalid: rewriting the descriptor alone cannot fix it", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("bad-vibe") });
    const draft = await library.createAvatar({
      name: "Draft",
      age: 25,
      traits: manifestTraits({ ...TRAITS, vibe: "teen look" }),
      descriptor: "a young woman with hazel eyes",
    });

    expect(libraryView(library).skipped).toEqual([{ avatarId: draft.id, reason: "contract-mismatch" }]);
  });

  test("an active avatar with a name over 60 chars and a bad descriptor is contract-mismatch: no descriptor could make it fit", async () => {
    const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds("long-name") });
    const avatar = await library.createAvatar({ name: "N".repeat(61), age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });
    const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });

    expect(libraryView(library).skipped).toEqual([{ avatarId: avatar.id, reason: "contract-mismatch" }]);
  });

  test("an empty library has nothing to list", async () => {
    const { library } = await openLibrary(root());
    expect(libraryView(library)).toEqual({ avatars: [], drafts: [], skipped: [] });
  });
});

describe("unreadableFromQuarantine", () => {
  function entry(overrides: Partial<QuarantineEntry> = {}): QuarantineEntry {
    return { from: join("avatars", "avatar-0001"), to: join("quarantine", "2026-09-24T10-00-00-000Z", "avatars", "avatar-0001"), reason: "invalid-manifest", ...overrides };
  }

  test("names the folder's id and a fixed, generic detail, never the quarantine's own diagnostics", () => {
    expect(unreadableFromQuarantine([entry({ detail: "unexpected token in the manifest, holding a secret nobody should echo" })])).toEqual([
      { avatarId: "avatar-0001", reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
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
      { avatarId: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
    ]);
  });

  test("is bounded at MAX_UNREADABLE_AVATARS", () => {
    const many = Array.from({ length: 5 }, (_, i) => entry({ from: join("avatars", `avatar-000${i}`) }));
    expect(unreadableFromQuarantine(many, 3)).toHaveLength(3);
  });
});

describe("combineUnreadable (L2, L11)", () => {
  const descriptorInvalid = (n: number): UnreadableAvatar => ({ avatarId: `avatar-fix-${n}`, reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" });
  const contractMismatch = (n: number): UnreadableAvatar => ({ avatarId: `avatar-mis-${n}`, reason: "contract-mismatch", detail: "its stored record no longer fits the contract" });
  const manifestUnreadable = (n: number): UnreadableAvatar => ({ avatarId: `avatar-qtn-${n}`, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" });

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
