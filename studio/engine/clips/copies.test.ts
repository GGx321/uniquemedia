import { describe, expect, test } from "bun:test";
import type { EngineError, MediaSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { ClipCopies, type AvatarFolderState, type ClipCopyMedia, type KnownAvatars } from "./copies";
useNativeGlobals();

// 5b.2, S5.WA2 (I5.59): the rules of a copy's lifetime with the media service faked: what a clip delete removes, what an avatar delete removes, and the library-open sweep of orphans.

function copy(mediaId: string, avatarId: string, clipId: string): MediaSummary {
  return {
    mediaId,
    kind: "video",
    name: "Клип 2026-10-14 22-17.mp4",
    bytes: 1_000,
    createdAt: "2026-10-14T20:30:00.000Z",
    width: 720,
    height: 1280,
    durationMs: 5_000,
    sourceFps: 24,
    hdrToSdr: false,
    loopFrames: null,
    delayFrames: null,
    origin: { kind: "clip", avatarId, clipId, photoId: "photo-0001" },
  };
}

interface Fake {
  copies: ClipCopies;
  media: ClipCopyMedia;
  held: MediaSummary[];
  deleted: string[];
  logs: string[];
  /** The `root` each listing of the copies was asked for. */
  listedFor: (string | undefined)[];
  state: { readable: boolean; inUse: Set<string>; throws: Set<string>; listThrows: boolean };
}

function fake(held: MediaSummary[]): Fake {
  const deleted: string[] = [];
  const logs: string[] = [];
  const listedFor: (string | undefined)[] = [];
  const state: Fake["state"] = { readable: true, inUse: new Set(), throws: new Set(), listThrows: false };
  const media: ClipCopyMedia = {
    copyOfClip: async (clipId) => held.find((c) => c.origin?.clipId === clipId),
    copies: async (root) => {
      listedFor.push(root);
      if (state.listThrows) throw new Error("the media list cannot be read");
      return { readable: state.readable, copies: [...held] };
    },
    deleteMedia: async (mediaId) => {
      if (state.throws.has(mediaId)) throw new Error("the disk failed");
      if (state.inUse.has(mediaId)) return "in-use";
      const at = held.findIndex((c) => c.mediaId === mediaId);
      if (at === -1) return "not-found";
      held.splice(at, 1);
      deleted.push(mediaId);
      return "deleted";
    },
  };
  return { copies: new ClipCopies({ media, log: (line) => logs.push(line) }), media, held, deleted, logs, listedFor, state };
}

async function refusal(promise: Promise<unknown>): Promise<EngineError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof EngineFailure) return error.error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("removing the copy of one clip (a clips.delete)", () => {
  test("a clip with no copy removes nothing", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-other")]);
    expect(await f.copies.removeOfClip("clip-1")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("removes the clip's copy and only that one", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2")]);
    expect(await f.copies.removeOfClip("clip-1")).toBe(true);
    expect(f.deleted).toEqual(["media-1"]);
  });

  test("a copy a render holds is IN_FLIGHT in-use and stays", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.inUse.add("media-1");
    expect(await refusal(f.copies.removeOfClip("clip-1"))).toMatchObject({ code: "IN_FLIGHT", clipReason: "in-use" });
    expect(f.held).toHaveLength(1);
  });

  test("a copy that vanished meanwhile is not an error", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.media.deleteMedia = async () => "not-found";
    expect(await f.copies.removeOfClip("clip-1")).toBe(false);
  });

  test("a disk that fails is INTERNAL, so the clip is not deleted", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.throws.add("media-1");
    expect((await refusal(f.copies.removeOfClip("clip-1"))).code).toBe("INTERNAL");
  });
});

describe("removing the copies of an avatar (the trashed outcome)", () => {
  test("removes every copy of that avatar and no other avatar's", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2"), copy("media-3", "avatar-b", "clip-3")]);
    await f.copies.removeOfAvatar("avatar-a");
    expect(f.deleted.sort()).toEqual(["media-1", "media-2"]);
    expect(f.held.map((c) => c.mediaId)).toEqual(["media-3"]);
  });

  test("one that is held or fails does not stop the others, and is logged", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2"), copy("media-3", "avatar-a", "clip-3")]);
    f.state.inUse.add("media-1");
    f.state.throws.add("media-2");
    await f.copies.removeOfAvatar("avatar-a");
    expect(f.deleted).toEqual(["media-3"]);
    expect(f.logs.length).toBeGreaterThanOrEqual(2);
  });

  test("never throws, even when the media list cannot be read", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.listThrows = true;
    await f.copies.removeOfAvatar("avatar-a");
    expect(f.logs).toHaveLength(1);
  });
});

describe("the library-open sweep of orphan copies", () => {
  function avatars(known: string[], folders: Record<string, AvatarFolderState>): KnownAvatars {
    return { root: "/library", has: (id) => known.includes(id), folderState: async (id) => folders[id] ?? "unknown" };
  }

  test("keeps the copy of an avatar the library has", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    expect(await f.copies.sweep(avatars(["avatar-a"], {}))).toBe(0);
    expect(f.held).toHaveLength(1);
  });

  test("removes the copy of an avatar the library lacks when its folder is really gone from the disk", async () => {
    const f = fake([copy("media-1", "avatar-gone", "clip-1"), copy("media-2", "avatar-a", "clip-2")]);
    expect(await f.copies.sweep(avatars(["avatar-a"], { "avatar-gone": "gone" }))).toBe(1);
    expect(f.held.map((c) => c.mediaId)).toEqual(["media-2"]);
  });

  test("keeps the copy of an avatar the index lacks but whose folder is still on the disk", async () => {
    const f = fake([copy("media-1", "avatar-hidden", "clip-1")]);
    expect(await f.copies.sweep(avatars([], { "avatar-hidden": "there" }))).toBe(0);
    expect(f.held).toHaveLength(1);
    expect(f.logs).toHaveLength(1);
  });

  test("keeps the copy when the folder could not be looked at", async () => {
    const f = fake([copy("media-1", "avatar-x", "clip-1")]);
    expect(await f.copies.sweep(avatars([], { "avatar-x": "unknown" }))).toBe(0);
    expect(f.held).toHaveLength(1);
  });

  test("removes nothing when the library's own media cannot be read", async () => {
    const f = fake([copy("media-1", "avatar-gone", "clip-1")]);
    f.state.readable = false;
    expect(await f.copies.sweep(avatars([], { "avatar-gone": "gone" }))).toBe(0);
    expect(f.held).toHaveLength(1);
  });

  test("looks at each missing avatar's folder once", async () => {
    const f = fake([copy("media-1", "avatar-gone", "clip-1"), copy("media-2", "avatar-gone", "clip-2")]);
    let looks = 0;
    const known: KnownAvatars = {
      root: "/library",
      has: () => false,
      folderState: async () => {
        looks++;
        return "gone";
      },
    };
    expect(await f.copies.sweep(known)).toBe(2);
    expect(looks).toBe(1);
  });

  test("a copy a render holds or a disk that fails is left for the next open, and the rest are still swept", async () => {
    const f = fake([copy("media-1", "avatar-gone", "clip-1"), copy("media-2", "avatar-gone", "clip-2"), copy("media-3", "avatar-gone", "clip-3")]);
    f.state.inUse.add("media-1");
    f.state.throws.add("media-2");
    expect(await f.copies.sweep(avatars([], { "avatar-gone": "gone" }))).toBe(1);
    expect(f.deleted).toEqual(["media-3"]);
  });

  test("lists the copies of the library it was started for, not of whichever is live by then", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    await f.copies.sweep(avatars(["avatar-a"], {}));
    expect(f.listedFor).toEqual(["/library"]);
  });

  test("never throws", async () => {
    const f = fake([]);
    f.state.listThrows = true;
    expect(await f.copies.sweep(avatars([], {}))).toBe(0);
    expect(f.logs).toHaveLength(1);
  });
});
