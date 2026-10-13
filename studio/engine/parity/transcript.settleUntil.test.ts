import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EventMessage } from "../../shared/engine";
import { type Answer, Normalizer, Transcript, type Recorded } from "./testing/transcript";
useNativeGlobals();

// The transcript of a settle that lasts until a job's set is ready must not depend on timing: the real engine stores the finished set a moment BEFORE it announces
// `job.done`, so the story is bound to what a rig does, not to when it does it. These stories play a fake rig whose events land at chosen moments.

const progress = EventMessage.parse({
  v: 5,
  id: "evt-00001",
  seq: 1,
  bootId: "boot-0001",
  kind: "event",
  type: "job.progress",
  payload: { kind: "scenes", jobId: "job-aaaaaaaa", sceneSetId: "set-aaaaaaaa", avatarId: "avatar-aaaaaaaa", done: 10, total: 20 },
});
const done = EventMessage.parse({
  v: 5,
  id: "evt-00002",
  seq: 2,
  bootId: "boot-0001",
  kind: "event",
  type: "job.done",
  payload: { jobId: "job-aaaaaaaa", result: { kind: "scenes", sceneSetId: "set-aaaaaaaa", avatarId: "avatar-aaaaaaaa", written: 20, unwritten: 0 } },
});

interface Plan {
  /** Milliseconds from the first settle until the set reads ready (null: never). */
  readonly readyAfterMs: number | null;
  /** Milliseconds from the first settle until the job's `job.done` (null: it never comes). */
  readonly doneAfterMs: number | null;
}

function fakeRig(plan: Plan): Recorded {
  const events: EventMessage[] = [];
  let ready = false;
  let settles = 0;
  return {
    events: () => events,
    async send() {
      return { ok: true, result: { status: ready ? "ready" : "writing" } };
    },
    async advance() {},
    async settle() {
      settles++;
      if (settles > 1) return;
      events.push(progress);
      if (plan.readyAfterMs !== null) setTimeout(() => (ready = true), plan.readyAfterMs);
      if (plan.doneAfterMs !== null) setTimeout(() => events.push(done), plan.doneAfterMs);
    },
  };
}

const isReady = (answer: Answer): boolean => answer.ok && answer.result.status === "ready";

async function story(plan: Plan, ms?: number): Promise<string[]> {
  const t = new Transcript(fakeRig(plan), new Normalizer());
  await t.settleUntil("scenes.get", {}, isReady, "the set to be written", ms);
  return t.lines();
}

describe("settleUntil", () => {
  test("records the job's end when it lands after the set already reads ready", async () => {
    const lines = await story({ readyAfterMs: 0, doneAfterMs: 60 });
    expect(lines.at(-1)).toStartWith("event job.done ");
  });

  test("tells the same story whether the end of the job comes before the set reads ready or after", async () => {
    expect(await story({ readyAfterMs: 0, doneAfterMs: 60 })).toEqual(await story({ readyAfterMs: 60, doneAfterMs: 0 }));
  });

  test("tells the same story however many reads the set needs", async () => {
    expect(await story({ readyAfterMs: 200, doneAfterMs: 20 })).toEqual(await story({ readyAfterMs: 0, doneAfterMs: 20 }));
  });

  test("writes one settle line, then the events in the order they came", async () => {
    const lines = await story({ readyAfterMs: 30, doneAfterMs: 20 });
    expect(lines.map((l) => l.split(" ").slice(0, 2).join(" "))).toEqual(["~ settle", "event job.progress", "event job.done"]);
  });

  test("fails with a clear message when the job never announces its end", async () => {
    await expect(story({ readyAfterMs: 0, doneAfterMs: null }, 100)).rejects.toThrow("timed out waiting for the set to be written");
  });

  test("fails with a clear message when the set never reads ready", async () => {
    await expect(story({ readyAfterMs: null, doneAfterMs: 0 }, 100)).rejects.toThrow("timed out waiting for the set to be written");
  });
});
