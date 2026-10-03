import { describe, expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
import { MAX_LISTED_MONTAGES, type Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { MOCK_FOCUS } from "./mockEngine";
import { freePhotos, makeMock, MIA, NORA, PHOTO_IDS, scene, scenePhoto, SOFIA, unwrap, type Mock } from "./mockEngine.testkit";

// Stage 3, 3d.1b: the mock's montage drafts (`montages.create / get / list / save / delete / focus`) answer what the real
// engine answers: the same shapes, the same refusals in the same order, and the same `montage.changed` events. The
// parity suite (studio/engine/parity) holds the two side by side; these tests pin the mock's own behaviour and the
// controls a renderer test drives it with.

const draftEvents = (events: EventMessage[]) => events.flatMap((e) => (e.type === "montage.changed" ? [e.payload] : []));

async function create(mock: Mock, photoIds: string[] = [], avatarId: string = MIA.avatarId): Promise<Montage> {
  return (await unwrap(mock.client.request("montages.create", { avatarId, photoIds }))).montage;
}

const ownStickerLayer = (layerId: string) => ({ layerId, kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "own" as const, mediaId: "media-0000001" }, x: 0.5, y: 0.5, size: 0.2 });
const textLayer = (layerId: string) => ({ layerId, kind: "text" as const, startMs: 0, endMs: 1_000, value: "Hi", font: "manrope" as const, style: "none" as const, color: "#ffffff", x: 0.5, y: 0.5, scale: 1 });

describe("montages.create", () => {
  test("makes an empty draft with no name, and announces it", async () => {
    const mock = makeMock();

    const montage = await create(mock);

    expect(montage).toMatchObject({ name: null, spec: { avatarId: MIA.avatarId, clips: [], layers: [], music: null } });
    expect(draftEvents(mock.events)).toEqual([{ change: "upserted", montage }]);
  });

  test("makes the default spec of the photos, in selection order", async () => {
    const mock = makeMock();
    const picked = [PHOTO_IDS[2] ?? "", PHOTO_IDS[0] ?? ""];

    const montage = await create(mock, picked);

    expect(montage.spec.clips).toHaveLength(1);
    expect(montage.spec.clips[0]).toMatchObject({ kind: "collage", layout: "collage2", cells: [{ photo: scene(picked[0] ?? "") }, { photo: scene(picked[1] ?? "") }] });
    expect(montage.spec).toEqual({ ...defaultSpec(MIA.avatarId, picked, montage.spec.seed), clips: montage.spec.clips });
  });

  test("resolves the focus of a photo the gate scored, and stores null for one it did not", async () => {
    const mock = makeMock();

    const montage = await create(mock, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]);

    const clip = montage.spec.clips[0];
    if (clip?.kind !== "collage") throw new Error("expected a collage");
    expect(clip.cells.map((c) => c.focus)).toEqual([MOCK_FOCUS, null]);
  });

  test("stores null for every focus while the focus is unavailable", async () => {
    const mock = makeMock();
    mock.engine.setFocusAvailable(false);

    const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);

    const clip = montage.spec.clips[0];
    if (clip?.kind !== "photo") throw new Error("expected a photo clip");
    expect(clip.cell.focus).toBeNull();
  });

  test("refuses a photo that is already in a video, with the issue at its index, and stores nothing", async () => {
    const photos = [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-seeded-0001"] }), scenePhoto(3)];
    const mock = makeMock({ photos });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: photos.map((p) => p.photoId) });

    expect(reply).toEqual({ ok: false, error: { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photoIds", 1] }] } });
    expect(draftEvents(mock.events)).toEqual([]);
    expect(await unwrap(mock.client.request("montages.list", {}))).toMatchObject({ items: [], total: 0 });
  });

  test("lists every photo that is reserved, rejected, ineligible or unknown", async () => {
    const photos = [scenePhoto(1), scenePhoto(2, { reserved: true }), scenePhoto(3, { rejected: true, eligible: false }), scenePhoto(4, { eligible: false }), scenePhoto(5)];
    const mock = makeMock({ photos });
    const ids = [...photos.map((p) => p.photoId), "photo-nobody-0009"];

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: ids });

    if (reply.ok) throw new Error("expected a refusal");
    expect(reply.error.issues?.map((i) => i.path)).toEqual([["photoIds", 1], ["photoIds", 2], ["photoIds", 3], ["photoIds", 5]]);
  });

  test("refuses more than 20 photos as a contract violation", async () => {
    const mock = makeMock({ photos: freePhotos(21) });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: freePhotos(21).map((p) => p.photoId) });

    expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  });

  test("takes exactly 20 photos", async () => {
    const mock = makeMock({ photos: freePhotos(20) });

    const montage = await create(mock, freePhotos(20).map((p) => p.photoId));

    expect(montage.spec.clips).toHaveLength(20);
  });

  test("refuses an unknown avatar and an archived one with NOT_FOUND", async () => {
    const mock = makeMock({ avatars: [MIA, NORA], photos: freePhotos(2) });

    const unknown = await mock.client.request("montages.create", { avatarId: "avatar-nobody-0009", photoIds: [] });
    const archived = await mock.client.request("montages.create", { avatarId: NORA.avatarId, photoIds: [] });

    expect(unknown).toMatchObject({ ok: false, error: { code: "NOT_FOUND", detail: "no active avatar avatar-nobody-0009 in the open library" } });
    expect(archived).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("answers LIBRARY_UNAVAILABLE before it looks at the avatar", async () => {
    const mock = makeMock();
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("montages.create", { avatarId: "avatar-nobody-0009", photoIds: [] });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("gives each draft its own id", async () => {
    const mock = makeMock();

    const [first, second] = [await create(mock), await create(mock)];

    expect(first.montageId).not.toBe(second.montageId);
  });
});

describe("montages.get", () => {
  test("answers the draft as stored, with the structural issues of a spec", async () => {
    const mock = makeMock();
    const montage = await create(mock);

    const got = await unwrap(mock.client.request("montages.get", { montageId: montage.montageId }));

    expect(got).toEqual({ montage, issues: [{ code: "no-clips", path: ["clips"] }] });
  });

  test("has no issues for a complete draft of free photos", async () => {
    const mock = makeMock();
    const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);

    const got = await unwrap(mock.client.request("montages.get", { montageId: montage.montageId }));

    expect(got.issues).toEqual([]);
  });

  test("marks a part whose slice has not landed as not-yet-supported", async () => {
    const mock = makeMock();
    const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);
    await unwrap(mock.client.request("montages.save", { montageId: montage.montageId, spec: { ...montage.spec, layers: [ownStickerLayer("layer-0001")] }, name: null }));

    const got = await unwrap(mock.client.request("montages.get", { montageId: montage.montageId }));

    expect(got.issues).toEqual([{ code: "not-yet-supported", path: ["layers", 0] }]);
  });

  test("marks a scene photo that is no longer usable photo-unavailable, at its cell", async () => {
    const mock = makeMock();
    const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);
    await unwrap(mock.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: PHOTO_IDS[0] ?? "", rejected: true }));

    const got = await unwrap(mock.client.request("montages.get", { montageId: montage.montageId }));

    expect(got.issues).toEqual([{ code: "photo-unavailable", path: ["clips", 0, "cell"] }]);
  });

  test("puts the referential issues after the structural and not-yet-supported ones", async () => {
    const mock = makeMock();
    const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);
    const sticker = { layerId: "layer-0002", kind: "sticker" as const, startMs: 0, endMs: 1_000, sticker: { source: "builtin" as const, stickerId: "no-such-sticker" }, x: 0.5, y: 0.5, size: 0.2 };
    await unwrap(mock.client.request("montages.save", { montageId: montage.montageId, spec: { ...montage.spec, layers: [sticker], music: { source: "trending", trackId: "track-0000001", startMs: 0 } }, name: null }));

    const got = await unwrap(mock.client.request("montages.get", { montageId: montage.montageId }));

    expect(got.issues).toEqual([
      { code: "not-yet-supported", path: ["music"] },
      { code: "sticker-unavailable", path: ["layers", 0, "sticker"] },
    ]);
  });

  test("refuses a draft that is not there with NOT_FOUND", async () => {
    const mock = makeMock();

    const reply = await mock.client.request("montages.get", { montageId: "montage-nobody-0009" });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "no montage draft montage-nobody-0009" } });
  });

  test("answers LIBRARY_UNAVAILABLE while the library is closed", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("montages.get", { montageId: montage.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });
});

describe("montages.list", () => {
  test("lists the newest draft first, each with its issues and video count", async () => {
    const mock = makeMock();
    const older = await create(mock);
    const newer = await create(mock, [PHOTO_IDS[0] ?? ""]);

    const listed = await unwrap(mock.client.request("montages.list", {}));

    expect(listed.items.map((i) => i.montage.montageId)).toEqual([newer.montageId, older.montageId]);
    expect(listed.items.map((i) => [i.issues.length, i.videoCount])).toEqual([[0, 0], [1, 0]]);
    expect(listed).toMatchObject({ total: 2, skippedTotal: 0 });
  });

  test("ranks a draft that was just saved above the others", async () => {
    const mock = makeMock();
    const first = await create(mock);
    await create(mock);
    await unwrap(mock.client.request("montages.save", { montageId: first.montageId, spec: first.spec, name: "Кафе" }));

    const listed = await unwrap(mock.client.request("montages.list", {}));

    expect(listed.items[0]?.montage.montageId).toBe(first.montageId);
  });

  test("lists the drafts of one avatar, or of every avatar when none is named", async () => {
    const mock = makeMock({ avatars: [MIA, SOFIA], photos: [...freePhotos(2), ...freePhotos(2, SOFIA)] });
    const mine = await create(mock);
    const hers = await create(mock, [], SOFIA.avatarId);

    const onlyMia = await unwrap(mock.client.request("montages.list", { avatarId: MIA.avatarId }));
    const everyone = await unwrap(mock.client.request("montages.list", {}));

    expect(onlyMia.items.map((i) => i.montage.montageId)).toEqual([mine.montageId]);
    expect(everyone.items.map((i) => i.montage.montageId)).toEqual([hers.montageId, mine.montageId]);
  });

  test("refuses an avatar the library does not have with NOT_FOUND", async () => {
    const mock = makeMock();

    const reply = await mock.client.request("montages.list", { avatarId: "avatar-nobody-0009" });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "no avatar avatar-nobody-0009 in the open library" } });
  });

  test("answers LIBRARY_UNAVAILABLE while the library is closed", async () => {
    const mock = makeMock();
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("montages.list", {});

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });

  test("cuts the list at 200 drafts while the total still counts every one", async () => {
    const mock = makeMock();
    for (let i = 0; i < MAX_LISTED_MONTAGES + 1; i++) await create(mock);

    const listed = await unwrap(mock.client.request("montages.list", {}));

    expect(listed.items).toHaveLength(MAX_LISTED_MONTAGES);
    expect(listed.total).toBe(MAX_LISTED_MONTAGES + 1);
  });

  test("reports the draft files that could not be read as skippedTotal, never as a failed list", async () => {
    const mock = makeMock();
    await create(mock);
    mock.engine.setSkippedDrafts(3);

    const listed = await unwrap(mock.client.request("montages.list", {}));

    expect(listed).toMatchObject({ total: 1, skippedTotal: 3 });
  });
});

describe("montages.save", () => {
  test("replaces the spec and the name, and announces the saved draft", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    const spec: MontageDraft = { ...montage.spec, seed: 99 };

    const saved = (await unwrap(mock.client.request("montages.save", { montageId: montage.montageId, spec, name: "Кафе и город" }))).montage;

    expect(saved).toMatchObject({ montageId: montage.montageId, name: "Кафе и город", spec: { seed: 99 } });
    expect(saved.updatedAt > montage.updatedAt).toBe(true);
    expect(draftEvents(mock.events).at(-1)).toEqual({ change: "upserted", montage: saved });
  });

  test("stores a draft's name as null when asked", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    await unwrap(mock.client.request("montages.save", { montageId: montage.montageId, spec: montage.spec, name: "Кафе" }));

    const saved = (await unwrap(mock.client.request("montages.save", { montageId: montage.montageId, spec: montage.spec, name: null }))).montage;

    expect(saved.name).toBeNull();
  });

  test("refuses a spec of another avatar with VALIDATION and changes nothing", async () => {
    const mock = makeMock({ avatars: [MIA, SOFIA], photos: freePhotos(2) });
    const montage = await create(mock);

    const reply = await mock.client.request("montages.save", { montageId: montage.montageId, spec: { ...montage.spec, avatarId: SOFIA.avatarId }, name: null });

    expect(reply).toEqual({ ok: false, error: { code: "VALIDATION", detail: "the spec belongs to another avatar than the draft" } });
    expect(draftEvents(mock.events)).toHaveLength(1);
  });

  test("saves a draft that holds a rejected photo: a save never fails for a photo", async () => {
    const mock = makeMock();
    const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);
    await unwrap(mock.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: PHOTO_IDS[0] ?? "", rejected: true }));

    const reply = await mock.client.request("montages.save", { montageId: montage.montageId, spec: montage.spec, name: null });

    expect(reply.ok).toBe(true);
  });

  test("refuses a draft that is not there with NOT_FOUND", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    await unwrap(mock.client.request("montages.delete", { montageId: montage.montageId }));

    const reply = await mock.client.request("montages.save", { montageId: montage.montageId, spec: montage.spec, name: null });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: `no montage draft ${montage.montageId}` } });
    expect(await unwrap(mock.client.request("montages.list", {}))).toMatchObject({ total: 0 });
  });

  test("answers LIBRARY_UNAVAILABLE while the library is closed", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("montages.save", { montageId: montage.montageId, spec: montage.spec, name: null });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });
});

describe("montages.delete", () => {
  test("removes the draft and announces it with its avatar", async () => {
    const mock = makeMock();
    const montage = await create(mock);

    const answer = await unwrap(mock.client.request("montages.delete", { montageId: montage.montageId }));

    expect(answer).toEqual({ montageId: montage.montageId });
    expect(draftEvents(mock.events).at(-1)).toEqual({ change: "removed", montageId: montage.montageId, avatarId: MIA.avatarId });
    expect(await mock.client.request("montages.get", { montageId: montage.montageId })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("refuses a draft that is already gone with NOT_FOUND", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    await unwrap(mock.client.request("montages.delete", { montageId: montage.montageId }));

    const reply = await mock.client.request("montages.delete", { montageId: montage.montageId });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: `no montage draft ${montage.montageId}` } });
  });

  test("answers LIBRARY_UNAVAILABLE while the library is closed", async () => {
    const mock = makeMock();
    const montage = await create(mock);
    mock.engine.setLibraryAvailable(false);

    const reply = await mock.client.request("montages.delete", { montageId: montage.montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
  });
});

describe("montages.focus", () => {
  test("answers the focus of a photo the gate scored", async () => {
    const mock = makeMock();

    const answer = await unwrap(mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: scene(PHOTO_IDS[0] ?? "") }));

    expect(answer).toEqual({ focus: MOCK_FOCUS });
  });

  test("answers null for a photo the gate did not score", async () => {
    const mock = makeMock();

    const answer = await unwrap(mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: scene(PHOTO_IDS[1] ?? "") }));

    expect(answer).toEqual({ focus: null });
  });

  test("answers a photo that is already in a video: whether it is used is another question", async () => {
    const photo = scenePhoto(1, { used: true, usedIn: ["video-seeded-0001"] });
    const mock = makeMock({ photos: [photo] });

    const answer = await unwrap(mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: scene(photo.photoId) }));

    expect(answer).toEqual({ focus: MOCK_FOCUS });
  });

  test("refuses a photo that is not eligible, with the issue at [photo]", async () => {
    const photo = scenePhoto(1, { rejected: true, eligible: false });
    const mock = makeMock({ photos: [photo] });

    const reply = await mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: scene(photo.photoId) });

    expect(reply).toEqual({ ok: false, error: { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["photo"] }] } });
  });

  test("refuses an own upload with NOT_FOUND: there is no such store yet", async () => {
    const mock = makeMock();

    const reply = await mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: { source: "own", mediaId: "media-own-0001" } });

    expect(reply).toEqual({ ok: false, error: { code: "NOT_FOUND", detail: "own photos are not available yet" } });
  });

  test("refuses an unknown avatar and an archived one with NOT_FOUND", async () => {
    const mock = makeMock({ avatars: [MIA, NORA], photos: [] });

    const unknown = await mock.client.request("montages.focus", { avatarId: "avatar-nobody-0009", photo: scene("photo-nobody-0009") });
    const archived = await mock.client.request("montages.focus", { avatarId: NORA.avatarId, photo: scene("photo-nobody-0009") });

    expect(unknown).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(archived).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("answers null while the focus is unavailable", async () => {
    const mock = makeMock();
    mock.engine.setFocusAvailable(false);

    const answer = await unwrap(mock.client.request("montages.focus", { avatarId: MIA.avatarId, photo: scene(PHOTO_IDS[0] ?? "") }));

    expect(answer).toEqual({ focus: null });
  });
});

test("drafts survive an engine restart", async () => {
  const mock = makeMock();
  const montage = await create(mock, [PHOTO_IDS[0] ?? ""]);

  mock.engine.restart();

  expect(await unwrap(mock.client.request("montages.get", { montageId: montage.montageId }))).toMatchObject({ montage });
});
