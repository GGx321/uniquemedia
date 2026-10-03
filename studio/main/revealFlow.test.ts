import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CommandMessage, EXPORT_CHANGING_DETAIL, PROTOCOL_VERSION, type EngineCommandMessage, type FileState, type ResponseMessage, type VideoSummary } from "../shared/engine";
import { MIA, SOFIA } from "../renderer/engine/mockEngine.testkit";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { handleRevealCommand, isRevealCommand, placeOf, type RevealCommand, type RevealFlowDeps } from "./revealFlow";
useNativeGlobals();

// 3d.6: «Открыть в папке». The window names a video id and nothing else; main finds the file's place itself and asks the
// system file manager to show it. The export folder and the record's relative path never come from the window.

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
    ...patch,
  };
}

interface Harness {
  deps: RevealFlowDeps;
  shown: string[];
  asked: EngineCommandMessage[];
}

function harness(options: { videos?: Record<string, VideoSummary[]>; failList?: string; failAvatars?: boolean; platform?: NodeJS.Platform; exportPath?: string } = {}): Harness {
  const shown: string[] = [];
  const asked: EngineCommandMessage[] = [];
  let n = 0;
  const videos = options.videos ?? { [MIA.avatarId]: [video(1), video(2)], [SOFIA.avatarId]: [video(3, {}, SOFIA.avatarId)] };
  const deps: RevealFlowDeps = {
    engine: {
      request: async (command): Promise<ResponseMessage> => {
        asked.push(command);
        const base = { v: PROTOCOL_VERSION, id: command.id, kind: "response" } as const;
        if (command.type === "avatars.list") {
          if (options.failAvatars) return { ...base, type: command.type, ok: false, error: { code: "LIBRARY_UNAVAILABLE" } };
          return { ...base, type: command.type, ok: true, result: { avatars: [MIA, SOFIA], unreadableAvatars: [], unreadableTotal: 0 } };
        }
        if (command.type === "videos.list") {
          if (command.payload.avatarId === options.failList) return { ...base, type: command.type, ok: false, error: { code: "NOT_FOUND" } };
          return { ...base, type: command.type, ok: true, result: { videos: videos[command.payload.avatarId] ?? [] } };
        }
        return { ...base, type: command.type, ok: false, error: { code: "INTERNAL", detail: "unexpected" } };
      },
    },
    exportPath: () => options.exportPath ?? EXPORT,
    show: (path) => void shown.push(path),
    newId: () => `internal-${String(++n).padStart(4, "0")}`,
    platform: options.platform ?? process.platform,
  };
  return { deps, shown, asked };
}

function reveal(videoId: string): RevealCommand {
  const parsed = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-rev-00001", kind: "command", type: "videos.reveal", payload: { videoId } });
  if (!isRevealCommand(parsed)) throw new Error("not a reveal command");
  return parsed;
}

describe("videos.reveal", () => {
  test("shows the file of a present video, found by its id among every avatar's videos", async () => {
    const h = harness();
    const response = await handleRevealCommand(reveal("video-00000003"), h.deps);
    expect(response).toMatchObject({ ok: true, type: "videos.reveal", result: { videoId: "video-00000003" } });
    expect(h.shown).toEqual([join(EXPORT, "Mia", "2026-10-03_photo_003.mp4")]);
  });

  test("asks the engine only with its own read-only commands", async () => {
    const h = harness();
    await handleRevealCommand(reveal("video-00000001"), h.deps);
    expect(h.asked.map((c) => c.type).every((t) => t === "avatars.list" || t === "videos.list")).toBe(true);
  });

  test("an unknown video is NOT_FOUND and nothing is shown", async () => {
    const h = harness();
    const response = await handleRevealCommand(reveal("video-00000099"), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.shown).toEqual([]);
  });

  test.each<FileState>(["missing", "changed", "elsewhere"])("a video whose file is %s is not shown: only a present file is", async (fileState) => {
    const h = harness({ videos: { [MIA.avatarId]: [video(1, { fileState })] } });
    const response = await handleRevealCommand(reveal("video-00000001"), h.deps);
    expect(response).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(h.shown).toEqual([]);
  });

  test("an engine error is the answer, as it is", async () => {
    const h = harness({ failAvatars: true });
    expect(await handleRevealCommand(reveal("video-00000001"), h.deps)).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
    expect(h.shown).toEqual([]);
  });

  test("an avatar whose list fails is skipped when the video is found elsewhere, and is the answer when it is not", async () => {
    const found = harness({ failList: MIA.avatarId });
    expect(await handleRevealCommand(reveal("video-00000003"), found.deps)).toMatchObject({ ok: true });
    const lost = harness({ failList: SOFIA.avatarId });
    expect(await handleRevealCommand(reveal("video-00000003"), lost.deps)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(lost.shown).toEqual([]);
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

  test("a switch of the export folder while the records were read refuses the reveal: the answer may name the old folder", async () => {
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
