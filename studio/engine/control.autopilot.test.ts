import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS, HostControl } from "./control";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.1: what main and the engine say to each other apart from the renderer's contract.

describe("host.power (plan §9: main tells the engine the Mac is going to sleep or has woken)", () => {
  test.each(["suspend", "resume"])("%s is a control message", (state) => {
    expect(HostControl.safeParse({ kind: "control", type: "host.power", state }).success).toBe(true);
  });

  test.each([
    ["a state it does not know", { state: "hibernate" }],
    ["no state", {}],
    ["a state that is not a string", { state: 1 }],
    ["an extra key", { state: "suspend", at: "2026-10-08T14:02:00.000Z" }],
  ])("refuses %s", (_name, patch) => {
    expect(HostControl.safeParse({ kind: "control", type: "host.power", state: "suspend" }).success).toBe(true);
    expect(HostControl.safeParse({ kind: "control", type: "host.power", ...patch }).success).toBe(false);
  });

  test("is a control message and not a command of the renderer's contract: no window can send it", async () => {
    const { COMMAND_TYPES } = await import("../shared/engine");
    expect(COMMAND_TYPES as readonly string[]).not.toContain("host.power");
  });
});

describe("how long main waits for the autopilot's commands", () => {
  const price = PRICE_FETCH_TIMEOUT_MS + 15_000;

  test.each(["autopilot.estimate", "autopilot.start", "autopilot.resume"] as const)("%s waits for a price load that times out, so a fallback estimate or a started launch is not given up on", (type) => {
    expect(COMMAND_DEADLINE_MS[type]).toBe(price);
  });

  test.each(["autopilot.pause", "autopilot.stop", "autopilot.list", "autopilot.get", "autopilot.continueAfterReview", "autopilot.removeUnreadable", "videos.setPublished", "media.setForAutopilot"] as const)(
    "%s is local and keeps the default",
    (type) => {
      expect(COMMAND_DEADLINE_MS[type]).toBeUndefined();
    },
  );
});
