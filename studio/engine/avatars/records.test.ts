import { describe, expect, test } from "bun:test";
import { AvatarSummary, Draft, type AvatarTraits } from "../../shared/engine";
import { openLibrary } from "../library";
import { AvatarManifestSchema, type AvatarManifest, type PhotoSidecar } from "../library/schemas";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock, useTempDir } from "../library/testing/helpers";
import { avatarSummaryFrom, draftFrom, libraryView, manifestTraits } from "./records";

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
    expect(view.skipped).toEqual([early.id]);
  });

  test("an empty library has nothing to list", async () => {
    const { library } = await openLibrary(root());
    expect(libraryView(library)).toEqual({ avatars: [], drafts: [], skipped: [] });
  });
});
