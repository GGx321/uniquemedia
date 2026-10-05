import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PROTOCOL_VERSION, type CommandMessage } from "../shared/engine";
import type { AvatarDeletePlan } from "../engine/control";
import { handleAvatarDeleteCommand, NODE_FLOW_FS, type AvatarDeleteFlowDeps } from "./avatarDeleteFlow";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The flow over a REAL disk: the paths are real (a temp folder is itself under a link on macOS), `lstat` and `realpath` are the real ones, and the
// "Trash" is a folder the moved item is renamed into. A link in the way must never take the move out of the library or the export folder.

const AVATAR = "avatar-0001";
const command = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type: "avatars.delete", payload: { avatarId: AVATAR } } as const satisfies CommandMessage;

let dir = "";
let library = "";
let exported = "";
let outside = "";
let trashDir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-avatar-delete-fs-"));
  library = join(dir, "library");
  exported = join(dir, "export");
  outside = join(dir, "outside");
  trashDir = join(dir, "trash");
  for (const folder of [join(library, "avatars", AVATAR, "photos"), join(exported, "Mia"), outside, trashDir]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(library, "avatars", AVATAR, "avatar.json"), "{}");
  writeFileSync(join(library, "avatars", AVATAR, "photos", "a.png"), "png");
  writeFileSync(join(exported, "Mia", "a.mp4"), "video a");
  writeFileSync(join(exported, "Mia", "b.mp4"), "video b");
  writeFileSync(join(outside, "precious.txt"), "do not move");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function planOf(over: Partial<AvatarDeletePlan> = {}): AvatarDeletePlan {
  return { avatarId: AVATAR, libraryRoot: library, folder: join(library, "avatars", AVATAR), exportRoot: exported, files: [join(exported, "Mia", "a.mp4"), join(exported, "Mia", "b.mp4")], unlisted: 0, ...over };
}

function deps(plan: AvatarDeletePlan, calls: string[] = []): AvatarDeleteFlowDeps {
  return {
    engine: {
      prepareAvatarDelete: async () => ({ error: null, deletePlan: plan }),
      finishAvatarDelete: async (_id, _token, outcome) => {
        calls.push(`finish:${outcome}`);
        return { error: null };
      },
      pruneMissingAvatars: async () => ({ error: null }),
    },
    libraryPath: () => library,
    exportPath: () => exported,
    fs: NODE_FLOW_FS,
    newToken: () => "token-00000001",
    trash: async (path) => {
      calls.push(`trash:${basename(path)}`);
      renameSync(path, join(trashDir, `${calls.length}-${basename(path)}`));
    },
    trashable: async () => true,
    platform: process.platform,
  };
}

describe("over a real disk", () => {
  test("the avatar's folder and its video files end up in the Trash, and nothing else moves", async () => {
    const calls: string[] = [];

    const response = await handleAvatarDeleteCommand(command, deps(planOf(), calls));

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 2, videoFilesKept: 0 } });
    expect(calls).toEqual([`trash:${AVATAR}`, "finish:trashed", "trash:a.mp4", "trash:b.mp4"]);
    expect(existsSync(join(library, "avatars", AVATAR))).toBe(false);
    expect(existsSync(join(exported, "Mia", "a.mp4"))).toBe(false);
    expect(existsSync(join(library, "avatars"))).toBe(true);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("do not move");
  });

  test("an avatar folder that is a link to a folder elsewhere moves nothing", async () => {
    rmSync(join(library, "avatars", AVATAR), { recursive: true });
    symlinkSync(outside, join(library, "avatars", AVATAR));
    const calls: string[] = [];

    const response = await handleAvatarDeleteCommand(command, deps(planOf(), calls));

    expect(response).toMatchObject({ ok: false });
    expect(calls).toEqual(["finish:kept"]);
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("do not move");
  });

  test("an avatars folder that is a link out of the library moves nothing", async () => {
    rmSync(join(library, "avatars"), { recursive: true });
    mkdirSync(join(outside, "avatars", AVATAR), { recursive: true });
    symlinkSync(join(outside, "avatars"), join(library, "avatars"));
    const calls: string[] = [];

    await handleAvatarDeleteCommand(command, deps(planOf(), calls));

    expect(calls).toEqual(["finish:kept"]);
    expect(existsSync(join(outside, "avatars", AVATAR))).toBe(true);
  });

  test("a video file that is a link to a file elsewhere is left in place, and so is its target", async () => {
    rmSync(join(exported, "Mia", "a.mp4"));
    symlinkSync(join(outside, "precious.txt"), join(exported, "Mia", "a.mp4"));
    const calls: string[] = [];

    const response = await handleAvatarDeleteCommand(command, deps(planOf(), calls));

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1, videoFilesKept: 1 } });
    expect(calls).not.toContain("trash:a.mp4");
    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("do not move");
  });

  test("an export subfolder that is a link out of the export folder moves none of what is behind it", async () => {
    rmSync(join(exported, "Mia"), { recursive: true });
    mkdirSync(join(outside, "Mia"));
    writeFileSync(join(outside, "Mia", "a.mp4"), "someone else's");
    writeFileSync(join(outside, "Mia", "b.mp4"), "someone else's");
    symlinkSync(join(outside, "Mia"), join(exported, "Mia"));
    const calls: string[] = [];

    const response = await handleAvatarDeleteCommand(command, deps(planOf(), calls));

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
    expect(existsSync(join(outside, "Mia", "a.mp4"))).toBe(true);
    expect(existsSync(join(outside, "Mia", "b.mp4"))).toBe(true);
  });

  test("a plan that names a file of the library as a video file moves nothing of the library but the avatar's folder", async () => {
    const calls: string[] = [];
    const sneaky = join(library, "library.json");
    writeFileSync(sneaky, "{}");

    await handleAvatarDeleteCommand(command, deps(planOf({ files: [sneaky] }), calls));

    expect(calls).toEqual([`trash:${AVATAR}`, "finish:trashed"]);
    expect(existsSync(sneaky)).toBe(true);
  });

  test("a plan that names a file outside every root moves nothing outside", async () => {
    const calls: string[] = [];

    await handleAvatarDeleteCommand(command, deps(planOf({ files: [join(outside, "precious.txt")] }), calls));

    expect(readFileSync(join(outside, "precious.txt"), "utf8")).toBe("do not move");
    expect(calls).toEqual([`trash:${AVATAR}`, "finish:trashed"]);
  });
});
