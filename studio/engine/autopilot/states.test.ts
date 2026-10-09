import { describe, expect, test } from "bun:test";
import { LAUNCH_STATUSES, type LaunchStatus } from "../../shared/engine/autopilot";
import { LAUNCH_EVENTS, persistedStatus, transition, type LaunchEvent } from "./states";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6a (plan §3.5, §3.7, §18): every (status, event) pair of the launch's state machine, legal and illegal. A legal one names the status it leads to; every other
// pair is refused as a wrong state. The table is written out in full so that a new status or event cannot be left without an answer.

type Row = [LaunchStatus, LaunchEvent, LaunchStatus | null];

const TABLE: Row[] = [
  // running
  ["running", "pause", "pausing"],
  ["running", "drained", null],
  ["running", "resume", null],
  ["running", "stop", "stopping"],
  ["running", "stopped", null],
  ["running", "finish", "done"],
  ["running", "restart", "paused"],
  // pausing: «Ставим на паузу…»
  ["pausing", "pause", null],
  ["pausing", "drained", "paused"],
  ["pausing", "resume", null],
  ["pausing", "stop", "stopping"],
  ["pausing", "stopped", null],
  ["pausing", "finish", "done"],
  ["pausing", "restart", "paused"],
  // paused
  ["paused", "pause", null],
  ["paused", "drained", null],
  ["paused", "resume", "running"],
  ["paused", "stop", "stopping"],
  ["paused", "stopped", null],
  ["paused", "finish", null],
  ["paused", "restart", "paused"],
  // stopping: «Останавливаем…» — persisted, so a restart finishes the stop and never reads as a pause
  ["stopping", "pause", null],
  ["stopping", "drained", null],
  ["stopping", "resume", null],
  ["stopping", "stop", null],
  ["stopping", "stopped", "stopped"],
  ["stopping", "finish", null],
  ["stopping", "restart", "stopping"],
  // done and stopped are over; only a restart reads them, and changes nothing
  ["done", "pause", null],
  ["done", "drained", null],
  ["done", "resume", null],
  ["done", "stop", null],
  ["done", "stopped", null],
  ["done", "finish", null],
  ["done", "restart", "done"],
  ["stopped", "pause", null],
  ["stopped", "drained", null],
  ["stopped", "resume", null],
  ["stopped", "stop", null],
  ["stopped", "stopped", null],
  ["stopped", "finish", null],
  ["stopped", "restart", "stopped"],
];

describe("the launch state machine", () => {
  test("the table names every status with every event exactly once", () => {
    expect(TABLE).toHaveLength(LAUNCH_STATUSES.length * LAUNCH_EVENTS.length);
    const seen = new Set(TABLE.map(([status, event]) => `${status}/${event}`));
    expect(seen.size).toBe(TABLE.length);
    for (const status of LAUNCH_STATUSES) for (const event of LAUNCH_EVENTS) expect(seen.has(`${status}/${event}`)).toBe(true);
  });

  test.each(TABLE.filter((row): row is [LaunchStatus, LaunchEvent, LaunchStatus] => row[2] !== null))("%s on %s leads to %s", (status, event, to) => {
    expect(transition(status, event)).toEqual({ ok: true, to });
  });

  test.each(TABLE.filter((row) => row[2] === null))("%s on %s is a wrong state", (status, event) => {
    expect(transition(status, event)).toEqual({ ok: false, reason: "wrong-state" });
  });

  test("a restart never lets a launch run: it reads as paused, or stays stopping, done or stopped", () => {
    for (const status of LAUNCH_STATUSES) {
      const result = transition(status, "restart");
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.to).not.toBe("running");
    }
  });

  test("only done and stopped are ended: nothing but a restart touches them", () => {
    for (const status of ["done", "stopped"] as const) {
      for (const event of LAUNCH_EVENTS) {
        if (event !== "restart") expect(transition(status, event).ok).toBe(false);
      }
    }
  });
});

describe("persistedStatus", () => {
  test("pausing is written as running: a quit during «Ставим на паузу…» reads as a restart pause", () => {
    expect(persistedStatus("pausing")).toBe("running");
  });

  test.each(["running", "paused", "stopping", "done", "stopped"] as const)("%s is written as itself", (status) => {
    expect(persistedStatus(status)).toBe(status);
  });
});
