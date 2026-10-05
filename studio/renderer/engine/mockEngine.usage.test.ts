import { describe, expect, test } from "bun:test";
import type { AvatarSummary, UsageUnknownReason } from "../../shared/engine";
import { defaultSpec } from "../../shared/montage";
import { freePhotos, makeMock, MIA, PHOTO_IDS, unwrap, type Mock } from "./mockEngine.testkit";

// K16: an avatar whose photo usage cannot be trusted (`AvatarSummary.usage` unknown). The mock answers what the real engine answers
// (engine/montages/availability.ts, engine/videos/service.ts): a record from a newer Studio is LIBRARY_TOO_NEW, a stale index or a
// broken record or mark is PHOTO_UNAVAILABLE for every photo, and every photo of a draft reads `photo-unavailable`.

const TOO_NEW_DETAIL = "a video record of this avatar was written by a newer version of Studio";
const untrusted = (code: "index-stale" | "log-needs-repair"): string => `the usage of this avatar's photos cannot be trusted right now (${code})`;

function unknownMock(reasons: [UsageUnknownReason, ...UsageUnknownReason[]]): Mock {
  const photos = freePhotos(4);
  const avatar: AvatarSummary = { ...MIA, photoCount: photos.length, eligibleUnusedCount: 0, usage: { state: "unknown", reasons } };
  return makeMock({ photos, avatars: [avatar] });
}

/** A draft of `photoIds` made while the avatar's usage is unknown: an empty one created, then saved with the clips (a refusal-free path in the mock). */
async function draftWithPhotos(mock: Mock, photoIds: string[]) {
  const empty = (await unwrap(mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [] }))).montage;
  const spec = defaultSpec(MIA.avatarId, photoIds, empty.spec.seed);
  await unwrap(mock.client.request("montages.save", { montageId: empty.montageId, spec, name: null }));
  return empty.montageId;
}

const P = PHOTO_IDS.slice(0, 2);

describe("an avatar whose usage is unknown", () => {
  test("montages.create answers LIBRARY_TOO_NEW when a record is from a newer Studio", async () => {
    const mock = unknownMock(["library-too-new"]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });

    expect(reply).toEqual({ ok: false, error: { code: "LIBRARY_TOO_NEW", detail: TOO_NEW_DETAIL } });
  });

  test("a newer record wins over the other reasons", async () => {
    const mock = unknownMock(["library-too-new", "index-stale", "record-unreadable"]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });

    expect(reply).toMatchObject({ ok: false, error: { code: "LIBRARY_TOO_NEW" } });
  });

  test("montages.create refuses every photo with the stale index named", async () => {
    const mock = unknownMock(["index-stale"]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });

    expect(reply).toEqual({
      ok: false,
      error: {
        code: "PHOTO_UNAVAILABLE",
        detail: untrusted("index-stale"),
        photoReason: "index-stale",
        issues: [
          { code: "photo-unavailable", path: ["photoIds", 0] },
          { code: "photo-unavailable", path: ["photoIds", 1] },
        ],
      },
    });
  });

  test.each<UsageUnknownReason>(["record-unreadable", "record-inaccessible", "rejects-unreadable"])("montages.create names a log that needs repair for %s", async (reason) => {
    const mock = unknownMock([reason]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", detail: untrusted("log-needs-repair") } });
  });

  test("montages.create with no photo still makes an empty draft", async () => {
    const mock = unknownMock(["record-unreadable"]);

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [] });

    expect(reply.ok).toBe(true);
  });

  test("montages.get marks every scene photo of the draft photo-unavailable", async () => {
    const mock = unknownMock(["record-unreadable"]);
    const montageId = await draftWithPhotos(mock, P);

    const { issues } = await unwrap(mock.client.request("montages.get", { montageId }));

    expect(issues.filter((i) => i.code === "photo-unavailable").map((i) => i.path)).toEqual([["clips", 0, "cells", 0], ["clips", 0, "cells", 1]]);
  });

  test("videos.render answers LIBRARY_TOO_NEW for a newer record", async () => {
    const mock = unknownMock(["library-too-new"]);
    const montageId = await draftWithPhotos(mock, P);

    const reply = await mock.client.request("videos.render", { montageId });

    expect(reply).toEqual({ ok: false, error: { code: "LIBRARY_TOO_NEW", detail: TOO_NEW_DETAIL } });
  });

  test("videos.render refuses every cell with the stale index named, and queues nothing", async () => {
    const mock = unknownMock(["index-stale"]);
    const montageId = await draftWithPhotos(mock, P);

    const reply = await mock.client.request("videos.render", { montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", detail: untrusted("index-stale") } });
    expect((await unwrap(mock.client.request("engine.snapshot", {}))).jobs).toEqual([]);
  });

  test("photos.list says no photo is eligible while the reject marks cannot be read", async () => {
    const mock = unknownMock(["rejects-unreadable"]);

    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));

    expect(photos.map((p) => p.eligible)).toEqual([false, false, false, false]);
  });

  test("photos.list keeps the photos eligible when only a record is unreadable", async () => {
    const mock = unknownMock(["record-unreadable"]);

    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));

    expect(photos.map((p) => p.eligible)).toEqual([true, true, true, true]);
  });

  test("every refusal names its reason code: the stale index, or the log that needs repair", async () => {
    const stale = await unknownMock(["index-stale"]).client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });
    const broken = await unknownMock(["record-unreadable"]).client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });

    expect(stale).toMatchObject({ ok: false, error: { photoReason: "index-stale" } });
    expect(broken).toMatchObject({ ok: false, error: { photoReason: "log-needs-repair" } });
  });

  test("videos.render names the same reason code as montages.create", async () => {
    const mock = unknownMock(["record-unreadable"]);
    const montageId = await draftWithPhotos(mock, P);

    const reply = await mock.client.request("videos.render", { montageId });

    expect(reply).toMatchObject({ ok: false, error: { code: "PHOTO_UNAVAILABLE", photoReason: "log-needs-repair" } });
  });

  test("photos.setRejected is refused as INTERNAL, naming the reject log, while the marks cannot be read, and marks nothing", async () => {
    const mock = unknownMock(["rejects-unreadable"]);

    const reply = await mock.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: PHOTO_IDS[0] ?? "", rejected: true });

    expect(reply).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: expect.stringContaining("rejected.jsonl") } });
    const { photos } = await unwrap(mock.client.request("photos.list", { avatarId: MIA.avatarId }));
    expect(photos.every((p) => !p.rejected)).toBe(true);
  });

  test("a mark made while usage is unknown does not move the avatar's unused count: it stays 0", async () => {
    const mock = unknownMock(["record-unreadable"]);

    await unwrap(mock.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: PHOTO_IDS[0] ?? "", rejected: true }));

    const { avatars } = await unwrap(mock.client.request("avatars.list", {}));
    expect(avatars[0]?.eligibleUnusedCount).toBe(0);
  });

  test("a recovery that clears the last reason makes the photos usable again", async () => {
    const mock = unknownMock(["record-unreadable"]);
    await unwrap(mock.client.request("videos.quarantineRecords", { avatarId: MIA.avatarId }));

    const reply = await mock.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: P });

    expect(reply.ok).toBe(true);
  });
});
