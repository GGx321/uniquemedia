import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CommandMessage, EXPORT_CHANGING_DETAIL, PROTOCOL_VERSION, type EngineCommandMessage, type ExportStatus, type FileState, type ResponseMessage, type VideoSummary } from "../shared/engine";
import { MIA, SOFIA } from "../renderer/engine/mockEngine.testkit";
import { useNativeGlobals } from "../testing/nativeGlobals";
import {
  handleRevealCommand,
  handleRevealFolderCommand,
  isRevealCommand,
  isRevealFolderCommand,
  placeOf,
  type RevealCommand,
  type RevealFlowDeps,
  type RevealFolderCommand,
  type RevealFolderFlowDeps,
} from "./revealFlow";
useNativeGlobals();

// «Открыть в папке» (3d.6) and «Папка «Готовые видео»» (3e.2, K17). The window names a video id or an avatar id and nothing
// else; main finds the place itself and asks the system file manager to show it. The export folder and the record's relative
// path never come from the window.

const EXPORT = join("/Users", "alex", "Reels");

function video(n: number, patch: Partial<VideoSummary> = {}, avatarId = MIA.avatarId): VideoSummary {
  return {
    videoId: `video-${String(n).padStart(8, "0")}`,
    avatarId,
    kind: "photo",
    durationMs: 8_000,
    bytes: 3_100_000,
    createdAt: "2026-10-03T10:00:00.000Z",
    relPath: `Mia/2026-10-03_photo_00${n}.mp4`,
    fileState: "present",
    montageId: null,
    photoCount: 1,
    music: null,
    hasPoster: false,
    title: null,
    firstClip: null,
    ...patch,
  };
}

interface Options {
  videos?: Record<string, VideoSummary[]>;
  getError?: ResponseMessage & { ok: false };
  platform?: NodeJS.Platform;
  exportPath?: string;
  exportStatus?: ExportStatus;
  folders?: string[];
  /** Links to a folder: a folder only when the link is followed. */
  links?: string[];
  openError?: string;
}

interface Harness {
  deps: RevealFlowDeps & RevealFolderFlowDeps;
  shown: string[];
  opened: string[];
  asked: EngineCommandMessage[];
}

function harness(options: Options = {}): Harness {
  const shown: string[] = [];
  const opened: string[] = [];
  const asked: EngineCommandMessage[] = [];
  let n = 0;
  const videos = options.videos ?? { [MIA.avatarId]: [video(1), video(2)], [SOFIA.avatarId]: [video(3, {}, SOFIA.avatarId)] };
  const all = Object.values(videos).flat();
  const deps: RevealFlowDeps & RevealFolderFlowDeps = {
    engine: {
      request: async (command): Promise<ResponseMessage> => {
        asked.push(command);
        const base = { v: PROTOCOL_VERSION, id: command.id, kind: "response" } as const;
        if (command.type === "videos.get") {
          if (options.getError !== undefined) return { ...options.getError, id: command.id, type: command.type };
          const found = all.find((v) => v.videoId === command.payload.videoId);
          if (found === undefined) return { ...base, type: command.type, ok: false, error: { code: "NOT_FOUND", detail: "no video" } };
          return { ...base, type: command.type, ok: true, result: { video: found } };
        }
        if (command.type === "videos.list") {
          const listed = videos[command.payload.avatarId];
          if (listed === undefined) return { ...base, type: command.type, ok: false, error: { code: "NOT_FOUND", detail: "no avatar" } };
          return { ...base, type: command.type, ok: true, result: { videos: listed } };
        }
        if (command.type === "export.check") return { ...base, type: command.type, ok: true, result: { exportStatus: options.exportStatus ?? { status: "ok" } } };
        return { ...base, type: command.type, ok: false, error: { code: "INTERNAL", detail: "unexpected" } };
      },
    },
    exportPath: () => options.exportPath ?? EXPORT,
    show: (path) => void shown.push(path),
    openFolder: async (path) => {
      opened.push(path);
      return options.openError ?? "";
    },
    isFolder: async (path, how) => (options.folders ?? [EXPORT, join(EXPORT, "Mia")]).includes(path) || (how?.followLink === true && (options.links ?? []).includes(path)),
    newId: () => `internal-${String(++n).padStart(4, "0")}`,
    platform: options.platform ?? process.platform,
  };
  return { deps, shown, opened, asked };
}

function reveal(videoId: string): RevealCommand {
  const parsed = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-rev-00001", kind: "command", type: "videos.reveal", payload: { videoId } });
  if (!isRevealCommand(parsed)) throw new Error("not a reveal command");
  return parsed;
}

function revealFolder(avatarId: string): RevealFolderCommand {
  const parsed = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-rev-00002", kind: "command", type: "videos.revealFolder", payload: { avatarId } });
  if (!isRevealFolderCommand(parsed)) throw new Error("not a revealFolder command");
  return parsed;
}

describe("videos.reveal", () => {
  test("shows the file of a present video, read by its id", async () => {
    const h = harness();
    const response = await handleRevealCommand(reveal("video-00000003"), h.deps);
    expect(response).toMatchObject({ ok: true, type: "videos.reveal", result: { videoId: "video-00000003" } });
    expect(h.shown).toEqual([join(EXPORT, "Mia", "2026-10-03_photo_003.mp4")]);
  });

  test("asks the engine ONE question, the video by id: never a listing (a video past the list's bound is found too, and fast)", async () => {
    const h = harness();
    await handleRevealCommand(reveal("video-00000001"), h.deps);
    expect(h.asked.map((c) => c.type)).toEqual(["videos.get"]);
  });

  test("an unknown video is NOT_FOUND and nothing is shown", async () => {
    const h = harness();
    const response = await handleRevealCommand(reveal("video-00000099"), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.shown).toEqual([]);
  });

  test.each<FileState>(["missing", "changed", "elsewhere", "unchecked"])("a video whose file is %s is not shown: only a present file is", async (fileState) => {
    const h = harness({ videos: { [MIA.avatarId]: [video(1, { fileState })] } });
    const response = await handleRevealCommand(reveal("video-00000001"), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.shown).toEqual([]);
  });

  test("an engine error is the answer, as it is", async () => {
    const h = harness({ getError: { v: PROTOCOL_VERSION, id: "x", kind: "response", type: "videos.get", ok: false, error: { code: "LIBRARY_TOO_NEW" } } });
    expect(await handleRevealCommand(reveal("video-00000001"), h.deps)).toMatchObject({ ok: false, error: { code: "LIBRARY_TOO_NEW" } });
    expect(h.shown).toEqual([]);
  });

  test("a relative path that would leave the export folder is never shown", async () => {
    for (const relPath of ["../outside/2026-10-03_photo_001.mp4", "/etc/passwd", "Mia/../../x.mp4"]) {
      const h = harness({ videos: { [MIA.avatarId]: [video(1, { relPath })] } });
      const response = await handleRevealCommand(reveal("video-00000001"), h.deps);
      expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
      expect(h.shown).toEqual([]);
    }
  });

  test("on Windows the path is joined with backslashes under the export folder", async () => {
    const h = harness({ platform: "win32", exportPath: "D:\\Reels" });
    await handleRevealCommand(reveal("video-00000001"), h.deps);
    expect(h.shown).toEqual(["D:\\Reels\\Mia\\2026-10-03_photo_001.mp4"]);
  });

  test("a switch of the export folder while the record was read refuses the reveal: the answer may name the old folder", async () => {
    const h = harness();
    let calls = 0;
    h.deps.exportPath = () => (++calls === 1 ? EXPORT : join("/Users", "alex", "Elsewhere"));
    const response = await handleRevealCommand(reveal("video-00000001"), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL } });
    expect(h.shown).toEqual([]);
  });

  test("a payload with a path is refused by the contract before the flow: the window names no path", () => {
    const parsed = CommandMessage.safeParse({ v: PROTOCOL_VERSION, id: "cmd-rev-00002", kind: "command", type: "videos.reveal", payload: { videoId: "video-00000001", path: "/etc/passwd" } });
    expect(parsed.success).toBe(false);
  });
});

describe("videos.revealFolder (K17)", () => {
  test("opens the avatar's own folder in the export folder, found from the place of one of its videos", async () => {
    const h = harness();
    const response = await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps);
    expect(response).toMatchObject({ ok: true, type: "videos.revealFolder", result: { opened: "avatar" } });
    expect(h.opened).toEqual([join(EXPORT, "Mia")]);
  });

  test("an avatar with no video yet opens the export folder itself", async () => {
    const h = harness({ videos: { [MIA.avatarId]: [] } });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "root" } });
    expect(h.opened).toEqual([EXPORT]);
  });

  test("a folder named only by videos of another export folder is not trusted: the export folder itself is opened", async () => {
    const h = harness({ videos: { [MIA.avatarId]: [video(1, { fileState: "elsewhere", relPath: "Old/2026-10-03_photo_001.mp4" })] }, folders: [EXPORT, join(EXPORT, "Old")] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "root" } });
    expect(h.opened).toEqual([EXPORT]);
  });

  test("the avatar's folder that is gone (or is not a folder) opens the export folder instead", async () => {
    const h = harness({ folders: [EXPORT] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "root" } });
    expect(h.opened).toEqual([EXPORT]);
  });

  test.each(["missing", "changed"] as const)("the avatar's folder is named by its newest video even when that file is %s: the folder is this export folder's", async (fileState) => {
    const h = harness({ videos: { [MIA.avatarId]: [video(1, { fileState }), video(2, { fileState: "elsewhere", relPath: "Old/2026-10-03_photo_002.mp4" })] }, folders: [EXPORT, join(EXPORT, "Mia"), join(EXPORT, "Old")] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "avatar" } });
    expect(h.opened).toEqual([join(EXPORT, "Mia")]);
  });

  test("an export folder that is no longer a folder when it would be opened refuses, and nothing opens: the shell would launch a file", async () => {
    const h = harness({ videos: { [MIA.avatarId]: [] }, folders: [] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(h.opened).toEqual([]);
  });

  test("an export folder that is a link to a folder still opens: the export check follows the link too", async () => {
    const h = harness({ videos: { [MIA.avatarId]: [] }, folders: [], links: [EXPORT] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "root" } });
    expect(h.opened).toEqual([EXPORT]);
  });

  test("the avatar's folder is never a link: a link inside the export folder is not followed, and the export folder opens instead", async () => {
    const h = harness({ folders: [EXPORT], links: [join(EXPORT, "Mia")] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "root" } });
    expect(h.opened).toEqual([EXPORT]);
  });

  test("an export folder that cannot be used is EXPORT_UNAVAILABLE with its reason, and nothing opens", async () => {
    const h = harness({ exportStatus: { status: "unavailable", reason: "missing" } });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: false, error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" } });
    expect(h.opened).toEqual([]);
  });

  test("an unknown avatar is the engine's NOT_FOUND, and nothing opens", async () => {
    const h = harness();
    expect(await handleRevealFolderCommand(revealFolder("avatar-nobody"), h.deps)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.opened).toEqual([]);
  });

  test("a folder name that is not the record shape never becomes a path", async () => {
    const h = harness({ videos: { [MIA.avatarId]: [video(1, { relPath: "../outside/2026-10-03_photo_001.mp4" })] }, folders: [EXPORT, join(EXPORT, "..", "outside")] });
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: true, result: { opened: "root" } });
    expect(h.opened).toEqual([EXPORT]);
  });

  test("on Windows the folder is joined under the export folder with backslashes", async () => {
    const h = harness({ platform: "win32", exportPath: "D:\\Reels", folders: ["D:\\Reels", "D:\\Reels\\Mia"] });
    await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps);
    expect(h.opened).toEqual(["D:\\Reels\\Mia"]);
  });

  test("a switch of the export folder meanwhile refuses: the answer may name the old folder", async () => {
    const h = harness();
    let calls = 0;
    h.deps.exportPath = () => (++calls === 1 ? EXPORT : join("/Users", "alex", "Elsewhere"));
    expect(await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps)).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL } });
    expect(h.opened).toEqual([]);
  });

  test("the file manager refusing to open is INTERNAL with a fixed detail: no path in the answer", async () => {
    const h = harness({ openError: `Failed to open path ${EXPORT}/Mia` });
    const response = await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "the folder could not be opened" } });
  });

  test("asks the engine only its read-only questions: the export check and the avatar's videos", async () => {
    const h = harness();
    await handleRevealFolderCommand(revealFolder(MIA.avatarId), h.deps);
    expect(h.asked.map((c) => c.type)).toEqual(["export.check", "videos.list"]);
  });
});

describe("placeOf", () => {
  test("joins a record's relative path under an absolute root", () => {
    expect(placeOf("/Users/alex/Reels", "Mia/2026-10-03_photo_001.mp4", "darwin")).toBe("/Users/alex/Reels/Mia/2026-10-03_photo_001.mp4");
    expect(placeOf("D:\\Reels", "Mia/2026-10-03_photo_001.mp4", "win32")).toBe("D:\\Reels\\Mia\\2026-10-03_photo_001.mp4");
  });

  test("refuses a path that is not the record shape: a dot segment, an absolute path, a drive, a stream", () => {
    for (const relPath of ["../x/2026-10-03_photo_001.mp4", "Mia/../../2026-10-03_photo_001.mp4", "/etc/2026-10-03_photo_001.mp4", "C:/Mia/2026-10-03_photo_001.mp4", "Mia/2026-10-03_photo_001.mp4:stream", ""]) {
      expect(placeOf("/Users/alex/Reels", relPath, "darwin")).toBeNull();
    }
  });

  test("refuses a root that is not absolute, whatever the platform reads", () => {
    expect(placeOf("Reels", "Mia/2026-10-03_photo_001.mp4", "darwin")).toBeNull();
    expect(placeOf("", "Mia/2026-10-03_photo_001.mp4", "linux")).toBeNull();
    expect(placeOf("D:Reels", "Mia/2026-10-03_photo_001.mp4", "win32")).toBeNull();
  });
});
