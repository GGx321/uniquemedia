import { describe, expect, test } from "bun:test";
import type { EngineError, MediaSummary } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EngineFailure } from "../engineFailure";
import { ClipCopies, type AvatarFolderState, type ClipCopyMedia, type DraftView, type KnownAvatars } from "./copies";
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
  /** The `root` each removal was asked for. */
  deletedFor: (string | undefined)[];
  state: { readable: boolean; inUse: Set<string>; throws: Set<string>; listThrows: boolean };
}

function fake(held: MediaSummary[]): Fake {
  const deleted: string[] = [];
  const logs: string[] = [];
  const listedFor: (string | undefined)[] = [];
  const deletedFor: (string | undefined)[] = [];
  const state: Fake["state"] = { readable: true, inUse: new Set(), throws: new Set(), listThrows: false };
  const media: ClipCopyMedia = {
    copiesOfClip: async (avatarId, clipId) => held.filter((c) => c.origin?.clipId === clipId && c.origin.avatarId === avatarId),
    copies: async (root) => {
      listedFor.push(root);
      if (state.listThrows) throw new Error("the media list cannot be read");
      return { readable: state.readable, copies: [...held] };
    },
    deleteMedia: async (mediaId, root) => {
      deletedFor.push(root);
      if (state.throws.has(mediaId)) throw new Error("the disk failed");
      if (state.inUse.has(mediaId)) return "in-use";
      const at = held.findIndex((c) => c.mediaId === mediaId);
      if (at === -1) return "not-found";
      held.splice(at, 1);
      deleted.push(mediaId);
      return "deleted";
    },
  };
  return { copies: new ClipCopies({ media, log: (line) => logs.push(line) }), media, held, deleted, logs, listedFor, deletedFor, state };
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

describe("which saved drafts hold a clip's copy (ClipUse.inDrafts)", () => {
  const draftOf = (name: string | null, ...mediaIds: (string | null)[]): DraftView => ({ name, clips: mediaIds.map((mediaId) => (mediaId === null ? { kind: "photo" } : { kind: "video", mediaId })) });

  function withDrafts(held: MediaSummary[], drafts: readonly DraftView[] | Error) {
    const f = fake(held);
    const asked: string[] = [];
    const copies = new ClipCopies({
      media: f.media,
      drafts: async (avatarId) => {
        asked.push(avatarId);
        if (drafts instanceof Error) throw drafts;
        return drafts;
      },
      log: (line) => f.logs.push(line),
    });
    return { copies, asked, logs: f.logs };
  }

  test("one draft: the count is 1 and the first says its name and the clip's 1-based place", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1")], [draftOf("Лето", null, "media-1")]);
    expect((await w.copies.draftUsesOf("avatar-a")).get("clip-1")).toEqual({ count: 1, first: { name: "Лето", frame: 2 } });
  });

  test("a draft with no name says null", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1")], [draftOf(null, "media-1")]);
    expect((await w.copies.draftUsesOf("avatar-a")).get("clip-1")).toEqual({ count: 1, first: { name: null, frame: 1 } });
  });

  test("two drafts: the count is 2 and there is no first (the dialog names a draft only when there is one)", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1")], [draftOf("A", "media-1"), draftOf("B", null, "media-1")]);
    const use = (await w.copies.draftUsesOf("avatar-a")).get("clip-1");
    expect(use).toEqual({ count: 2 });
    expect(use !== undefined && "first" in use).toBe(false);
  });

  test("a draft that holds the copy twice counts once, at its first place", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1")], [draftOf("A", null, "media-1", "media-1")]);
    expect((await w.copies.draftUsesOf("avatar-a")).get("clip-1")).toEqual({ count: 1, first: { name: "A", frame: 2 } });
  });

  test("each clip has its own count", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2")], [draftOf("A", "media-1", "media-2"), draftOf("B", "media-2")]);
    const uses = await w.copies.draftUsesOf("avatar-a");
    expect(uses.get("clip-1")).toEqual({ count: 1, first: { name: "A", frame: 1 } });
    expect(uses.get("clip-2")).toEqual({ count: 2 });
  });

  test("a clip no draft holds has no entry, and an own video that is no copy counts for nobody", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1")], [draftOf("A", "media-own")]);
    expect((await w.copies.draftUsesOf("avatar-a")).size).toBe(0);
  });

  test("another avatar's copies are not asked about", async () => {
    const w = withDrafts([copy("media-1", "avatar-b", "clip-1")], [draftOf("A", "media-1")]);
    expect((await w.copies.draftUsesOf("avatar-a")).size).toBe(0);
  });

  test("the drafts are not read at all when the avatar has no copy", async () => {
    const w = withDrafts([], [draftOf("A", "media-1")]);
    expect((await w.copies.draftUsesOf("avatar-a")).size).toBe(0);
    expect(w.asked).toEqual([]);
  });

  test("drafts that cannot be read say nothing, and the failure is logged and never thrown", async () => {
    const w = withDrafts([copy("media-1", "avatar-a", "clip-1")], new Error("the drafts folder cannot be listed"));
    expect((await w.copies.draftUsesOf("avatar-a")).size).toBe(0);
    expect(w.logs).toHaveLength(1);
  });

  test("a service built without a draft reader has no draft uses", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    expect((await f.copies.draftUsesOf("avatar-a")).size).toBe(0);
  });
});

describe("removing the copy of one clip (a clips.delete)", () => {
  test("a clip with no copy removes nothing", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-other")]);
    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/library")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("removes the clip's copy and only that one", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2")]);
    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/library")).toBe(true);
    expect(f.deleted).toEqual(["media-1"]);
  });

  test("a copy a render holds is IN_FLIGHT in-use and stays", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.inUse.add("media-1");
    expect(await refusal(f.copies.removeOfClip("avatar-a", "clip-1", "/library"))).toMatchObject({ code: "IN_FLIGHT", clipReason: "in-use" });
    expect(f.held).toHaveLength(1);
  });

  test("removes EVERY copy of the clip (two copies, e.g. after a crash between a commit and the dedup)", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-1"), copy("media-3", "avatar-a", "clip-2")]);
    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/library")).toBe(true);
    expect(f.deleted.sort()).toEqual(["media-1", "media-2"]);
    expect(f.held.map((c) => c.mediaId)).toEqual(["media-3"]);
  });

  test("a held copy among them refuses the delete in-use (the clip stays; a copy already removed is made again on demand)", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-1")]);
    f.state.inUse.add("media-2");
    expect((await refusal(f.copies.removeOfClip("avatar-a", "clip-1", "/library"))).clipReason).toBe("in-use");
    expect(f.held.map((c) => c.mediaId)).toEqual(["media-2"]);
  });

  test("another avatar's clip with the same id is not this clip's copy", async () => {
    const f = fake([copy("media-1", "avatar-b", "clip-1")]);
    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/library")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("a copy that vanished meanwhile is not an error", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.media.deleteMedia = async () => "not-found";
    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/library")).toBe(false);
  });

  test("a disk that fails is INTERNAL, so the clip is not deleted", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.throws.add("media-1");
    expect((await refusal(f.copies.removeOfClip("avatar-a", "clip-1", "/library"))).code).toBe("INTERNAL");
  });
});

describe("removing the copy of one clip in the library the clip is in (S5.WA5, L1)", () => {
  test("lists the copies of that library and removes them there, holding nothing of the live one", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2")]);

    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/old-library")).toBe(true);

    expect(f.listedFor).toEqual(["/old-library"]);
    expect(f.deletedFor).toEqual(["/old-library"]);
    expect(f.deleted).toEqual(["media-1"]);
  });

  test("another avatar's copy of a clip with the same id is not removed", async () => {
    const f = fake([copy("media-1", "avatar-b", "clip-1")]);

    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/old-library")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("a library whose media cannot be read says nothing, so nothing is removed and the delete goes on as it did", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.readable = false;

    expect(await f.copies.removeOfClip("avatar-a", "clip-1", "/old-library")).toBe(false);
    expect(f.deleted).toEqual([]);
  });

  test("a copy a render holds is IN_FLIGHT in-use there too", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.inUse.add("media-1");

    expect(await refusal(f.copies.removeOfClip("avatar-a", "clip-1", "/old-library"))).toMatchObject({ code: "IN_FLIGHT", clipReason: "in-use" });
  });
});

describe("removing the copies of an avatar (the trashed outcome)", () => {
  test("removes every copy of that avatar and no other avatar's", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2"), copy("media-3", "avatar-b", "clip-3")]);
    await f.copies.removeOfAvatar("avatar-a", "/library");
    expect(f.deleted.sort()).toEqual(["media-1", "media-2"]);
    expect(f.held.map((c) => c.mediaId)).toEqual(["media-3"]);
  });

  test("lists and removes in the library the avatar was in (a root), so a switch to another library is never touched", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    await f.copies.removeOfAvatar("avatar-a", "/old-library");
    expect(f.listedFor).toEqual(["/old-library"]);
    expect(f.deletedFor).toEqual(["/old-library"]);
  });

  test("one that is held or fails does not stop the others, and is logged", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1"), copy("media-2", "avatar-a", "clip-2"), copy("media-3", "avatar-a", "clip-3")]);
    f.state.inUse.add("media-1");
    f.state.throws.add("media-2");
    await f.copies.removeOfAvatar("avatar-a", "/library");
    expect(f.deleted).toEqual(["media-3"]);
    expect(f.logs.length).toBeGreaterThanOrEqual(2);
  });

  test("never throws, even when the media list cannot be read", async () => {
    const f = fake([copy("media-1", "avatar-a", "clip-1")]);
    f.state.listThrows = true;
    await f.copies.removeOfAvatar("avatar-a", "/library");
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

  test("removes in the library it was started for too", async () => {
    const f = fake([copy("media-1", "avatar-gone", "clip-1")]);
    await f.copies.sweep(avatars([], { "avatar-gone": "gone" }));
    expect(f.deletedFor).toEqual(["/library"]);
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
