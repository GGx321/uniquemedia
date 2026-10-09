import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ERROR_CODES } from "../shared/engine";
import { draft, LAUNCH } from "../shared/engine/autopilot.fixtures";
import { ledgerLines, command, failed, ok, startEngine, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.1 / S4.6a: until the services that serve them land (S4.6b1 the review hand-off, S4.5c the published mark and the rejecting delete, S4.5d the track flag), the
// engine answers each of these commands with INTERNAL «<type> is not implemented yet», the engine's one wording for a command it has no handler for (its `default` branch).
// A payload that breaks the contract is still VALIDATION, so a forged amount or path never reaches a handler that does not exist yet. Nothing is written, spent or announced.
// The orchestrator core's own commands (estimate, start, pause, resume, stop, list, get, removeUnreadable) are served since S4.6a: engine.autopilotCore.test.ts.

const dir = useEngineDir("studio-engine-autopilot-");

const NEW_COMMANDS: [string, unknown][] = [
  ["autopilot.continueAfterReview", { launchId: LAUNCH, avatarId: "avatar-mia-0001", sceneSetId: "set-mia-00000001", revision: 3 }],
  ["videos.setPublished", { videoId: "video-00000001", published: true }],
  ["media.setForAutopilot", { mediaId: "media-00000001", on: true }],
];

describe("the new commands whose services are not here yet", () => {
  test.each(NEW_COMMANDS)("%s answers INTERNAL «… is not implemented yet», the code the engine uses for a command it cannot serve", async (type, payload) => {
    const { engine } = await startEngine(dir());
    const response = failed(await engine.handle(command(type, payload)));
    expect<string | null>(response.type).toBe(type);
    expect(response.error).toEqual({ code: "INTERNAL", detail: `${type} is not implemented yet` });
    expect(ERROR_CODES).toContain("INTERNAL");
  });

  test("none of them writes a ledger line, a launch file or an event", async () => {
    const { engine, events } = await startEngine(dir());
    const before = events().length;
    for (const [type, payload] of NEW_COMMANDS) await engine.handle(command(type, payload));
    expect(ledgerLines(dir())).toEqual([]);
    expect(events().length).toBe(before);
  });

  test("a start or a resume with a forged amount is VALIDATION: the contract guards the handler", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: 1.5 }))).error.code).toBe("VALIDATION");
    expect(failed(await engine.handle(command("autopilot.start", { draft, acceptedWorstMicros: -1 }))).error.code).toBe("VALIDATION");
    expect(failed(await engine.handle(command("autopilot.resume", { launchId: LAUNCH, acceptedRemainingMicros: 10_000_000_001 }))).error.code).toBe("VALIDATION");
  });

  test("removeUnreadable with a name or a path is VALIDATION, not NOT_FOUND: it never reaches the file system lookup", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("autopilot.removeUnreadable", { entryId: "../../etc/passwd" }))).error.code).toBe("VALIDATION");
    expect(failed(await engine.handle(command("autopilot.removeUnreadable", { entryId: "launch-0a1b2c3d4e5f.json" }))).error.code).toBe("VALIDATION");
  });

  test("the snapshot carries no launch yet", async () => {
    const { engine } = await startEngine(dir());
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot.type === "engine.snapshot" ? (snapshot.result.autopilot ?? null) : "wrong type").toBeNull();
  });
});

describe("videos.delete with rejectPhotos before S4.5c", () => {
  test("is refused up front, so the owner is never told photos were rejected when the engine would only delete the video", async () => {
    const { engine } = await startEngine(dir());
    // Were the flag ignored the answer would be EXPORT_UNAVAILABLE here (no export folder) or NOT_FOUND. The refusal comes before anything is looked at or touched.
    const response = failed(await engine.handle(command("videos.delete", { videoId: "video-00000001", mode: "video", rejectPhotos: true })));
    expect(response.error).toEqual({ code: "INTERNAL", detail: "videos.delete with rejectPhotos is not implemented yet" });
  });

  test("a delete without the flag is the delete it was: an unknown video is NOT_FOUND, and «Удалить» still asks the export folder first", async () => {
    const { engine } = await startEngine(dir());
    expect(failed(await engine.handle(command("videos.delete", { videoId: "video-00000001", mode: "record" }))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(command("videos.delete", { videoId: "video-00000001", mode: "video" }))).error.code).toBe("EXPORT_UNAVAILABLE");
  });
});

describe("host.power", () => {
  let warned: ReturnType<typeof spyOn> | null = null;
  afterEach(() => warned?.mockRestore());

  test.each(["suspend", "resume"])("%s is a control message the engine accepts and, until the orchestrator exists, has nothing to do with", async (state) => {
    warned = spyOn(console, "error").mockImplementation(() => {});
    const { engine } = await startEngine(dir());
    await engine.applyControl({ kind: "control", type: "host.power", state });
    expect(warned).not.toHaveBeenCalled();
  });

  test("a state it does not know is dropped like any invalid control message", async () => {
    warned = spyOn(console, "error").mockImplementation(() => {});
    const { engine } = await startEngine(dir());
    await engine.applyControl({ kind: "control", type: "host.power", state: "hibernate" });
    expect(warned).toHaveBeenCalledTimes(1);
  });
});
