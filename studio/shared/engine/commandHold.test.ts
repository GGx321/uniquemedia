import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, heldWhileAsleep, SLEEP_CLASS, type CommandType } from "./index";

// S4.7 fix round 1 (M1): what main holds back while the Mac sleeps is exactly the commands that start paid work or move a launch.
const HELD: CommandType[] = [
  "autopilot.start",
  "autopilot.resume",
  "autopilot.continueAfterReview",
  "runs.start",
  "runs.startFromScenes",
  "runs.resume",
  "scenes.compose",
  "scenes.write",
  "avatars.createDraft",
  "avatars.generateCandidates",
  "avatars.rewriteDescriptor",
  "avatars.importAvatar",
  "categories.create",
  "categories.regenerate",
  "music.refresh",
];

describe("the sleep classification of the commands", () => {
  test("every command is classified, and nothing else is", () => {
    expect(Object.keys(SLEEP_CLASS).sort()).toEqual([...COMMAND_TYPES].sort());
  });

  test("the paid starts and the launch's moves are held", () => {
    expect(COMMAND_TYPES.filter((type) => heldWhileAsleep(type)).sort()).toEqual([...HELD].sort());
  });

  test("reads, pause, stop, saves and deletes pass", () => {
    for (const type of ["engine.snapshot", "engine.events", "autopilot.get", "autopilot.list", "autopilot.pause", "autopilot.stop", "montages.save", "montages.get", "videos.delete", "money.reconcile", "autopilot.estimate", "scenes.cancel", "runs.cancel"] as const) {
      expect(heldWhileAsleep(type)).toBe(false);
    }
  });
});
