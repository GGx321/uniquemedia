import { describe, expect, test } from "bun:test";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LibraryError } from "./errors";
import { openLibrary, type LibraryDeps } from "./library";
import type { LibraryReference } from "./media";
import {
  PNG_1X1,
  rejectionOf,
  SAMPLE_AVATAR,
  SAMPLE_IMPORTED_SOURCE,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

const root = useTempDir("studio-reference-");

function deps(extra: LibraryDeps = {}): LibraryDeps {
  return { now: steppingClock(), newId: sequentialIds(), ...extra };
}

/** Mia with a master portrait, and Lena with a photo of her own. */
async function avatarsWithMaster() {
  const { library } = await openLibrary(root(), deps());
  const mia = await library.createAvatar(SAMPLE_AVATAR);
  const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });
  const lena = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
  const lenaPhoto = await library.addPhoto(lena.id, PNG_1X1, samplePhotoMeta());
  return { library, mia, master, lena, lenaPhoto };
}

function manifestPath(avatarId: string): string {
  return join(root(), "avatars", avatarId, "avatar.json");
}

describe("referencePhoto", () => {
  test("is null while no master is picked", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    expect(library.referencePhoto(mia.id)).toBeNull();
  });

  test("returns the master photo and the path of its image", async () => {
    const { library, mia, master } = await avatarsWithMaster();
    expect(library.referencePhoto(mia.id)).toEqual({
      photo: master,
      path: join(root(), "avatars", mia.id, "photos", master.file),
    });
  });

  test("is null for a draft, even one whose master is already set", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const candidate = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: candidate.id });

    expect(library.getAvatar(mia.id)?.status).toBe("draft");
    expect(library.referencePhoto(mia.id)).toBeNull();
  });

  test("is null for an unknown avatar", async () => {
    const { library } = await avatarsWithMaster();
    expect(library.referencePhoto("unknown-avatar")).toBeNull();
  });
});

describe("loadReference (invariant 9: a face reference comes only from the library's own reference loader)", () => {
  test("is null while no master is picked", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    expect(await library.loadReference(mia.id)).toBeNull();
  });

  // Review (MEDIUM): ImageParams.references wants already-downscaled JPEGs
  // (jpegDataUrl throws on anything else); a caller re-downscaling loadReference's
  // own output would have to re-brand with `as`, which defeats the brand's
  // whole point. loadReference downscales itself, via an injected dependency
  // (so 2b can choose the size without changing this test), and brands only
  // that result — the one mint point stays the only one.
  test("downscales the master's raw bytes via the injected dependency, and brands that result — not the raw bytes themselves", async () => {
    const marker = Uint8Array.from([9, 9, 9]);
    const seen: Uint8Array[] = [];
    const { library } = await openLibrary(root(), deps({
      downscaleReference: async (bytes) => {
        seen.push(bytes);
        return marker;
      },
    }));
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });

    const loaded = await library.loadReference(mia.id);

    expect(loaded).toEqual(marker as LibraryReference);
    expect(seen).toEqual([PNG_1X1]);
  });

  test("verifies the sidecar's sha256 and size before downscaling: a bit-rotted master throws, never reaching the downscale step", async () => {
    let calls = 0;
    const { library } = await openLibrary(root(), deps({ downscaleReference: async (bytes) => (calls++, bytes) }));
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });
    // Bit rot: the sidecar still records PNG_1X1's size and sha256, but the file on disk silently changed.
    await writeFile(join(root(), "avatars", mia.id, "photos", master.file), Buffer.concat([Buffer.from(PNG_1X1), Buffer.from([0])]));

    const error = await rejectionOf(library.loadReference(mia.id));

    expect(error).toBeInstanceOf(LibraryError);
    expect((error as LibraryError).code).toBe("reference-corrupt");
    expect(calls).toBe(0);
  });

  test("is null for a draft, even one whose master is already set", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const candidate = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: candidate.id });

    expect(await library.loadReference(mia.id)).toBeNull();
  });

  test("is null for an unknown avatar", async () => {
    const { library } = await avatarsWithMaster();
    expect(await library.loadReference("unknown-avatar")).toBeNull();
  });

  // T6c: invariant 9 widens to "generated, or the owner's import" — loadReference
  // is entirely generic over source.kind, so an imported master works unchanged.
  test("works for an imported master photo, exactly like a generated one (invariant 9 widened)", async () => {
    const marker = Uint8Array.from([7, 7, 7]);
    const { library } = await openLibrary(root(), deps({ downscaleReference: async () => marker }));
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta({ source: SAMPLE_IMPORTED_SOURCE, qa: { age: { adult: true, confidence: 0.9 } } }));
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });

    expect(library.referencePhoto(mia.id)).toEqual({ photo: master, path: join(root(), "avatars", mia.id, "photos", master.file) });
    const loaded = await library.loadReference(mia.id);
    expect(loaded).toEqual(marker as LibraryReference);
  });

  test("is null wherever referencePhoto is null: a quarantined master gives no reference either", async () => {
    const { mia, master } = await avatarsWithMaster();
    await rm(join(root(), "avatars", mia.id, "photos", master.file));
    const { library } = await openLibrary(root(), deps());

    expect(library.referencePhoto(mia.id)).toBeNull();
    expect(await library.loadReference(mia.id)).toBeNull();
  });

  // Type-level (checked by `tsc`, not by this runtime assertion): a plain
  // Uint8Array — a user file, a network body, anything not sourced through
  // loadReference() — cannot be assigned where a LibraryReference is
  // expected without an explicit, reviewable cast. This is TypeScript's
  // usual branding limit (a deliberate `as LibraryReference` elsewhere is
  // still possible), not a runtime check; it exists to catch the accidental
  // mistake, not a determined bypass.
  test("a plain Uint8Array is not a LibraryReference without going through loadReference (type-level)", () => {
    const arbitrary = new Uint8Array([1, 2, 3]);
    // @ts-expect-error a plain Uint8Array is not a LibraryReference; only Library.loadReference() may mint one.
    const forged: LibraryReference = arbitrary;
    expect(forged as Uint8Array).toBe(arbitrary); // erased at runtime: the brand is compile-time only.
  });
});

// Money review M1/N1: the face gate's master embedding must come from the
// ORIGINAL stored master file, never loadReference()'s <=1024px downscale
// sent to OpenRouter (measured drift: master embedding cos 0.9388 vs
// calibration, candidate shifts up to +0.029 — larger than the face gate's
// own 0.001 parity budget). loadMasterOriginal() gives the same sha256/size
// check as loadReference() (survey.ts's own check, re-run here since the
// file can rot on disk any time after that survey) but skips the downscale
// step and returns the raw bytes, unbranded (never sent to OpenRouter,
// so it is not a LibraryReference).
describe("loadMasterOriginal (M1/N1: the original file, never the OpenRouter-bound downscale)", () => {
  test("returns the master's raw, undownscaled bytes — the injected downscaleReference is never called", async () => {
    let downscaleCalls = 0;
    const { library } = await openLibrary(root(), deps({ downscaleReference: async (bytes) => (downscaleCalls++, bytes) }));
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });

    const original = await library.loadMasterOriginal(mia.id);

    expect(original).toEqual(PNG_1X1);
    expect(downscaleCalls).toBe(0);
  });

  test("is null wherever referencePhoto is null (no master, a draft, an unknown avatar)", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    expect(await library.loadMasterOriginal(mia.id)).toBeNull();
    expect(await library.loadMasterOriginal("unknown-avatar")).toBeNull();
  });

  test("verifies the sidecar's sha256 and size, like loadReference: a bit-rotted master throws reference-corrupt", async () => {
    const { library } = await openLibrary(root(), deps());
    const mia = await library.createAvatar(SAMPLE_AVATAR);
    const master = await library.addPhoto(mia.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(mia.id, { masterPhotoId: master.id, status: "active" });
    await writeFile(join(root(), "avatars", mia.id, "photos", master.file), Buffer.concat([Buffer.from(PNG_1X1), Buffer.from([0])]));

    const error = await rejectionOf(library.loadMasterOriginal(mia.id));

    expect(error).toBeInstanceOf(LibraryError);
    expect((error as LibraryError).code).toBe("reference-corrupt");
  });
});

describe("master check on open", () => {
  test("a quarantined master is reported as missing, the manifest is left as is, and there is no reference", async () => {
    const { mia, master } = await avatarsWithMaster();
    await rm(join(root(), "avatars", mia.id, "photos", master.file));
    const manifestBefore = await readFile(manifestPath(mia.id), "utf8");

    const { library, report } = await openLibrary(root(), deps());

    expect(report.masterIssues).toEqual([{ avatarId: mia.id, masterPhotoId: master.id, reason: "missing" }]);
    expect(library.referencePhoto(mia.id)).toBeNull();
    expect(await readFile(manifestPath(mia.id), "utf8")).toBe(manifestBefore);
  });

  test("a manifest edited to point at another avatar's photo is reported and gives no reference", async () => {
    const { lena, lenaPhoto, mia } = await avatarsWithMaster();
    const manifest = JSON.parse(await readFile(manifestPath(mia.id), "utf8"));
    await writeFile(manifestPath(mia.id), JSON.stringify({ ...manifest, masterPhotoId: lenaPhoto.id }));

    const { library, report } = await openLibrary(root(), deps());

    expect(report.masterIssues).toEqual([{ avatarId: mia.id, masterPhotoId: lenaPhoto.id, reason: "other-avatar" }]);
    expect(library.referencePhoto(mia.id)).toBeNull();
    expect(library.referencePhoto(lena.id)).toBeNull();
  });

  test("restoring the master from quarantine heals the avatar on the next open", async () => {
    const { mia, master } = await avatarsWithMaster();
    await rm(join(root(), "avatars", mia.id, "photos", master.file));
    const first = await openLibrary(root(), deps());
    expect(first.report.masterIssues).toHaveLength(1);
    // The sidecar went to quarantine; put it back with a fresh copy of the image.
    const sidecarEntry = first.report.quarantined.find((q) => q.reason === "orphan-sidecar");
    if (!sidecarEntry) throw new Error("expected the master's sidecar in quarantine");
    await mkdir(dirname(join(root(), sidecarEntry.from)), { recursive: true });
    await rename(join(root(), sidecarEntry.to), join(root(), sidecarEntry.from));
    await writeFile(join(root(), "avatars", mia.id, "photos", master.file), PNG_1X1);

    const { library, report } = await openLibrary(root(), deps());

    expect(report.masterIssues).toEqual([]);
    expect(library.referencePhoto(mia.id)?.photo).toEqual(master);
  });
});
