import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AvatarPortraits, type EventMessage } from "../shared/engine";
import { openLibrary } from "./library";
import { isPortraitPhoto } from "./library/portraits";
import { SAMPLE_SOURCE, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { manifestTraits } from "./avatars/records";
import {
  command,
  engineSettings,
  failed,
  GOOD,
  ledgerLines,
  network,
  ok,
  portraitPng,
  startEngine,
  TRAITS,
  useEngineDir,
} from "./testing/engineHarness";
import { fakeGate, seedImportedAvatar } from "./testing/portraitKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, S5.3c: the reference portrait commands of an IMPORTED avatar, against a real engine over a real library in a temp dir and a fake OpenRouter. The batch is drawn from the
// imported photo, ranked by the face gate against it (a scripted gate here), and the owner picks one as the avatar's master; the imported photo stays on disk.

const dir = useEngineDir("studio-engine-portraits-");

/** The fallback table: grok-imagine-image-quality is $0.05 at 1K, plus $0.01 for the one reference, and the age check is $0.00525 at its ceiling. */
const MODEL = "x-ai/grok-imagine-image-quality";
const SLOT_WORST = 60_000;
const AGE_WORST = 5_250;
const BATCH_OFF = 5 * SLOT_WORST;
const BATCH_ON = 5 * (SLOT_WORST + AGE_WORST);

/** One slot at a time, on the image model the plan prices (quality: none, so the plain 1K price), with the age check as the app's own default says. */
function settings(patch: Partial<Parameters<typeof engineSettings>[1]> = {}) {
  return engineSettings(dir(), { imageModel: MODEL, imageQuality: null, imageAgeCheck: "off", concurrency: { network: 1 }, ...patch });
}

async function started(opts: { gate?: ReturnType<typeof fakeGate> | null; settings?: ReturnType<typeof settings>; net?: ReturnType<typeof network>; key?: string | null } = {}) {
  const rig = opts.gate === undefined ? fakeGate() : opts.gate;
  const started = await startEngine(dir(), {
    net: opts.net ?? network(),
    ...(opts.key === undefined ? {} : { key: opts.key }),
    init: { settings: opts.settings ?? settings() },
    deps: rig === null ? {} : { portraitFaceGate: rig.gate },
  });
  return { ...started, rig };
}

const estimate = () => command("avatars.estimatePortraits", {});
const list = (avatarId: string) => command("avatars.portraits", { avatarId });
const pick = (avatarId: string, photoId: string) => command("avatars.pickPortrait", { avatarId, photoId });
const discard = (avatarId: string) => command("avatars.discardPortraits", { avatarId });

function listOf(response: Parameters<typeof ok>[0]) {
  const answer = ok(response);
  if (answer.type !== "avatars.portraits") throw new Error(`expected a portraits answer, got ${answer.type}`);
  expect(AvatarPortraits.safeParse(answer.result).success).toBe(true);
  return answer.result;
}

function avatarChanged(events: EventMessage[], avatarId: string) {
  return events.flatMap((e) => (e.type === "avatar.changed" && e.payload.avatar.avatarId === avatarId ? [e.payload.avatar] : []));
}

// ---------- avatars.estimatePortraits ----------

describe("avatars.estimatePortraits", () => {
  test("prices five images with one reference each: $0.06 a slot, so worst and expected are $0.30 with the age check off", async () => {
    const { engine } = await started();

    expect(ok(await engine.handle(estimate()))).toMatchObject({ result: { expectedMicros: BATCH_OFF, worstMicros: BATCH_OFF, prices: "fallback" } });
  });

  test("with the age check on, five age checks at their ceiling join the worst case", async () => {
    const { engine } = await started({ settings: settings({ imageAgeCheck: "on" }) });

    const answer = ok(await engine.handle(estimate()));
    expect(answer.type === "avatars.estimatePortraits" && answer.result.worstMicros).toBe(BATCH_ON);
  });

  test("prices the chosen quality: medium is $0.06 + $0.01 reference a slot", async () => {
    const { engine } = await started({ settings: settings({ imageModel: "x-ai/grok-imagine-image-2.0", imageQuality: "medium" }) });

    expect(ok(await engine.handle(estimate()))).toMatchObject({ result: { worstMicros: 5 * 70_000 } });
  });

  test("is free and needs no key, no library and no avatar: it sends no paid request and writes no ledger line", async () => {
    const net = network();
    const { engine } = await started({ net, key: null, settings: settings({ libraryPath: join(dir(), "missing") }) });

    ok(await engine.handle(estimate()));

    expect(net.paidCalls()).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a model neither the live prices nor the table know is PRICE_UNAVAILABLE", async () => {
    const { engine } = await started({ settings: settings({ imageModel: "acme/unknown-image" }) });

    expect(failed(await engine.handle(estimate())).error.code).toBe("PRICE_UNAVAILABLE");
  });
});

// ---------- avatars.portraits ----------

describe("avatars.portraits", () => {
  test("lists the pending portraits best first, the source photo, and no master likeness while the master is the source", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.61, 0.76, 0.72] });
    const { engine } = await started();

    const answer = listOf(await engine.handle(list(avatarId)));

    expect(answer).toEqual({
      avatarId,
      masterPhotoId: sourceId,
      sourcePhotoId: sourceId,
      masterLikeness: null,
      candidates: [
        { avatarId, photoId: portraitIds[1], likeness: 0.76 },
        { avatarId, photoId: portraitIds[2], likeness: 0.72 },
        { avatarId, photoId: portraitIds[0], likeness: 0.61 },
      ],
    });
  });

  test("a portrait master reports its likeness and is not among the candidates", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76, 0.72], master: 1 });
    const { engine } = await started();

    const answer = listOf(await engine.handle(list(avatarId)));

    expect(answer).toMatchObject({ masterPhotoId: portraitIds[1], sourcePhotoId: sourceId, masterLikeness: 0.72, candidates: [{ photoId: portraitIds[0], likeness: 0.76 }] });
  });

  test("hides a candidate whose stored age verdict no longer passes: the list never offers what the pick refuses", async () => {
    const { avatarId } = await seedImportedAvatar(dir(), { portraits: [0.76], age: { adult: true, confidence: 0.5 } });
    const { engine } = await started();

    expect(listOf(await engine.handle(list(avatarId))).candidates).toEqual([]);
  });

  test("a portrait master whose photo is gone while the source is alive still answers, marked missing, and pickPortrait(source) is the way out", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76, 0.7], master: 0 });
    const photos = join(dir(), "library", "avatars", avatarId, "photos");
    await rm(join(photos, `${portraitIds[0]}.json`));
    const { engine, events } = await started();

    const answer = listOf(await engine.handle(list(avatarId)));
    expect(answer).toEqual({ avatarId, masterPhotoId: portraitIds[0], sourcePhotoId: sourceId, masterLikeness: null, masterMissing: true, candidates: [{ avatarId, photoId: portraitIds[1], likeness: 0.7 }] });

    ok(await engine.handle(pick(avatarId, sourceId)));
    expect(avatarChanged(events(), avatarId)).toMatchObject([{ masterPhotoId: sourceId }]);
    expect(listOf(await engine.handle(list(avatarId)))).toEqual({ avatarId, masterPhotoId: sourceId, sourcePhotoId: sourceId, masterLikeness: null, candidates: [] });
  });

  test("a wizard avatar has no source photo and no candidates", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("wiz") });
    const mia = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(mia.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80 }));
    await library.updateAvatar(mia.id, { status: "active", masterPhotoId: master.id });
    const { engine } = await started();

    expect(listOf(await engine.handle(list(mia.id)))).toEqual({ avatarId: mia.id, masterPhotoId: master.id, sourcePhotoId: null, masterLikeness: null, candidates: [] });
  });

  test("a draft or an unknown id is NOT_FOUND", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("drf") });
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const { engine } = await started();

    expect(failed(await engine.handle(list(draft.id))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(list("avatar-nobody"))).error.code).toBe("NOT_FOUND");
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await started({ settings: settings({ libraryPath: join(dir(), "missing") }) });

    expect(failed(await engine.handle(list("avatar-00000001"))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("is free: it sends no request and writes no ledger line", async () => {
    const { avatarId } = await seedImportedAvatar(dir(), { portraits: [0.7] });
    const net = network();
    const { engine } = await started({ net });

    listOf(await engine.handle(list(avatarId)));

    expect(net.calls).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a restart keeps the candidates: a new engine over the same library lists them", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.7, 0.8] });
    const first = await started();
    expect(listOf(await first.engine.handle(list(avatarId))).candidates).toHaveLength(2);

    const second = await started();

    expect(listOf(await second.engine.handle(list(avatarId))).candidates.map((c) => c.photoId)).toEqual([portraitIds[1], portraitIds[0]]);
  });
});

// ---------- avatars.pickPortrait ----------

describe("avatars.pickPortrait", () => {
  test("a candidate becomes the master: avatar.changed carries it, the other portraits go, the imported photo and the run photos stay", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.61, 0.76, 0.72] });
    const { engine, events } = await started();
    const runPhoto = await engine.library?.addPhoto(avatarId, portraitPng(9), samplePhotoMeta({ width: 60, height: 80, source: { ...SAMPLE_SOURCE, slot: "slot-1", category: "cafe" } }));

    const answer = ok(await engine.handle(pick(avatarId, portraitIds[2] ?? "")));

    expect(answer.type === "avatars.pickPortrait" && answer.result.avatar).toMatchObject({ avatarId, masterPhotoId: portraitIds[2] });
    expect(avatarChanged(events(), avatarId)).toMatchObject([{ masterPhotoId: portraitIds[2] }]);
    const kept = engine.library?.photosByAvatar(avatarId).map((p) => p.id).sort();
    expect(kept).toEqual([sourceId, portraitIds[2] ?? "", runPhoto?.id ?? ""].sort());
    expect(listOf(await engine.handle(list(avatarId)))).toMatchObject({ masterPhotoId: portraitIds[2], masterLikeness: 0.72, candidates: [] });
  });

  test("the source photo can be made the master again; the portrait it replaces is removed", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76], master: 0 });
    const { engine, events } = await started();

    ok(await engine.handle(pick(avatarId, sourceId)));

    expect(avatarChanged(events(), avatarId)).toMatchObject([{ masterPhotoId: sourceId }]);
    expect(engine.library?.getPhoto(portraitIds[0] ?? "")).toBeUndefined();
    expect(listOf(await engine.handle(list(avatarId)))).toMatchObject({ masterPhotoId: sourceId, masterLikeness: null });
  });

  test("the current master is answered as it is: nothing is written and nothing is announced", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76, 0.7], master: 0 });
    const { engine, events } = await started();

    const answer = ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));

    expect(answer.type === "avatars.pickPortrait" && answer.result.avatar.masterPhotoId).toBe(portraitIds[0]);
    expect(avatarChanged(events(), avatarId)).toEqual([]);
    expect(engine.library?.getPhoto(portraitIds[1] ?? "")).toBeDefined();
  });

  test("a photo that is not a candidate is VALIDATION not-a-candidate and changes nothing: a run photo, another avatar's photo, an unknown id", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76] });
    const other = await seedImportedAvatar(dir(), { portraits: [0.9] });
    const { engine, events } = await started();
    const runPhoto = await engine.library?.addPhoto(avatarId, portraitPng(9), samplePhotoMeta({ width: 60, height: 80, source: { ...SAMPLE_SOURCE, slot: "slot-1", category: "cafe" } }));

    for (const photoId of [runPhoto?.id ?? "", other.portraitIds[0] ?? "", "photo-nobody"]) {
      expect(failed(await engine.handle(pick(avatarId, photoId))).error).toMatchObject({ code: "VALIDATION", portraitReason: "not-a-candidate" });
    }

    expect(avatarChanged(events(), avatarId)).toEqual([]);
    expect(engine.library?.getAvatar(avatarId)?.masterPhotoId).toBe(sourceId);
    expect(engine.library?.getPhoto(portraitIds[0] ?? "")).toBeDefined();
  });

  test("a portrait just under the gate (0.54) or one whose age verdict fails is not a candidate", async () => {
    const low = await seedImportedAvatar(dir(), { portraits: [0.54] });
    const young = await seedImportedAvatar(dir(), { portraits: [0.9], age: { adult: true, confidence: 0.5 } });
    const { engine } = await started();

    expect(failed(await engine.handle(pick(low.avatarId, low.portraitIds[0] ?? ""))).error).toMatchObject({ code: "VALIDATION", portraitReason: "not-a-candidate" });
    expect(failed(await engine.handle(pick(young.avatarId, young.portraitIds[0] ?? ""))).error).toMatchObject({ code: "VALIDATION", portraitReason: "not-a-candidate" });
  });

  test("exactly 0.55 is a candidate", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.55] });
    const { engine } = await started();

    ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));
  });

  test("a wizard avatar has no source photo: VALIDATION not-imported", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("wiz") });
    const mia = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(mia.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80 }));
    await library.updateAvatar(mia.id, { status: "active", masterPhotoId: master.id });
    const { engine } = await started();

    expect(failed(await engine.handle(pick(mia.id, master.id))).error).toMatchObject({ code: "VALIDATION", portraitReason: "not-imported" });
  });

  test("a draft, an archived avatar and an unknown id are NOT_FOUND, not not-a-candidate", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("drf") });
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const archived = await seedImportedAvatar(dir(), { portraits: [0.7], status: "archived" });
    const { engine } = await started();

    expect(failed(await engine.handle(pick(draft.id, "photo-00000001"))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(pick(archived.avatarId, archived.portraitIds[0] ?? ""))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(pick("avatar-nobody", "photo-00000001"))).error.code).toBe("NOT_FOUND");
  });

  test("a cleanup that cannot remove a portrait still answers ok, and is logged by its code only", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76, 0.7] });
    const { engine, events } = await started();
    // The sidecar of the portrait to remove is now a non-empty folder, which cannot be unlinked.
    const sidecar = join(dir(), "library", "avatars", avatarId, "photos", `${portraitIds[1]}.json`);
    await rm(sidecar);
    await mkdir(sidecar);
    await writeFile(join(sidecar, "lock"), "x");
    const warn = spyOn(console, "warn").mockImplementation(() => {});

    try {
      ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));

      expect(avatarChanged(events(), avatarId)).toMatchObject([{ masterPhotoId: portraitIds[0] }]);
      const lines = warn.mock.calls.map((call) => call.join(" ")).filter((line) => line.includes("portrait"));
      expect(lines).toHaveLength(1);
      // The code differs by platform (EPERM, EBUSY, EFAULT, ...); whatever it is, it is the only thing in the parentheses.
      expect(lines[0]).toMatch(/\([A-Z][A-Z0-9_]+\)/);
      expect(lines[0]).not.toContain(avatarId);
      expect(lines[0]).not.toContain(portraitIds[1] ?? "");
    } finally {
      warn.mockRestore();
    }
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await started({ settings: settings({ libraryPath: join(dir(), "missing") }) });

    expect(failed(await engine.handle(pick("avatar-00000001", "photo-00000001"))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("is free: it sends no request and writes no ledger line", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.7] });
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));

    expect(net.calls).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a portrait is never a gallery photo or a scene photo", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.7] });
    const { engine } = await started();

    const photo = engine.library?.getPhoto(portraitIds[0] ?? "");
    expect(photo !== undefined && isPortraitPhoto(photo)).toBe(true);
    const gallery = ok(await engine.handle(command("photos.list", { avatarId })));
    expect(gallery.type === "photos.list" && gallery.result.photos).toEqual([]);
  });
});

// ---------- avatars.discardPortraits ----------

describe("avatars.discardPortraits", () => {
  test("removes every pending portrait, keeps the master, the imported photo and the run photos, and says how many", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.61, 0.76, 0.72], master: 1 });
    const { engine } = await started();

    const answer = ok(await engine.handle(discard(avatarId)));

    expect(answer.type === "avatars.discardPortraits" && answer.result).toEqual({ avatarId, removed: 2 });
    expect(engine.library?.photosByAvatar(avatarId).map((p) => p.id).sort()).toEqual([sourceId, portraitIds[1]].sort());
  });

  test("with nothing pending it removes none", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine } = await started();

    expect(ok(await engine.handle(discard(avatarId)))).toMatchObject({ result: { avatarId, removed: 0 } });
  });

  test("a draft, an archived avatar and an unknown id are NOT_FOUND", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("drf") });
    const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const archived = await seedImportedAvatar(dir(), { portraits: [0.7], status: "archived" });
    const { engine } = await started();

    expect(failed(await engine.handle(discard(draft.id))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(discard(archived.avatarId))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(discard("avatar-nobody"))).error.code).toBe("NOT_FOUND");
    expect(engine.library?.getPhoto(archived.portraitIds[0] ?? "")).toBeDefined();
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await started({ settings: settings({ libraryPath: join(dir(), "missing") }) });

    expect(failed(await engine.handle(discard("avatar-00000001"))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });
});

// ---------- the descriptor check reads the SOURCE photo (I5.20) ----------

describe("avatars.checkDescriptor of an imported avatar (I5.20)", () => {
  const CHECK_WORST = 25_000;
  const check = (avatarId: string) => command("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST });

  /** The base64 of every JPEG the check calls attached. */
  function attachedImage(net: ReturnType<typeof network>): string[] {
    return net.calls
      .filter((c) => c.url.endsWith("/chat/completions"))
      .flatMap((c) => Array.from((c.body ?? "").matchAll(/data:image\/jpeg;base64,([A-Za-z0-9+/=]+)/g), (m) => m[1] ?? ""));
  }

  async function referenceB64(engine: Awaited<ReturnType<typeof started>>["engine"], avatarId: string, of: "master" | "source"): Promise<string> {
    const reference = await engine.library?.loadReference(avatarId, undefined, of);
    if (reference === null || reference === undefined) throw new Error("no reference");
    return Buffer.from(reference).toString("base64");
  }

  test("before any switch it sends the imported photo, which is the master", async () => {
    const { avatarId } = await seedImportedAvatar(dir(), { portraits: [0.7] });
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(check(avatarId)));

    expect(attachedImage(net)).toEqual([await referenceB64(engine, avatarId, "source")]);
  });

  test("after a switch to a portrait it still sends the imported photo, never the portrait", async () => {
    const { avatarId } = await seedImportedAvatar(dir(), { portraits: [0.76], master: 0 });
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(check(avatarId)));

    const source = await referenceB64(engine, avatarId, "source");
    const portrait = await referenceB64(engine, avatarId, "master");
    expect(source).not.toBe(portrait);
    expect(attachedImage(net)).toEqual([source]);
  });

  test("for a wizard avatar it sends the master", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("wiz") });
    const mia = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(mia.id, portraitPng(3), samplePhotoMeta({ width: 60, height: 80 }));
    await library.updateAvatar(mia.id, { status: "active", masterPhotoId: master.id });
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(check(mia.id)));

    expect(attachedImage(net)).toEqual([await referenceB64(engine, mia.id, "master")]);
  });

  test("a portrait master whose source photo is gone is a free INTERNAL «source photo unavailable», never a check against the portrait", async () => {
    const { avatarId, sourceId } = await seedImportedAvatar(dir(), { portraits: [0.76], master: 0 });
    await rm(join(dir(), "library", "avatars", avatarId, "photos", `${sourceId}.json`));
    const net = network();
    const { engine } = await started({ net });

    const refused = failed(await engine.handle(check(avatarId)));

    expect(refused.error.code).toBe("INTERNAL");
    expect(refused.error.portraitReason).toBe("source-unavailable");
    expect(refused.error.detail).toContain("source photo");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a switch back and forth changes nothing about what is sent", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76] });
    const net = network();
    const { engine } = await started({ net });

    ok(await engine.handle(check(avatarId)));
    ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));
    ok(await engine.handle(check(avatarId)));
    ok(await engine.handle(pick(avatarId, sourceId)));
    ok(await engine.handle(check(avatarId)));

    const sent = attachedImage(net);
    expect(sent).toHaveLength(3);
    expect(new Set(sent).size).toBe(1);
  });
});

// ---------- after a pick the references follow the master ----------

describe("a picked portrait is the avatar's master for everything that reads it", () => {
  test("the reference the runs and the autopilot use is the portrait, not the imported photo", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76] });
    const { engine } = await started();
    const before = await engine.library?.loadReference(avatarId);

    ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));

    expect(engine.library?.referencePhoto(avatarId)?.photo.id).toBe(portraitIds[0]);
    const after = await engine.library?.loadReference(avatarId);
    expect(after).not.toBeNull();
    expect(Buffer.from(after ?? []).equals(Buffer.from(before ?? []))).toBe(false);
    expect(engine.library?.getPhoto(sourceId)).toBeDefined();
  });

  test("the original a run's face gate compares with is the portrait too, and the imported photo again after a switch back", async () => {
    const { avatarId, sourceId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76] });
    const { engine } = await started();
    const sourceBytes = await engine.library?.loadMasterOriginal(avatarId);

    ok(await engine.handle(pick(avatarId, portraitIds[0] ?? "")));
    const portraitBytes = await engine.library?.loadMasterOriginal(avatarId);

    expect(Buffer.from(portraitBytes ?? []).equals(Buffer.from(portraitPng(2)))).toBe(true);
    expect(Buffer.from(portraitBytes ?? []).equals(Buffer.from(sourceBytes ?? []))).toBe(false);
    ok(await engine.handle(pick(avatarId, sourceId)));
    expect(Buffer.from((await engine.library?.loadMasterOriginal(avatarId)) ?? []).equals(Buffer.from(sourceBytes ?? []))).toBe(true);
  });
});
