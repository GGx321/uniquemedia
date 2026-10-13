import { describe, expect, test } from "bun:test";
import { EventMessage, PROTOCOL_VERSION, type ClipPhase } from "../shared/engine";
import { CLIP_QUIT_DETAIL, CLIP_QUIT_MESSAGE } from "../shared/engine/clipRestartTexts";
import { QUIT_LEAVE_LABEL, QUIT_STAY_LABEL, type QuitDialogSpec } from "./autopilotHost";
import { ClipHost, confirmInOrder } from "./clipHost";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, state 45, §8 V6): main's side of a clip in flight. Fakes only, nothing here touches Electron. The host follows the engine's `job.*` events of kind `clip`: it
// asks before a quit from `submitting` to `proving` (the Grok attempt's `submitting` and `rendering` included) and holds a power blocker over the same span, because the `held` sleep class does not
// keep the Mac awake. It says nothing in `preparing` (the first frame, free and quick), after the POST's render (the download is free), in a recovery, in an export, or for any job that is not a clip.

const AVATAR = "avatar-0001-aaaa";
let seq = 0;
const id = (): string => `evt-${String(++seq).padStart(8, "0")}`;

const progress = (jobId: string, phase: ClipPhase, kind: "clip" | "avatar.candidates" = "clip"): EventMessage =>
  EventMessage.parse({
    v: PROTOCOL_VERSION,
    id: id(),
    kind: "event",
    seq: seq + 1,
    bootId: "boot-00000001",
    type: "job.progress",
    payload: kind === "clip" ? { kind, jobId, avatarId: AVATAR, clipId: jobId, done: 0, total: 4, phase } : { kind, jobId, avatarId: AVATAR, done: 1, total: 4 },
  });
const done = (jobId: string): EventMessage =>
  EventMessage.parse({ v: PROTOCOL_VERSION, id: id(), kind: "event", seq: seq + 1, bootId: "boot-00000001", type: "job.done", payload: { jobId, result: { kind: "clip", avatarId: AVATAR, clipId: jobId } } });
const failed = (jobId: string): EventMessage =>
  EventMessage.parse({
    v: PROTOCOL_VERSION,
    id: id(),
    kind: "event",
    seq: seq + 1,
    bootId: "boot-00000001",
    type: "job.failed",
    payload: { kind: "clip", jobId, avatarId: AVATAR, clipId: jobId, error: { code: "INTERNAL", detail: "x" } },
  });
const cancelled = (jobId: string): EventMessage =>
  EventMessage.parse({ v: PROTOCOL_VERSION, id: id(), kind: "event", seq: seq + 1, bootId: "boot-00000001", type: "job.cancelled", payload: { kind: "clip", jobId, avatarId: AVATAR, clipId: jobId } });

const A = "clip-00000001";
const B = "clip-00000002";

function rig(pressed = 1) {
  const blocker = { starts: 0, stops: [] as number[], live: new Set<number>() };
  const asked: QuitDialogSpec[] = [];
  const logs: string[] = [];
  const host = new ClipHost({
    blocker: {
      start: () => {
        blocker.starts += 1;
        blocker.live.add(blocker.starts);
        return blocker.starts;
      },
      stop: (blockerId) => {
        blocker.stops.push(blockerId);
        blocker.live.delete(blockerId);
      },
    },
    dialog: {
      ask: async (spec) => {
        asked.push(spec);
        return pressed;
      },
    },
    log: (line) => void logs.push(line),
  });
  return { host, blocker, asked, logs };
}

const IN_FLIGHT: ClipPhase[] = ["submitting", "rendering", "proving"];
const NOT_IN_FLIGHT: ClipPhase[] = ["preparing", "downloading", "checking", "saving", "late", "recovering", "exporting"];

describe("the quit question", () => {
  test("is not asked when no clip is known", async () => {
    const { host, asked } = rig();
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
  });

  test.each(IN_FLIGHT)("is asked while a clip is in `%s`", async (phase) => {
    const { host, asked } = rig();
    host.observe(progress(A, phase));
    await host.confirmQuit();
    expect(asked).toHaveLength(1);
  });

  test.each(NOT_IN_FLIGHT)("is not asked while a clip is in `%s`", async (phase) => {
    const { host, asked } = rig();
    host.observe(progress(A, phase));
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
  });

  test("says what state 45 says, with «Остаться» first and the default, and Escape staying", async () => {
    const { host, asked } = rig();
    host.observe(progress(A, "rendering"));
    await host.confirmQuit();
    expect(asked[0]).toEqual({ message: CLIP_QUIT_MESSAGE, detail: CLIP_QUIT_DETAIL, buttons: [QUIT_STAY_LABEL, QUIT_LEAVE_LABEL], defaultId: 0, cancelId: 0 });
  });

  test("keeps the app on «Остаться» and quits on «Выйти»", async () => {
    const stay = rig(0);
    stay.host.observe(progress(A, "rendering"));
    expect(await stay.host.confirmQuit()).toBe(false);
    const leave = rig(1);
    leave.host.observe(progress(A, "rendering"));
    expect(await leave.host.confirmQuit()).toBe(true);
  });

  test("changes nothing when the owner stays: the clip is still tracked and the blocker still held", async () => {
    const { host, blocker, asked } = rig(0);
    host.observe(progress(A, "rendering"));
    await host.confirmQuit();
    expect(blocker.live.size).toBe(1);
    await host.confirmQuit();
    expect(asked).toHaveLength(2);
  });

  test.each([
    ["done", done],
    ["failed", failed],
    ["cancelled", cancelled],
  ] as const)("is not asked once the clip's job is %s", async (_name, end) => {
    const { host, asked } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(end(A));
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
  });

  test("is not asked once the clip has moved on to the download", async () => {
    const { host, asked } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(progress(A, "downloading"));
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
  });

  test("is asked once for two clips, and still asked while the second is in flight after the first ended", async () => {
    const { host, asked } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(progress(B, "submitting"));
    await host.confirmQuit();
    expect(asked).toHaveLength(1);
    host.observe(done(A));
    await host.confirmQuit();
    expect(asked).toHaveLength(2);
  });

  test("is not asked for a job that is not a clip", async () => {
    const { host, asked } = rig();
    host.observe(progress("job-00000001", "rendering", "avatar.candidates"));
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
  });

  test("forgets every clip when the engine is gone", async () => {
    const { host, asked } = rig();
    host.observe(progress(A, "rendering"));
    host.engineGone();
    expect(await host.confirmQuit()).toBe(true);
    expect(asked).toEqual([]);
  });

  test("learns the new engine's clips after it was gone", async () => {
    const { host, asked } = rig();
    host.observe(progress(A, "rendering"));
    host.engineGone();
    host.observe(progress(B, "rendering"));
    await host.confirmQuit();
    expect(asked).toHaveLength(1);
  });
});

describe("the power blocker", () => {
  test("starts at `submitting`", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "submitting"));
    expect(blocker.starts).toBe(1);
    expect(host.blockerHeld).toBe(true);
  });

  test("is not started in `preparing`", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "preparing"));
    expect(blocker.starts).toBe(0);
    expect(host.blockerHeld).toBe(false);
  });

  test("is held once through submitting, rendering and proving", () => {
    const { host, blocker } = rig();
    for (const phase of IN_FLIGHT) host.observe(progress(A, phase));
    expect(blocker.starts).toBe(1);
    expect(blocker.stops).toEqual([]);
  });

  test("stops at the first later phase, the download", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(progress(A, "downloading"));
    expect(blocker.stops).toEqual([1]);
    expect(host.blockerHeld).toBe(false);
  });

  test.each([
    ["done", done],
    ["failed", failed],
    ["cancelled", cancelled],
  ] as const)("stops when the job is %s", (_name, end) => {
    const { host, blocker } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(end(A));
    expect(blocker.stops).toEqual([1]);
  });

  test("stops when the engine is gone", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "rendering"));
    host.engineGone();
    expect(blocker.stops).toEqual([1]);
  });

  test("is taken again for the next clip", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(done(A));
    host.observe(progress(B, "submitting"));
    expect(blocker.starts).toBe(2);
    expect(blocker.live.size).toBe(1);
  });

  test("stays held while a second clip is still in flight", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "rendering"));
    host.observe(progress(B, "rendering"));
    host.observe(done(A));
    expect(blocker.stops).toEqual([]);
    host.observe(done(B));
    expect(blocker.stops).toEqual([1]);
  });

  test("is not held for a recovery, an export, or a job that is not a clip", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "recovering"));
    host.observe(progress(B, "exporting"));
    host.observe(progress("job-00000001", "rendering", "avatar.candidates"));
    expect(blocker.starts).toBe(0);
  });

  test("goes at dispose and is not taken again", () => {
    const { host, blocker } = rig();
    host.observe(progress(A, "rendering"));
    host.dispose();
    expect(blocker.stops).toEqual([1]);
    host.observe(progress(B, "rendering"));
    expect(blocker.starts).toBe(1);
  });

  test("a blocker that throws costs the blocker and nothing else", async () => {
    const logs: string[] = [];
    const host = new ClipHost({
      blocker: {
        start: () => {
          throw new Error("no power API");
        },
        stop: () => undefined,
      },
      dialog: { ask: async () => 1 },
      log: (line) => void logs.push(line),
    });
    host.observe(progress(A, "rendering"));
    expect(logs).toHaveLength(1);
    expect(host.blockerHeld).toBe(false);
  });
});

describe("the order of the quit questions", () => {
  test("asks the first, and the second only when the first says go on", async () => {
    const calls: string[] = [];
    const ask = (name: string, answer: boolean) => async () => {
      calls.push(name);
      return answer;
    };
    expect(await confirmInOrder([ask("autopilot", true), ask("clip", true)])).toBe(true);
    expect(calls).toEqual(["autopilot", "clip"]);
  });

  test("does not ask the clip's question when the owner stayed at the autopilot's", async () => {
    const calls: string[] = [];
    const ask = (name: string, answer: boolean) => async () => {
      calls.push(name);
      return answer;
    };
    expect(await confirmInOrder([ask("autopilot", false), ask("clip", true)])).toBe(false);
    expect(calls).toEqual(["autopilot"]);
  });

  test("quits when there is nothing to ask", async () => {
    expect(await confirmInOrder([])).toBe(true);
  });
});
