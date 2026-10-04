import { describe, expect, test } from "bun:test";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { useWorld } from "../videos/testing/kit";
import { montageRig, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// An own track as a draft's music (3f.4): `montages.get` and `list` judge it against the media the library holds (`media-unavailable`), and against its
// decoded length (`track-too-short`), from ONE question to the media store per answer, the way own photos are judged (service.ownPhotos.test.ts).

const world = useWorld();

type Held = ReadonlyMap<string, { readonly durationMs: number }>;

/** The tracks the library "holds", as the engine's media store answers them; every question is recorded. */
function holding(held: Record<string, number>): { calls: string[][]; ownTracks: (ids: readonly string[]) => Promise<Held> } {
  const calls: string[][] = [];
  return {
    calls,
    ownTracks: async (ids) => {
      calls.push([...ids]);
      return new Map(ids.filter((id) => id in held).map((id) => [id, { durationMs: held[id] ?? 0 }]));
    },
  };
}

/** A draft of one 3 s scene-photo clip with `mediaId` as its music, from `startMs`. */
function draftWithTrack(avatarId: string, montageId: string, scenePhoto: string, mediaId: string, startMs = 0): Montage {
  const base = defaultSpec(avatarId, [scenePhoto], 3);
  const spec: MontageDraft = { ...base, music: { source: "own", mediaId, startMs } };
  return Montage.parse({ montageId, name: null, spec, updatedAt: "2026-09-30T10:00:00.000Z" });
}

const montageMsOf = (draft: Montage): number => draft.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);

describe("montages.get: an own track as the music", () => {
  test("a track the library holds, long enough, is no issue", async () => {
    const w = world();
    const media = holding({ "media-0000001": 60_000 });
    const r = montageRig(w, { deps: { ownTracks: media.ownTracks } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("a track the library no longer holds is media-unavailable at music, and the draft is still answered", async () => {
    const w = world();
    const r = montageRig(w, { deps: { ownTracks: holding({}).ownTracks } });
    const [a = ""] = worldPhotoIds(w);
    const stored = draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001");
    await r.store.write(w.library, stored);

    const answer = await r.service.get("montage-0000001");

    expect(answer.montage).toEqual(stored);
    expect(answer.issues).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("a track shorter than startMs plus the montage is track-too-short; one exactly as long is no issue", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const draft = draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001", 1_000);
    const total = montageMsOf(draft);
    const short = montageRig(w, { deps: { ownTracks: holding({ "media-0000001": 1_000 + total - 1 }).ownTracks } });
    await short.store.write(w.library, draft);
    expect((await short.service.get("montage-0000001")).issues).toEqual([{ code: "track-too-short", path: ["music"] }]);

    const exact = montageRig(w, { deps: { ownTracks: holding({ "media-0000001": 1_000 + total }).ownTracks } });
    expect((await exact.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("asks the media store once, with the track of the draft only", async () => {
    const w = world();
    const media = holding({ "media-0000001": 60_000 });
    const r = montageRig(w, { deps: { ownTracks: media.ownTracks } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001"));

    await r.service.get("montage-0000001");

    expect(media.calls).toEqual([["media-0000001"]]);
  });

  test("a draft with no own track does not ask the media store, whatever its music is", async () => {
    const w = world();
    const media = holding({});
    const r = montageRig(w, { deps: { ownTracks: media.ownTracks } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));
    const trending: MontageDraft = { ...defaultSpec(w.avatar.id, [a], 3), music: { source: "trending", trackId: "4199287736976977", startMs: 0 } };
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000002", name: null, spec: trending, updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.get("montage-0000001");
    await r.service.get("montage-0000002");

    expect(media.calls).toEqual([]);
  });

  test("with no media store wired, an own track is media-unavailable", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("a media store that fails reads as holding nothing: the draft is still answered, and the log says why", async () => {
    const w = world();
    const logs: string[] = [];
    const r = montageRig(w, {
      deps: {
        ownTracks: async () => Promise.reject(new Error("EACCES: permission denied, open '/Users/alex/secret'")),
        log: (line) => void logs.push(line),
      },
    });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["music"] }]);
    expect(logs.join("\n")).not.toContain("/Users/alex");
  });
});

describe("montages.list: an own track as the music", () => {
  test("judges every draft against one answer of the media store", async () => {
    const w = world();
    const media = holding({ "media-0000001": 60_000 });
    const r = montageRig(w, { deps: { ownTracks: media.ownTracks } });
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithTrack(w.avatar.id, "montage-0000001", a, "media-0000001"));
    await r.store.write(w.library, draftWithTrack(w.avatar.id, "montage-0000002", b, "media-0000002"));

    const listed = await r.service.list(undefined);

    expect(media.calls).toHaveLength(1);
    expect([...(media.calls[0] ?? [])].sort()).toEqual(["media-0000001", "media-0000002"]);
    const byId = new Map(listed.items.map((item) => [item.montage.montageId, item.issues]));
    expect(byId.get("montage-0000001")).toEqual([]);
    expect(byId.get("montage-0000002")).toEqual([{ code: "media-unavailable", path: ["music"] }]);
  });

  test("lists drafts with no own track without asking the media store", async () => {
    const w = world();
    const media = holding({});
    const r = montageRig(w, { deps: { ownTracks: media.ownTracks } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.list(undefined);

    expect(media.calls).toEqual([]);
  });
});
