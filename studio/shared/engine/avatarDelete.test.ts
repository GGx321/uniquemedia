import { describe, expect, test } from "bun:test";
import { AvatarDeleteResult, AvatarDeletePreview } from "./avatarDelete";
import { ENGINE_COMMAND_TYPES, MAIN_ONLY_COMMANDS, parseEngineCommand, parseMessage } from "./index";
import { ERROR_CODES, ERROR_MESSAGES_RU, EVENT_TYPES, PROTOCOL_VERSION } from "./index";

// «Удалить аватар»: the contract's additive part. The renderer names an avatar and nothing else; the Trash is main's.

const preview = { avatarId: "avatar-0001", photos: 12, candidates: 0, drafts: 2, videos: 3, videoFilesFound: 2, videoFilesUnchecked: 0 };
const envelope = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command" };

describe("AvatarDeletePreview", () => {
  test("accepts counts of what would go", () => {
    expect(AvatarDeletePreview.safeParse(preview).success).toBe(true);
  });

  test("accepts an avatar with nothing but itself", () => {
    expect(AvatarDeletePreview.safeParse({ avatarId: "avatar-0001", photos: 0, candidates: 0, drafts: 0, videos: 0, videoFilesFound: 0, videoFilesUnchecked: 0 }).success).toBe(true);
  });

  test("refuses a negative or fractional count", () => {
    expect(AvatarDeletePreview.safeParse({ ...preview, photos: -1 }).success).toBe(false);
    expect(AvatarDeletePreview.safeParse({ ...preview, drafts: 1.5 }).success).toBe(false);
  });

  test("refuses more video files than video records: one record names one file", () => {
    expect(AvatarDeletePreview.safeParse({ ...preview, videos: 1, videoFilesFound: 2 }).success).toBe(false);
  });

  test("refuses more files found and unchecked together than there are records", () => {
    expect(AvatarDeletePreview.safeParse({ ...preview, videos: 3, videoFilesFound: 2, videoFilesUnchecked: 2 }).success).toBe(false);
    expect(AvatarDeletePreview.safeParse({ ...preview, videos: 3, videoFilesFound: 2, videoFilesUnchecked: 1 }).success).toBe(true);
  });

  test("refuses a key it does not know, so a path cannot ride along", () => {
    expect(AvatarDeletePreview.safeParse({ ...preview, path: "/Users/a/library" }).success).toBe(false);
  });
});

describe("AvatarDeleteResult", () => {
  test("says how many video files went to the Trash and how many stayed", () => {
    expect(AvatarDeleteResult.safeParse({ avatarId: "avatar-0001", videoFilesTrashed: 2, videoFilesKept: 1, videoFilesUnchecked: 0, videoFolder: "Mia" }).success).toBe(true);
  });

  test("the folder is a name, never a path", () => {
    const base = { avatarId: "avatar-0001", videoFilesTrashed: 1, videoFilesKept: 0, videoFilesUnchecked: 0 };
    expect(AvatarDeleteResult.safeParse({ ...base, videoFolder: "Mia" }).success).toBe(true);
    expect(AvatarDeleteResult.safeParse({ ...base, videoFolder: "/home/a/export/Mia" }).success).toBe(false);
    expect(AvatarDeleteResult.safeParse({ ...base, videoFolder: "a\\b" }).success).toBe(false);
    expect(AvatarDeleteResult.safeParse({ ...base, videoFolder: ".." }).success).toBe(false);
  });

  test("refuses a key it does not know", () => {
    expect(AvatarDeleteResult.safeParse({ avatarId: "avatar-0001", videoFilesTrashed: 2, videoFilesKept: 1, videoFilesUnchecked: 0, videoFolder: null, paths: [] }).success).toBe(false);
  });
});

describe("the commands", () => {
  test("avatars.deletePreview is the engine's, and asks for an avatar id only", () => {
    expect(ENGINE_COMMAND_TYPES).toContain("avatars.deletePreview");
    expect(parseEngineCommand({ ...envelope, type: "avatars.deletePreview", payload: { avatarId: "avatar-0001" } }).ok).toBe(true);
    expect(parseEngineCommand({ ...envelope, type: "avatars.deletePreview", payload: { avatarId: "avatar-0001", path: "/x" } }).ok).toBe(false);
  });

  test("avatars.delete is main's alone: the engine does not accept it from the renderer", () => {
    expect(MAIN_ONLY_COMMANDS).toContain("avatars.delete");
    expect(ENGINE_COMMAND_TYPES).not.toContain("avatars.delete");
    expect(parseEngineCommand({ ...envelope, type: "avatars.delete", payload: { avatarId: "avatar-0001" } }).ok).toBe(false);
  });

  test("avatars.delete takes an avatar id and refuses a path or a list of files", () => {
    expect(parseMessage({ ...envelope, type: "avatars.delete", payload: { avatarId: "avatar-0001" } }).ok).toBe(true);
    expect(parseMessage({ ...envelope, type: "avatars.delete", payload: { avatarId: "avatar-0001", path: "/x" } }).ok).toBe(false);
    expect(parseMessage({ ...envelope, type: "avatars.delete", payload: { avatarId: "avatar-0001", files: ["/x"] } }).ok).toBe(false);
  });

  test("avatars.delete answers its result", () => {
    const response = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: "avatars.delete", ok: true, result: { avatarId: "avatar-0001", videoFilesTrashed: 0, videoFilesKept: 0, videoFilesUnchecked: 0, videoFolder: null } };
    expect(parseMessage(response).ok).toBe(true);
  });
});

describe("the event", () => {
  const event = { v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "avatar.removed", payload: { avatarId: "avatar-0001" } };

  test("avatar.removed names the avatar that is gone", () => {
    expect(EVENT_TYPES).toContain("avatar.removed");
    expect(parseMessage(event).ok).toBe(true);
  });

  test("avatar.removed carries the id and nothing else", () => {
    expect(parseMessage({ ...event, payload: { avatarId: "avatar-0001", path: "/x" } }).ok).toBe(false);
  });
});

describe("TRASH_UNAVAILABLE", () => {
  test("is an error code with a Russian text that says nothing was deleted for good", () => {
    expect(ERROR_CODES).toContain("TRASH_UNAVAILABLE");
    expect(ERROR_MESSAGES_RU.TRASH_UNAVAILABLE).toContain("Корзин");
    expect(ERROR_MESSAGES_RU.TRASH_UNAVAILABLE).toContain("не удалён");
  });

  test("is the same on every system: the advice for a volume with no Trash is the window's, by platform (renderer/screens/AvatarDelete.tsx)", () => {
    expect(ERROR_MESSAGES_RU.TRASH_UNAVAILABLE).not.toContain("один раз");
    expect(ERROR_MESSAGES_RU.TRASH_UNAVAILABLE).not.toContain("Finder");
  });
});
