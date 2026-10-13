import { describe, expect, test } from "bun:test";
import { join, win32 } from "node:path";
import { ClipSummary, CommandMessage, EXPORT_CHANGING_DETAIL, PROTOCOL_VERSION, type ClipExport, type EngineCommandMessage, type ResponseMessage } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { handleClipRevealCommand, isClipRevealCommand, type ClipRevealCommand, type RevealFlowDeps } from "./revealFlow";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.2, §5.13): «Показать в Finder» on a clip, `clips.reveal {avatarId, clipId}`, is main's alone. The window names ids and nothing else; main asks
// the engine `clips.get` (each export carries the `fileState` the engine computed against the current export folder), takes the NEWEST export whose file is present, joins its
// relative path to the export folder as main saved it (the place cannot leave it) and asks the system file manager to show it. No present copy: VALIDATION `not-exported`.

const EXPORT = join("/Users", "alex", "Reels");
const AVATAR = "avatar-00000001";
const CLIP = "clip-00000001";

function line(n: number, fileState: ClipExport["fileState"]): ClipExport {
  return {
    rootId: "root-00000001",
    relPath: `Nini/2026-10-14_clip_${String(n).padStart(3, "0")}.mp4`,
    profile: "1080p30-interp",
    at: "2026-10-14T09:30:15.000Z",
    bytes: 9_000_000,
    sha256: "e".repeat(64),
    ...(fileState === undefined ? {} : { fileState }),
  };
}

function clip(exports: ClipExport[]): ClipSummary {
  return ClipSummary.parse({
    clipId: CLIP,
    avatarId: AVATAR,
    photoId: "photo-00000001",
    createdAt: "2026-10-14T09:00:00.000Z",
    seen: true,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    model: "kling-std",
    fallback: false,
    recovered: false,
    cost: { micros: 420_000, kind: "billed" },
    exports,
    status: "ready",
    width: 720,
    height: 1280,
    durationMs: 5_040,
    face: { verdict: "match", p75: 0.7, frames: 10 },
  });
}

interface Harness {
  deps: RevealFlowDeps;
  shown: string[];
  asked: EngineCommandMessage[];
}

function harness(options: { exports?: ClipExport[]; answer?: (command: EngineCommandMessage) => ResponseMessage; exportPath?: () => string; platform?: NodeJS.Platform } = {}): Harness {
  const shown: string[] = [];
  const asked: EngineCommandMessage[] = [];
  let n = 0;
  const deps: RevealFlowDeps = {
    engine: {
      request: async (command) => {
        asked.push(command);
        if (options.answer !== undefined) return options.answer(command);
        if (command.type !== "clips.get") throw new Error(`unexpected ${command.type}`);
        return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { clip: clip(options.exports ?? [line(1, "present")]) } };
      },
    },
    exportPath: options.exportPath ?? (() => EXPORT),
    show: (path) => void shown.push(path),
    newId: () => `id-${++n}`,
    platform: options.platform ?? process.platform,
  };
  return { deps, shown, asked };
}

const reveal = (payload: object = { avatarId: AVATAR, clipId: CLIP }): ClipRevealCommand => {
  const parsed = CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type: "clips.reveal", payload });
  if (parsed.type !== "clips.reveal") throw new Error("not a clips.reveal");
  return parsed;
};

describe("clips.reveal (main only)", () => {
  test("isClipRevealCommand knows the command, and only it", () => {
    expect(isClipRevealCommand(CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type: "clips.reveal", payload: { avatarId: AVATAR, clipId: CLIP } }))).toBe(true);
    expect(isClipRevealCommand(CommandMessage.parse({ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type: "videos.reveal", payload: { videoId: "video-00000001" } }))).toBe(false);
  });

  test("asks the engine clips.get with the window's ids and nothing else", async () => {
    const h = harness();
    await handleClipRevealCommand(reveal(), h.deps);
    const asked: unknown[] = h.asked.map((c) => [c.type, c.payload]);
    expect(asked).toEqual([["clips.get", { avatarId: AVATAR, clipId: CLIP }]]);
  });

  test("shows the newest present copy in the export folder and answers the clip's id", async () => {
    const h = harness({ exports: [line(1, "present"), line(2, "present")] });

    const response = await handleClipRevealCommand(reveal(), h.deps);

    expect(response).toMatchObject({ ok: true, type: "clips.reveal", result: { clipId: CLIP } });
    expect(h.shown).toEqual([join(EXPORT, "Nini", "2026-10-14_clip_002.mp4")]);
  });

  test("a newer copy that is missing, changed, elsewhere or unchecked is passed over for an older present one", async () => {
    const h = harness({ exports: [line(1, "present"), line(2, "missing"), line(3, "changed"), line(4, "elsewhere"), line(5, "unchecked")] });

    await handleClipRevealCommand(reveal(), h.deps);

    expect(h.shown).toEqual([join(EXPORT, "Nini", "2026-10-14_clip_001.mp4")]);
  });

  test("no present copy is VALIDATION not-exported, and nothing is shown", async () => {
    const h = harness({ exports: [line(1, "missing"), line(2, "changed")] });

    const response = await handleClipRevealCommand(reveal(), h.deps);

    expect(response).toMatchObject({ ok: false, type: "clips.reveal", error: { code: "VALIDATION", clipReason: "not-exported" } });
    expect(h.shown).toEqual([]);
  });

  test("a clip never exported is not-exported too", async () => {
    const h = harness({ exports: [] });
    expect(await handleClipRevealCommand(reveal(), h.deps)).toMatchObject({ ok: false, error: { code: "VALIDATION", clipReason: "not-exported" } });
  });

  test("the engine's refusal (an unknown clip) is passed on, and nothing is shown", async () => {
    const h = harness({ answer: (command) => ({ v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: false, error: { code: "NOT_FOUND", detail: "no clip" } }) });

    const response = await handleClipRevealCommand(reveal(), h.deps);

    expect(response).toMatchObject({ ok: false, type: "clips.reveal", error: { code: "NOT_FOUND" } });
    expect(h.shown).toEqual([]);
  });

  test("an export folder switched while the clip was read is IN_FLIGHT, as videos.reveal answers it, and nothing is shown", async () => {
    let calls = 0;
    const h = harness({ exportPath: () => (++calls === 1 ? EXPORT : join("/Volumes", "Other")) });

    const response = await handleClipRevealCommand(reveal(), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL } });
    expect(h.shown).toEqual([]);
  });

  test("a place that would leave the export folder is never shown", async () => {
    const escaping = { ...line(1, "present"), relPath: "../../etc/passwd" };
    const h = harness({
      answer: (command) => ({ v: PROTOCOL_VERSION, id: command.id, kind: "response", type: "clips.get", ok: true, result: { clip: { ...clip([]), exports: [escaping] } } }),
    });

    const response = await handleClipRevealCommand(reveal(), h.deps);

    expect(response).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(h.shown).toEqual([]);
  });

  test("an export folder that is not absolute is never joined to", async () => {
    const h = harness({ exportPath: () => join("relative", "Reels") });
    expect((await handleClipRevealCommand(reveal(), h.deps)).ok).toBe(false);
    expect(h.shown).toEqual([]);
  });

  test("on Windows the place is joined with Windows' separators", async () => {
    const root = win32.join("C:\\", "Users", "alex", "Reels");
    const h = harness({ exportPath: () => root, platform: "win32" });

    await handleClipRevealCommand(reveal(), h.deps);

    expect(h.shown).toEqual([win32.join(root, "Nini", "2026-10-14_clip_001.mp4")]);
  });

  test("an answer of another type is INTERNAL, and nothing is shown", async () => {
    const h = harness({ answer: (command) => ({ v: PROTOCOL_VERSION, id: command.id, kind: "response", type: "clips.list", ok: true, result: { clips: [] } }) });
    expect(await handleClipRevealCommand(reveal(), h.deps)).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    expect(h.shown).toEqual([]);
  });
});
