import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION, ResponseMessage, type CommandMessage, type EngineError } from "../shared/engine";
import type { AvatarDeletePlan } from "../engine/control";
import { handleAvatarDeleteCommand, isAvatarDeleteCommand, type AvatarDeleteFlowDeps, type EntryKind } from "./avatarDeleteFlow";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// «Удалить аватар», main's side: the window names an avatar; the ENGINE resolves what goes; main checks every path against its own roots, moves the
// avatar's folder to the system Trash FIRST, tells the engine whether it went, and only then moves the video files. Nothing outside the library root
// and the export root is ever moved, and a link is never followed out of them.

const AVATAR = "avatar-0001";
const LIBRARY = "/data/library";
const EXPORT = "/home/a/Studio/export";
const FOLDER = `${LIBRARY}/avatars/${AVATAR}`;
const FILE_A = `${EXPORT}/Mia/2026-10-05_photo_001.mp4`;
const FILE_B = `${EXPORT}/Mia/2026-10-05_photo_002.mp4`;

const command = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type: "avatars.delete", payload: { avatarId: AVATAR } } as const satisfies CommandMessage;

function planOf(over: Partial<AvatarDeletePlan> = {}): AvatarDeletePlan {
  return { avatarId: AVATAR, libraryRoot: LIBRARY, folder: FOLDER, exportRoot: EXPORT, files: [FILE_A, FILE_B], unlisted: 0, ...over };
}

interface Rig {
  readonly deps: AvatarDeleteFlowDeps;
  /** Everything that happened, in order: `prepare`, `finish:<outcome>`, `trash:<path>`. */
  readonly log: string[];
  /** Entries by path; a path not here does not exist. Change it to play a disk that moves under the flow. */
  readonly disk: Map<string, EntryKind>;
  /** Real places by path (a link's target); a path not here is its own real place. */
  readonly real: Map<string, string>;
  readonly failTrash: Set<string>;
  readonly lines: string[];
  /** The token each call to the engine carried, `prepare:<token>` and `finish:<token>`. */
  readonly tokens: string[];
  /** The identity (device and inode) of a path, as the disk would say; a path not here is its own identity, spelled exactly. A cased-apart pair is one place only when both say the same. */
  readonly ids: Map<string, string>;
}

function rig(over: { plan?: AvatarDeletePlan; prepareError?: EngineError; finishError?: EngineError; platform?: NodeJS.Platform; trashable?: (path: string) => boolean; libraryPath?: string; exportPath?: string } = {}): Rig {
  const log: string[] = [];
  const lines: string[] = [];
  const tokens: string[] = [];
  const ids = new Map<string, string>();
  const disk = new Map<string, EntryKind>([
    [FOLDER, "directory"],
    [`${LIBRARY}/avatars`, "directory"],
    [LIBRARY, "directory"],
    [EXPORT, "directory"],
    [`${EXPORT}/Mia`, "directory"],
    [FILE_A, "file"],
    [FILE_B, "file"],
  ]);
  const real = new Map<string, string>();
  const failTrash = new Set<string>();
  const deps: AvatarDeleteFlowDeps = {
    engine: {
      prepareAvatarDelete: async (_id, token) => {
        tokens.push(`prepare:${token}`);
        log.push("prepare");
        return over.prepareError === undefined ? { error: null, deletePlan: over.plan ?? planOf() } : { error: over.prepareError };
      },
      finishAvatarDelete: async (_id, token, outcome) => {
        tokens.push(`finish:${token}`);
        log.push(`finish:${outcome}`);
        return { error: over.finishError ?? null };
      },
      pruneMissingAvatars: async () => {
        log.push("prune");
        return { error: null };
      },
    },
    libraryPath: () => over.libraryPath ?? LIBRARY,
    exportPath: () => over.exportPath ?? EXPORT,
    fs: {
      realpath: async (path) => {
        if (!disk.has(path)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return real.get(path) ?? path;
      },
      lstat: async (path) => disk.get(path) ?? null,
      identity: async (path) => ids.get(path) ?? (disk.has(path) ? `id:${path}` : null),
    },
    newToken: () => "token-00000001",
    trash: async (path) => {
      log.push(`trash:${path}`);
      if (failTrash.has(path)) throw new Error(`could not trash ${path}`);
      disk.delete(path);
    },
    trashable: async (path) => over.trashable?.(path) ?? true,
    platform: over.platform ?? "darwin",
    log: (line) => lines.push(line),
  };
  return { deps, log, disk, real, failTrash, lines, tokens, ids };
}

const answered = (response: ResponseMessage) => {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  return response;
};

describe("isAvatarDeleteCommand", () => {
  test("is true for avatars.delete and for nothing else", () => {
    expect(isAvatarDeleteCommand(command)).toBe(true);
    expect(isAvatarDeleteCommand({ ...command, type: "avatars.archive" })).toBe(false);
  });
});

describe("the order", () => {
  test("the avatar's folder goes first, the engine is told, and only then the video files", async () => {
    const r = rig();

    const response = answered(await handleAvatarDeleteCommand(command, r.deps));

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:trashed", `trash:${FILE_A}`, `trash:${FILE_B}`]);
    expect(response).toMatchObject({ ok: true, type: "avatars.delete", result: { avatarId: AVATAR, videoFilesTrashed: 2, videoFilesKept: 0 } });
  });

  test("the answer carries counts only: no path", async () => {
    const r = rig();

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(JSON.stringify(response)).not.toContain("/data");
    expect(JSON.stringify(response)).not.toContain("/home");
  });

  test("an avatar with no video files moves its folder alone", async () => {
    const r = rig({ plan: planOf({ files: [], exportRoot: null }) });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:trashed"]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 0 } });
  });
});

describe("the engine refuses", () => {
  test("its refusal is the answer, and nothing is moved or finished", async () => {
    const r = rig({ prepareError: { code: "IN_FLIGHT", detail: "a render of this avatar is running" } });

    const response = answered(await handleAvatarDeleteCommand(command, r.deps));

    expect(r.log).toEqual(["prepare"]);
    expect(response).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("a prepare that got no answer (INTERNAL: it timed out, or the reply was lost) is ended with a best-effort `kept`, so a claim the engine took cannot outlive it", async () => {
    const r = rig({ prepareError: { code: "INTERNAL", detail: "the engine did not answer within 45 s" } });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  test("a refusal the engine gave (IN_FLIGHT, NOT_FOUND) holds no claim, so nothing is finished", async () => {
    for (const code of ["IN_FLIGHT", "NOT_FOUND", "LIBRARY_UNAVAILABLE"] as const) {
      const r = rig({ prepareError: { code } });
      await handleAvatarDeleteCommand(command, r.deps);
      expect(r.log).toEqual(["prepare"]);
    }
  });

  test("an answer without a plan is INTERNAL, and nothing is moved and the claim it may hold is let go", async () => {
    const r = rig();
    r.deps.engine.prepareAvatarDelete = async () => ({ error: null });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });
});

describe("the Trash refuses the avatar's folder", () => {
  test("the engine is told `kept`, no video file is moved, and the owner gets TRASH_UNAVAILABLE", async () => {
    const r = rig();
    r.failTrash.add(FOLDER);

    const response = answered(await handleAvatarDeleteCommand(command, r.deps));

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "TRASH_UNAVAILABLE" } });
    expect(r.disk.has(FILE_A)).toBe(true);
    expect(r.disk.has(FILE_B)).toBe(true);
  });

  test("a failure after which the folder is gone anyway counts as trashed", async () => {
    const r = rig();
    r.deps.trash = async (path) => {
      r.log.push(`trash:${path}`);
      r.disk.delete(path);
      throw new Error("the shell reported an error after the move");
    };

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log.slice(0, 3)).toEqual(["prepare", `trash:${FOLDER}`, "finish:trashed"]);
    expect(response).toMatchObject({ ok: true });
  });

  test("a volume without a Trash (a network drive) is refused before anything is moved, never deleted for good", async () => {
    const r = rig({ trashable: (path) => !path.startsWith(LIBRARY) });

    const response = answered(await handleAvatarDeleteCommand(command, r.deps));

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "TRASH_UNAVAILABLE" } });
    expect(r.disk.has(FOLDER)).toBe(true);
  });
});

describe("a video file on a volume with no Trash", () => {
  test("is left where it is and counted as kept, never moved (it could be deleted for good); the avatar still goes", async () => {
    const r = rig({ trashable: (path) => !path.startsWith(EXPORT) });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:trashed"]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });
});

describe("a video file the Trash refuses", () => {
  test("stays as a plain file, is counted as kept, and the avatar is gone all the same", async () => {
    const r = rig();
    r.failTrash.add(FILE_A);

    const response = answered(await handleAvatarDeleteCommand(command, r.deps));

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1, videoFilesKept: 1 } });
    expect(r.disk.has(FILE_A)).toBe(true);
    expect(r.log).toContain("finish:trashed");
  });

  test("the failure is logged by its place in the plan and never by a path", async () => {
    const r = rig();
    r.failTrash.add(FILE_A);

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.lines.length).toBeGreaterThan(0);
    for (const line of r.lines) {
      expect(line).not.toContain("/home");
      expect(line).not.toContain("/data");
    }
  });

  test("the files the engine could not prove in time are counted apart from the ones the Trash refused", async () => {
    const r = rig({ plan: planOf({ unlisted: 3 }) });
    r.failTrash.add(FILE_A);

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1, videoFilesKept: 1, videoFilesUnchecked: 3 } });
  });

  test("names the avatar's folder inside the export folder (a name, never a path)", async () => {
    const r = rig();

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true, result: { videoFolder: "Mia" } });
  });

  test("names none when no video file was planned", async () => {
    const r = rig({ plan: planOf({ files: [], exportRoot: null }) });

    expect(await handleAvatarDeleteCommand(command, r.deps)).toMatchObject({ ok: true, result: { videoFolder: null } });
  });
});

describe("a path that fails main's own check is never moved", () => {
  test("a plan for another avatar than the one asked for: kept, nothing moved", async () => {
    const r = rig({ plan: planOf({ avatarId: "avatar-0002" }) });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
  });

  test("a folder outside the library's avatars folder is refused", async () => {
    const outside = "/data/elsewhere/avatars/avatar-0001";
    const r = rig({ plan: planOf({ folder: outside }) });
    r.disk.set(outside, "directory");
    r.disk.set("/data/elsewhere/avatars", "directory");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false });
  });

  test("a folder that is not named after the avatar is refused", async () => {
    const wrong = `${LIBRARY}/avatars/avatar-0002`;
    const r = rig({ plan: planOf({ folder: wrong }) });
    r.disk.set(wrong, "directory");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("the library root itself is never moved", async () => {
    const r = rig({ plan: planOf({ folder: LIBRARY }) });

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("a folder that is a link is refused: a link is never followed out of the library", async () => {
    const r = rig();
    r.disk.set(FOLDER, "symlink");
    r.real.set(FOLDER, "/Users/a/Documents");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("an avatars folder that is a link to somewhere else is refused", async () => {
    const r = rig();
    r.real.set(`${LIBRARY}/avatars`, "/Users/a/Documents/avatars");
    r.real.set(FOLDER, `/Users/a/Documents/avatars/${AVATAR}`);

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("a folder that is not a folder is refused", async () => {
    const r = rig();
    r.disk.set(FOLDER, "file");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("a library other than the one main's settings name is refused", async () => {
    const r = rig({ libraryPath: "/data/another-library" });
    r.disk.set("/data/another-library", "directory");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("the library may be spelled through a link: it is the same place when the real paths agree", async () => {
    const r = rig({ libraryPath: "/alias/library" });
    r.disk.set("/alias/library", "directory");
    r.real.set("/alias/library", LIBRARY);

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log[1]).toBe(`trash:${FOLDER}`);
  });

  test("a file outside the export folder is left alone and counted as kept; the rest still go", async () => {
    const stray = "/Users/a/Documents/secret.mp4";
    const r = rig({ plan: planOf({ files: [stray, FILE_B] }) });
    r.disk.set(stray, "file");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain(`trash:${stray}`);
    expect(r.log).toContain(`trash:${FILE_B}`);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1, videoFilesKept: 1 } });
  });

  test("a file inside the library is never moved as a video file", async () => {
    const inLibrary = `${LIBRARY}/avatars/avatar-0009/photos/a.png`;
    const r = rig({ plan: planOf({ files: [inLibrary] }) });
    r.disk.set(inLibrary, "file");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain(`trash:${inLibrary}`);
  });

  test("a file deeper than <folder>/<file> inside the export folder is not a video file of ours", async () => {
    const deep = `${EXPORT}/Mia/nested/a.mp4`;
    const r = rig({ plan: planOf({ files: [deep] }) });
    r.disk.set(deep, "file");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain(`trash:${deep}`);
  });

  test("a file that is a link is left alone", async () => {
    const r = rig();
    r.disk.set(FILE_A, "symlink");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain(`trash:${FILE_A}`);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1, videoFilesKept: 1 } });
  });

  test("a file in a folder that is a link out of the export folder is left alone", async () => {
    const r = rig();
    r.real.set(`${EXPORT}/Mia`, "/Users/a/Documents/Mia");
    r.real.set(FILE_A, "/Users/a/Documents/Mia/2026-10-05_photo_001.mp4");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log.filter((line) => line.startsWith("trash:") && line !== `trash:${FOLDER}`)).toEqual([]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });

  test("a file replaced by a link after the folder went is looked at again and left alone", async () => {
    const r = rig();
    const trash = r.deps.trash;
    r.deps.trash = async (path) => {
      await trash(path);
      if (path === FOLDER) r.disk.set(FILE_A, "symlink"); // between the check and the move
    };

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain(`trash:${FILE_A}`);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1, videoFilesKept: 1 } });
  });

  test("an export folder other than the one main's settings name: no video file is moved, the avatar still is", async () => {
    const r = rig({ exportPath: "/home/a/Another/export" });
    r.disk.set("/home/a/Another/export", "directory");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:trashed"]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });
});

describe("the two roots may not overlap", () => {
  test("an export folder inside the library: no video file is moved, the avatar still is", async () => {
    const exportInside = `${LIBRARY}/export`;
    const file = `${exportInside}/Mia/a.mp4`;
    const r = rig({ plan: planOf({ exportRoot: exportInside, files: [file] }), exportPath: exportInside });
    r.disk.set(exportInside, "directory");
    r.disk.set(`${exportInside}/Mia`, "directory");
    r.disk.set(file, "file");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:trashed"]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 1 } });
  });

  test("a library inside the export folder: no video file is moved, the avatar still is", async () => {
    const libraryInside = `${EXPORT}/lib`;
    const folder = `${libraryInside}/avatars/${AVATAR}`;
    const r = rig({ plan: planOf({ libraryRoot: libraryInside, folder }), libraryPath: libraryInside });
    r.disk.set(libraryInside, "directory");
    r.disk.set(`${libraryInside}/avatars`, "directory");
    r.disk.set(folder, "directory");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${folder}`, "finish:trashed"]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });

  test("the same folder for both is refused for the files", async () => {
    const r = rig({ plan: planOf({ exportRoot: LIBRARY, files: [`${LIBRARY}/Mia/a.mp4`] }), exportPath: LIBRARY });
    r.disk.set(`${LIBRARY}/Mia`, "directory");
    r.disk.set(`${LIBRARY}/Mia/a.mp4`, "file");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 1 } });
  });
});

describe("the folder is looked at again right before it moves", () => {
  test("a folder replaced by a link after the first look is refused and nothing is moved", async () => {
    const r = rig();
    r.deps.trashable = async () => {
      r.disk.set(FOLDER, "symlink"); // between the first look and the move
      return true;
    };

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false });
  });

  test("a move the Trash called done that left the folder where it was is `kept`, not `trashed`", async () => {
    const r = rig();
    r.deps.trash = async (path) => {
      r.log.push(`trash:${path}`); // answers ok and moves nothing
    };

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${FOLDER}`, "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "TRASH_UNAVAILABLE" } });
  });
});

describe("the Trash is asked about the REAL place, not the plan's spelling", () => {
  test("a library reached through a link is judged where it really is", async () => {
    const asked: string[] = [];
    const r = rig();
    r.real.set(LIBRARY, "/mnt/real/library");
    r.real.set(`${LIBRARY}/avatars`, "/mnt/real/library/avatars");
    r.real.set(FOLDER, `/mnt/real/library/avatars/${AVATAR}`);
    r.deps.trashable = async (path) => {
      asked.push(path);
      return true;
    };

    await handleAvatarDeleteCommand(command, r.deps);

    expect(asked[0]).toBe(`/mnt/real/library/avatars/${AVATAR}`);
    // and it is that real path that moves, not the plan's spelling
    expect(r.log).toContain(`trash:/mnt/real/library/avatars/${AVATAR}`);
    expect(r.log).not.toContain(`trash:${FOLDER}`);
  });

  test("a video file moves by its real path too", async () => {
    const r = rig();
    r.real.set(EXPORT, "/mnt/real/export");
    r.real.set(`${EXPORT}/Mia`, "/mnt/real/export/Mia");
    r.real.set(FILE_A, "/mnt/real/export/Mia/2026-10-05_photo_001.mp4");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toContain("trash:/mnt/real/export/Mia/2026-10-05_photo_001.mp4");
    expect(r.log).not.toContain(`trash:${FILE_A}`);
  });

  test("a video file's own volume is judged by its real place too", async () => {
    const asked: string[] = [];
    const r = rig();
    r.real.set(EXPORT, "/Volumes/Share/export");
    r.real.set(`${EXPORT}/Mia`, "/Volumes/Share/export/Mia");
    r.real.set(FILE_A, "/Volumes/Share/export/Mia/2026-10-05_photo_001.mp4");
    r.deps.trashable = async (path) => {
      asked.push(path);
      return !path.startsWith("/Volumes/Share");
    };

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(asked).toContain("/Volumes/Share/export/Mia/2026-10-05_photo_001.mp4");
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });
});

describe("two spellings are one place only when the disk says they are one thing (dev and inode), never by folding the case", () => {
  /** The export subfolder the engine named is `Mia`; the real path of its files says `mia`. */
  function renamed(r: Rig): void {
    r.real.set(`${EXPORT}/Mia`, `${EXPORT}/mia`);
    r.real.set(FILE_A, `${EXPORT}/mia/2026-10-05_photo_001.mp4`);
    r.real.set(FILE_B, `${EXPORT}/mia/2026-10-05_photo_002.mp4`);
    r.disk.set(`${EXPORT}/mia`, "directory");
  }

  test("a case-insensitive volume: `Mia` and `mia` are one folder (the same inode), so a true video is moved, on every platform", async () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      const r = rig({ platform: platform === "win32" ? "darwin" : platform });
      renamed(r);
      r.ids.set(`${EXPORT}/Mia`, "dev1:ino77");
      r.ids.set(`${EXPORT}/mia`, "dev1:ino77");

      const response = await handleAvatarDeleteCommand(command, r.deps);

      expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 2, videoFilesKept: 0 } });
    }
  });

  test("a case-sensitive volume (APFS case-sensitive): `Mia` and `mia` are two folders (two inodes), and the files of the other one are left alone", async () => {
    const r = rig({ platform: "darwin" });
    renamed(r);
    r.ids.set(`${EXPORT}/Mia`, "dev1:ino77");
    r.ids.set(`${EXPORT}/mia`, "dev1:ino88");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log.filter((line) => line.startsWith("trash:") && line !== `trash:${FOLDER}`)).toEqual([]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });

  test("`Mia` that is a link to `mia` (another avatar's videos) is refused: the link's own identity is not the folder's", async () => {
    const r = rig({ platform: "darwin" });
    renamed(r);
    r.ids.set(`${EXPORT}/Mia`, "dev1:link5"); // lstat of the link itself
    r.ids.set(`${EXPORT}/mia`, "dev1:ino88");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });

  test("a place whose identity cannot be read is not accepted when it is spelled differently", async () => {
    const r = rig({ platform: "darwin" });
    renamed(r);
    r.ids.set(`${EXPORT}/Mia`, "dev1:ino77");
    r.deps.fs.identity = async () => null;

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 2 } });
  });

  test("the avatars folder spelled `AVATARS` by the real path is another folder on a case-sensitive volume: refused, nothing moved", async () => {
    const r = rig({ platform: "darwin" });
    r.real.set(`${LIBRARY}/avatars`, `${LIBRARY}/AVATARS`);
    r.real.set(FOLDER, `${LIBRARY}/AVATARS/${AVATAR}`);
    r.disk.set(`${LIBRARY}/AVATARS`, "directory");
    r.disk.set(`${LIBRARY}/AVATARS/${AVATAR}`, "directory");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false });
  });

  test("the same real folder spelled `AVATARS` on a case-insensitive volume (one inode) is accepted, and the REAL path is what moves", async () => {
    const r = rig({ platform: "darwin" });
    r.real.set(`${LIBRARY}/avatars`, `${LIBRARY}/AVATARS`);
    r.real.set(FOLDER, `${LIBRARY}/AVATARS/${AVATAR}`);
    r.disk.set(`${LIBRARY}/AVATARS`, "directory");
    r.disk.set(`${LIBRARY}/AVATARS/${AVATAR}`, "directory");
    r.ids.set(`${LIBRARY}/AVATARS/${AVATAR}`, "dev1:ino1");
    r.ids.set(`${LIBRARY}/avatars/${AVATAR}`, "dev1:ino1");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log[1]).toBe(`trash:${LIBRARY}/AVATARS/${AVATAR}`);
  });

  test("an `avatars` that is a link is refused even when the folder seen through it has the very identity of the real one (the identity of the path is read THROUGH the link)", async () => {
    const r = rig({ platform: "darwin" });
    r.real.set(`${LIBRARY}/avatars`, "/elsewhere/avatars");
    r.real.set(FOLDER, `/elsewhere/avatars/${AVATAR}`);
    r.disk.set(`${LIBRARY}/avatars`, "symlink");
    r.disk.set(`/elsewhere/avatars/${AVATAR}`, "directory");
    r.ids.set(FOLDER, "dev1:ino9");
    r.ids.set(`/elsewhere/avatars/${AVATAR}`, "dev1:ino9");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false });
  });

  test("a plan whose folder is spelled with another case than the library's own naming is refused, whatever the platform", async () => {
    const wrong = `${LIBRARY}/AVATARS/${AVATAR}`;
    const r = rig({ platform: "darwin", plan: planOf({ folder: wrong }) });
    r.disk.set(wrong, "directory");

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
  });

  test("the two roots may not overlap even when only the case tells them apart", async () => {
    const r = rig({ platform: "darwin", plan: planOf({ exportRoot: `${LIBRARY.toUpperCase()}/export`, files: [`${LIBRARY.toUpperCase()}/export/Mia/a.mp4`] }), exportPath: `${LIBRARY.toUpperCase()}/export` });
    for (const path of [`${LIBRARY.toUpperCase()}/export`, `${LIBRARY.toUpperCase()}/export/Mia`, `${LIBRARY.toUpperCase()}/export/Mia/a.mp4`]) r.disk.set(path, path.endsWith(".mp4") ? "file" : "directory");

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 0, videoFilesKept: 1 } });
  });
});

describe("the engine losing the delete", () => {
  test("a finish the engine does not know after the folder is gone asks it to forget what the disk no longer has", async () => {
    const r = rig({ finishError: { code: "NOT_FOUND", detail: "no delete of avatar avatar-0001 is pending" } });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toContain("prune");
    expect(r.log.indexOf("prune")).toBeGreaterThan(r.log.indexOf("finish:trashed"));
    expect(response).toMatchObject({ ok: true });
  });

  test("a finish the engine took asks for no pruning", async () => {
    const r = rig();

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain("prune");
  });

  test("a finish that got no answer (INTERNAL: a timeout, a dead engine) asks for no pruning: only an engine that answered NOT_FOUND is known to have lost the delete", async () => {
    const r = rig({ finishError: { code: "INTERNAL", detail: "the engine did not answer within 30 s" } });

    await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).not.toContain("prune");
  });
});

describe("the token that ties a finish to its prepare", () => {
  test("one fresh token goes with the prepare and with the finish, and with the best-effort finish after a prepare that was not answered", async () => {
    const r = rig();
    await handleAvatarDeleteCommand(command, r.deps);
    expect(r.tokens).toEqual(["prepare:token-00000001", "finish:token-00000001"]);

    const lost = rig({ prepareError: { code: "INTERNAL" } });
    await handleAvatarDeleteCommand(command, lost.deps);
    expect(lost.tokens).toEqual(["prepare:token-00000001", "finish:token-00000001"]);
  });
});

describe("a failure in main between prepare and finish", () => {
  test("a disk error while checking the folder tells the engine `kept` and answers INTERNAL with no path", async () => {
    const r = rig();
    r.deps.fs.lstat = async () => {
      throw Object.assign(new Error(`EIO: i/o error, lstat '${FOLDER}'`), { code: "EIO" });
    };

    const response = answered(await handleAvatarDeleteCommand(command, r.deps));

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(JSON.stringify(response)).not.toContain("/data");
  });

  test("the engine not knowing the delete any more (it restarted) does not undo the move: the answer is still ok", async () => {
    const r = rig({ finishError: { code: "NOT_FOUND", detail: "no delete of avatar avatar-0001 is pending" } });

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(response).toMatchObject({ ok: true });
    expect(r.log).toContain(`trash:${FILE_A}`);
  });
});

describe("Windows", () => {
  const WIN_LIBRARY = "C:\\Data\\Library";
  const WIN_EXPORT = "C:\\Users\\a\\Studio\\export";
  const WIN_FOLDER = `${WIN_LIBRARY}\\avatars\\${AVATAR}`;
  const WIN_FILE = `${WIN_EXPORT}\\Mia\\2026-10-05_photo_001.mp4`;

  function winRig() {
    const r = rig({ platform: "win32", plan: planOf({ libraryRoot: WIN_LIBRARY, folder: WIN_FOLDER, exportRoot: WIN_EXPORT, files: [WIN_FILE] }), libraryPath: WIN_LIBRARY, exportPath: WIN_EXPORT });
    r.disk.clear();
    for (const [path, kind] of [
      [WIN_LIBRARY, "directory"],
      [`${WIN_LIBRARY}\\avatars`, "directory"],
      [WIN_FOLDER, "directory"],
      [WIN_EXPORT, "directory"],
      [`${WIN_EXPORT}\\Mia`, "directory"],
      [WIN_FILE, "file"],
    ] as const) r.disk.set(path, kind);
    return r;
  }

  test("moves the folder and the file with backslash paths", async () => {
    const r = winRig();

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", `trash:${WIN_FOLDER}`, "finish:trashed", `trash:${WIN_FILE}`]);
    expect(response).toMatchObject({ ok: true, result: { videoFilesTrashed: 1 } });
  });

  test("a drive letter's case does not make a place another place", async () => {
    const r = winRig();
    r.real.set(WIN_LIBRARY, "c:\\data\\library");
    r.real.set(`${WIN_LIBRARY}\\avatars`, "c:\\data\\library\\avatars");
    r.real.set(WIN_FOLDER, `c:\\data\\library\\avatars\\${AVATAR}`);
    // the same folders, as the volume says: one inode each
    r.ids.set(WIN_LIBRARY, "v:1");
    r.ids.set("c:\\data\\library", "v:1");
    r.ids.set(`${WIN_LIBRARY}\\avatars\\${AVATAR}`, "v:3");
    r.ids.set(`c:\\data\\library\\avatars\\${AVATAR}`, "v:3");

    await handleAvatarDeleteCommand(command, r.deps);

    // the REAL path is what moves
    expect(r.log[1]).toBe(`trash:c:\\data\\library\\avatars\\${AVATAR}`);
  });

  test("a folder on a network share is refused when the Recycle Bin cannot take it", async () => {
    const r = winRig();
    r.deps.trashable = async () => false;

    const response = await handleAvatarDeleteCommand(command, r.deps);

    expect(r.log).toEqual(["prepare", "finish:kept"]);
    expect(response).toMatchObject({ ok: false, error: { code: "TRASH_UNAVAILABLE" } });
  });
});
