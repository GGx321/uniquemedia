import { describe, expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
import { type Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { makeMock, MIA, PHOTO_IDS, scene, scenePhoto, unwrap, type Mock } from "./mockEngine.testkit";

// Stage 3, 3d.1b: the mock's montage drafts (`montages.create / get / list / save / delete / focus`) answer what the real
// engine answers: the same shapes, the same refusals in the same order, and the same `montage.changed` events. The
// parity suite (studio/engine/parity) holds the two side by side; these tests pin the mock's own behaviour and the
// controls a renderer test drives it with.

const draftEvents = (events: EventMessage[]) => events.flatMap((e) => (e.type === "montage.changed" ? [e.payload] : []));

async function create(mock: Mock, photoIds: string[] = [], avatarId: string = MIA.avatarId): Promise<Montage> {
  return (await unwrap(mock.client.request("montages.create", { avatarId, photoIds }))).montage;
}


describe("montages.create", () => {

  test("makes the default spec of the photos, in selection order", async () => {
    const mock = makeMock();
    const picked = [PHOTO_IDS[2] ?? "", PHOTO_IDS[0] ?? ""];

    const montage = await create(mock, picked);

    expect(montage.spec.clips).toHaveLength(1);
    expect(montage.spec.clips[0]).toMatchObject({ kind: "collage", layout: "collage2", cells: [{ photo: scene(picked[0] ?? "") }, { photo: scene(picked[1] ?? "") }] });
    expect(montage.spec).toEqual({ ...defaultSpec(MIA.avatarId, picked, montage.spec.seed), clips: montage.spec.clips });
  });

  test("refuses a photo that is already in a video, with the issue at its index, and stores nothing", async () => {
    const photos = [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-seeded-0001"] }), scenePhoto(3)];
    const mock = makeMock({ photos });

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: photos.map((p) => p.photoId) });

    expect(reply).toEqual({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "in-video", issues: [{ code: "photo-unavailable", path: ["photoIds", 1] }] } });
    expect(draftEvents(mock.events)).toEqual([]);
    expect(await unwrap(mock.client.request("montages.list", {}))).toMatchObject({ items: [], total: 0 });
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

});

