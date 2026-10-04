import { describe, expect, test } from "bun:test";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useWorld } from "../videos/testing/kit";
import { montageRig, worldPhotoIds } from "./testing/rig";
useNativeGlobals();

// Own stickers in drafts (3f.5): `montages.get` and `list` judge each own-sticker layer against the media the library holds as a STICKER
// (`media-unavailable` at the layer's sticker), after the built-in stickers' own verdict (`sticker-unavailable`).

const world = useWorld();

type Layer = MontageDraft["layers"][number];
const ownLayer = (n: number, mediaId: string): Layer => ({ layerId: `layer-0000000${n}`, kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId }, x: 0.5, y: 0.5, size: 0.2 });
const builtinLayer = (n: number, stickerId: string): Layer => ({ layerId: `layer-0000000${n}`, kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "builtin", stickerId }, x: 0.5, y: 0.5, size: 0.2 });

function draftWith(avatarId: string, montageId: string, scenePhoto: string, layers: Layer[]): Montage {
  const spec: MontageDraft = { ...defaultSpec(avatarId, [scenePhoto], 3), layers };
  return Montage.parse({ montageId, name: null, spec, updatedAt: "2026-09-30T10:00:00.000Z" });
}

/** The media ids the library "holds" as stickers, as the engine's media store answers them; every call is recorded. */
function holding(...held: string[]): { calls: string[][]; ownStickers: (ids: readonly string[]) => Promise<ReadonlySet<string>> } {
  const calls: string[][] = [];
  return {
    calls,
    ownStickers: async (ids) => {
      calls.push([...ids]);
      return new Set(ids.filter((id) => held.includes(id)));
    },
  };
}

describe("montages.get: own stickers", () => {
  test("an own sticker the library holds is no issue", async () => {
    const w = world();
    const media = holding("media-0000001");
    const r = montageRig(w, { deps: { ownStickers: media.ownStickers } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001")]));

    expect((await r.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("an own sticker the library no longer holds is media-unavailable at its layer's sticker, and the draft is still answered", async () => {
    const w = world();
    const r = montageRig(w, { deps: { ownStickers: holding().ownStickers } });
    const [a = ""] = worldPhotoIds(w);
    const stored = draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001")]);
    await r.store.write(w.library, stored);

    const answer = await r.service.get("montage-0000001");

    expect(answer.montage).toEqual(stored);
    expect(answer.issues).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });

  test("asks the media store once, with the own stickers of the draft only", async () => {
    const w = world();
    const media = holding("media-0000002");
    const r = montageRig(w, { deps: { ownStickers: media.ownStickers } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001"), builtinLayer(2, "heart-pulse"), ownLayer(3, "media-0000002")]));

    const answer = await r.service.get("montage-0000001");

    expect(media.calls).toEqual([["media-0000001", "media-0000002"]]);
    expect(answer.issues).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });

  test("a draft with no own sticker does not ask the media store", async () => {
    const w = world();
    const media = holding();
    const r = montageRig(w, { deps: { ownStickers: media.ownStickers } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [builtinLayer(1, "heart-pulse")]));

    await r.service.get("montage-0000001");

    expect(media.calls).toEqual([]);
  });

  test("with no media store wired, an own sticker is media-unavailable", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001")]));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });

  test("a media store that fails reads as holding nothing: the draft is still answered", async () => {
    const w = world();
    const r = montageRig(w, {
      deps: {
        ownStickers: async () => {
          throw new Error("the media store is gone");
        },
      },
    });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001")]));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });

  test("a built-in sticker the set lacks comes first, then the own stickers the library lacks", async () => {
    const w = world();
    const r = montageRig(w, { deps: { ownStickers: holding().ownStickers } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001"), builtinLayer(2, "no-such-sticker")]));

    expect((await r.service.get("montage-0000001")).issues).toEqual([
      { code: "sticker-unavailable", path: ["layers", 1, "sticker"] },
      { code: "media-unavailable", path: ["layers", 0, "sticker"] },
    ]);
  });
});

describe("montages.list: own stickers", () => {
  test("judges every draft against one answer of the media store", async () => {
    const w = world();
    const media = holding("media-0000001");
    const r = montageRig(w, { deps: { ownStickers: media.ownStickers } });
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000001", a, [ownLayer(1, "media-0000001")]));
    await r.store.write(w.library, draftWith(w.avatar.id, "montage-0000002", b, [ownLayer(1, "media-0000002"), ownLayer(2, "media-0000001")]));

    const listed = await r.service.list(undefined);

    expect(media.calls).toHaveLength(1);
    expect([...(media.calls[0] ?? [])].sort()).toEqual(["media-0000001", "media-0000002"]);
    const issuesOf = (id: string) => listed.items.find((item) => item.montage.montageId === id)?.issues;
    expect(issuesOf("montage-0000001")).toEqual([]);
    expect(issuesOf("montage-0000002")).toEqual([{ code: "media-unavailable", path: ["layers", 0, "sticker"] }]);
  });
});
