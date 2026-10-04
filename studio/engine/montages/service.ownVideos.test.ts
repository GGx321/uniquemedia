import { describe, expect, test } from "bun:test";
import { Montage, type MontageDraft } from "../../shared/engine/montage";
import { defaultSpec } from "../../shared/montage";
import { useWorld } from "../videos/testing/kit";
import { montageRig, worldPhotoIds } from "./testing/rig";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// An own video clip in a draft (3f.3b): `montages.get` and `list` judge it against the media the library holds as a video (`media-unavailable` at the clip) and against its
// stored length (`video-too-short`), from ONE question to the media store per answer, the way own tracks are judged (service.ownMusic.test.ts).

const world = useWorld();

type Held = ReadonlyMap<string, { readonly durationMs: number }>;

/** The videos the library "holds", as the engine's media store answers them; every question is recorded. */
function holding(held: Record<string, number>): { calls: string[][]; ownVideos: (ids: readonly string[]) => Promise<Held> } {
  const calls: string[][] = [];
  return {
    calls,
    ownVideos: async (ids) => {
      calls.push([...ids]);
      return new Map(ids.filter((id) => id in held).map((id) => [id, { durationMs: held[id] ?? 0 }]));
    },
  };
}

/** A draft of one scene-photo clip of 3 s and one own video clip of `durationMs` from `trimStartMs` of `mediaId`. */
function draftWithVideo(avatarId: string, montageId: string, scenePhoto: string, mediaId: string, trimStartMs = 0, durationMs = 2_000): Montage {
  const base = defaultSpec(avatarId, [scenePhoto], 3);
  const video = { clipId: "clip-00000099", kind: "video" as const, mediaId, trimStartMs, focus: null, durationMs, transitionIn: "cut" as const };
  const spec: MontageDraft = { ...base, clips: [...base.clips, video] };
  return Montage.parse({ montageId, name: null, spec, updatedAt: "2026-09-30T10:00:00.000Z" });
}

describe("montages.get: an own video clip", () => {
  test("a video the library holds, long enough, is no issue", async () => {
    const w = world();
    const media = holding({ "media-0000001": 60_000 });
    const r = montageRig(w, { deps: { ownVideos: media.ownVideos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001", 1_000, 2_000));

    expect((await r.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("a video the library no longer holds is media-unavailable at its clip, and the draft is still answered", async () => {
    const w = world();
    const r = montageRig(w, { deps: { ownVideos: holding({}).ownVideos } });
    const [a = ""] = worldPhotoIds(w);
    const stored = draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001");
    await r.store.write(w.library, stored);

    const answer = await r.service.get("montage-0000001");

    expect(answer.montage).toEqual(stored);
    expect(answer.issues).toEqual([{ code: "media-unavailable", path: ["clips", 1] }]);
  });

  test("a clip that asks past the stored video's end is video-too-short at its clip; one that ends exactly at it is no issue", async () => {
    const w = world();
    const [a = ""] = worldPhotoIds(w);
    const draft = draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001", 1_000, 2_000);
    const short = montageRig(w, { deps: { ownVideos: holding({ "media-0000001": 2_999 }).ownVideos } });
    await short.store.write(w.library, draft);
    expect((await short.service.get("montage-0000001")).issues).toEqual([{ code: "video-too-short", path: ["clips", 1] }]);

    const exact = montageRig(w, { deps: { ownVideos: holding({ "media-0000001": 3_000 }).ownVideos } });
    expect((await exact.service.get("montage-0000001")).issues).toEqual([]);
  });

  test("asks the media store once, with the video of the draft only", async () => {
    const w = world();
    const media = holding({ "media-0000001": 60_000 });
    const r = montageRig(w, { deps: { ownVideos: media.ownVideos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001"));

    await r.service.get("montage-0000001");

    expect(media.calls).toEqual([["media-0000001"]]);
  });

  test("a draft with no own video does not ask the media store", async () => {
    const w = world();
    const media = holding({});
    const r = montageRig(w, { deps: { ownVideos: media.ownVideos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.get("montage-0000001");

    expect(media.calls).toEqual([]);
  });

  test("with no media store wired, an own video is media-unavailable", async () => {
    const w = world();
    const r = montageRig(w);
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["clips", 1] }]);
  });

  test("a media store that fails reads as holding nothing: the draft is still answered, and the log says why without a path", async () => {
    const w = world();
    const logs: string[] = [];
    const r = montageRig(w, {
      deps: {
        ownVideos: async () => Promise.reject(new Error("EACCES: permission denied, open '/Users/alex/secret'")),
        log: (line) => void logs.push(line),
      },
    });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001"));

    expect((await r.service.get("montage-0000001")).issues).toEqual([{ code: "media-unavailable", path: ["clips", 1] }]);
    expect(logs.join("\n")).toContain("own videos");
    expect(logs.join("\n")).not.toContain("/Users/alex");
  });
});

describe("montages.list: an own video clip", () => {
  test("judges every draft against one answer of the media store", async () => {
    const w = world();
    const media = holding({ "media-0000001": 60_000 });
    const r = montageRig(w, { deps: { ownVideos: media.ownVideos } });
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001"));
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000002", b, "media-0000002"));

    const listed = await r.service.list(undefined);

    expect(media.calls).toHaveLength(1);
    expect([...(media.calls[0] ?? [])].sort()).toEqual(["media-0000001", "media-0000002"]);
    const byId = new Map(listed.items.map((item) => [item.montage.montageId, item.issues]));
    expect(byId.get("montage-0000001")).toEqual([]);
    expect(byId.get("montage-0000002")).toEqual([{ code: "media-unavailable", path: ["clips", 1] }]);
  });

  test("a draft whose video is too short is flagged in the list, and one that fits is not", async () => {
    const w = world();
    const r = montageRig(w, { deps: { ownVideos: holding({ "media-0000001": 2_000, "media-0000002": 60_000 }).ownVideos } });
    const [a = "", b = ""] = worldPhotoIds(w);
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000001", a, "media-0000001", 500, 2_000));
    await r.store.write(w.library, draftWithVideo(w.avatar.id, "montage-0000002", b, "media-0000002", 500, 2_000));

    const listed = await r.service.list(undefined);

    const byId = new Map(listed.items.map((item) => [item.montage.montageId, item.issues]));
    expect(byId.get("montage-0000001")).toEqual([{ code: "video-too-short", path: ["clips", 1] }]);
    expect(byId.get("montage-0000002")).toEqual([]);
  });

  test("lists drafts with no own video without asking the media store", async () => {
    const w = world();
    const media = holding({});
    const r = montageRig(w, { deps: { ownVideos: media.ownVideos } });
    const [a = ""] = worldPhotoIds(w);
    await r.store.write(w.library, Montage.parse({ montageId: "montage-0000001", name: null, spec: defaultSpec(w.avatar.id, [a], 3), updatedAt: "2026-09-30T10:00:00.000Z" }));

    await r.service.list(undefined);

    expect(media.calls).toEqual([]);
  });
});
