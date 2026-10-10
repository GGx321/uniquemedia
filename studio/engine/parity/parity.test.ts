import { afterAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useEngineDir } from "../testing/engineHarness";
import { openLibrary } from "../library";
import { imageSize } from "../library/media";
import { GOLDEN } from "./testing/golden";
import { goldenSource } from "./testing/goldenFile";
import { play } from "./testing/play";
import { servedProblems, unservedAnswers } from "./testing/pending";
import { mockRig, realRig } from "./testing/rigs";
import { SCENARIOS } from "./testing/scenarios";
import { INTENTIONAL_DIFFERENCES, MASKED } from "./testing/transcript";
useNativeGlobals();

// Mock parity (Stage 3, 3d.1b): the same story played against the mock engine and against the real one, and the two
// transcripts (every command, every answer, every event, in order) must be equal line for line. `golden.ts` holds the
// transcript each scenario is bound to, so a change that moves BOTH engines the same way is still seen. What differs on
// purpose is in transcript.ts (`MASKED`, `INTENTIONAL_DIFFERENCES`) and nowhere else.
//
// PARITY_WRITE_GOLDEN=1 rewrites golden.ts from the transcripts (after requiring the two engines to agree): see golden.ts.

const dir = useEngineDir("studio-parity-");
const REAL_TIMEOUT_MS = 60_000;
const WRITE_GOLDEN = process.env.PARITY_WRITE_GOLDEN === "1";
const written: Record<string, string[]> = {};

afterAll(() => {
  if (WRITE_GOLDEN) writeFileSync(new URL("./testing/golden.ts", import.meta.url), goldenSource(written));
});

describe("mock and engine agree", () => {
  for (const scenario of SCENARIOS) {
    test(
      scenario.name,
      async () => {
        const mock = await play(mockRig(scenario.rig), scenario);
        // S4.10 fix D: a RETIRED story is replaced by stories both engines play (`Scenario.retired`); only the mock's transcript stays bound, to the golden below.
        if (scenario.retired !== undefined) {
          if (WRITE_GOLDEN) written[scenario.name] = mock;
          else expect(mock).toEqual(GOLDEN[scenario.name] ?? ["<no golden transcript>"]);
          return;
        }
        const real = await play(await realRig(dir(), scenario.rig), scenario);

        // Stage 4 (S4.1): a story whose commands the real engine does not serve yet is PENDING. It cannot match line for line, so the real engine is held to its one refusal
        // for the commands the story names (testing/pending.ts); the mock's transcript is still bound to the golden below.
        // S4.6a: the commands it already serves (`served`) are held to the opposite, until the mock is complete (S4.8) and the story can match line for line.
        if (scenario.pending === undefined) expect(real).toEqual(mock);
        else {
          const served = scenario.pending.served ?? [];
          expect(unservedAnswers(real, scenario.pending.commands.filter((c) => !served.includes(c)))).toEqual([]);
          expect(servedProblems(real, served)).toEqual([]);
        }
        if (WRITE_GOLDEN) written[scenario.name] = mock;
        else expect(mock).toEqual(GOLDEN[scenario.name] ?? ["<no golden transcript>"]);
      },
      REAL_TIMEOUT_MS,
    );
  }
});

describe("the suite itself", () => {
  test("every scenario has a golden transcript and every golden transcript a scenario", () => {
    if (WRITE_GOLDEN) return;
    expect(Object.keys(GOLDEN).sort()).toEqual(SCENARIOS.map((s) => s.name).sort());
  });

  test("a pending story names its commands and the task that will serve them, and only stories of the engine's unserved commands are pending", () => {
    const pending = SCENARIOS.flatMap((s) => (s.pending === undefined ? [] : [{ name: s.name, ...s.pending }]));
    expect(pending.length).toBeGreaterThan(0);
    for (const story of pending) {
      expect(story.until).toMatch(/^S4\.\d/);
      expect(story.commands.length).toBeGreaterThan(0);
      for (const command of story.commands) expect(command).toMatch(/^(autopilot\.|videos\.(setPublished|delete)$|media\.setForAutopilot$)/);
    }
  });

  test("a retired story says why, names the stories that replace it, and they exist, are played against both engines, and are not retired or pending themselves", () => {
    const retired = SCENARIOS.flatMap((s) => (s.retired === undefined ? [] : [{ name: s.name, pending: s.pending, ...s.retired }]));
    expect(retired.length).toBeGreaterThan(0);
    for (const story of retired) {
      expect(story.pending).toBeUndefined();
      expect(story.why.length).toBeGreaterThan(20);
      expect(story.replacedBy.length).toBeGreaterThan(0);
      for (const name of story.replacedBy) {
        const replacement = SCENARIOS.find((s) => s.name === name);
        expect(replacement).toBeDefined();
        expect(replacement?.retired).toBeUndefined();
        expect(replacement?.pending).toBeUndefined();
      }
    }
  });

  test("the commands a pending story says the engine serves are among the ones it names, and only the orchestrator's commands are served so far (the core, S4.6a, and the review hand-off, S4.6b1)", () => {
    const CORE = ["autopilot.estimate", "autopilot.start", "autopilot.pause", "autopilot.resume", "autopilot.stop", "autopilot.continueAfterReview", "autopilot.list", "autopilot.get", "autopilot.removeUnreadable"];
    for (const scenario of SCENARIOS) {
      const served = scenario.pending?.served ?? [];
      for (const command of served) {
        expect(scenario.pending?.commands).toContain(command);
        expect(CORE).toContain(command);
      }
    }
  });

  // S4.8, Windows CI run 37958851142: a launch's slice run downscales the master through ffmpeg as its face reference (Library.loadReference), and the Windows
  // ffmpeg fails a 1×1 PNG deterministically (studio/node/downscale.ts, PREFLIGHT_IMAGE). Every running story then waited in «drawing» until its deadline. macOS
  // takes the 1×1 picture, so the size is held here, where any platform sees it.
  test("a launching real rig seeds real portraits as masters, never a 1×1 picture the Windows ffmpeg cannot downscale", async () => {
    const rig = await realRig(dir(), { launch: true });
    const { world } = rig;
    await rig.stop();
    const { library } = await openLibrary(join(dir(), "library"));
    for (const avatarId of [world.avatarId, world.otherAvatarId, world.archivedAvatarId]) {
      const master = library.referencePhoto(avatarId);
      expect(master).not.toBeNull();
      const size = master === null ? null : imageSize(new Uint8Array(await readFile(master.path)));
      expect(size).not.toBeNull();
      expect(size?.width).toBeGreaterThanOrEqual(48);
      expect(size?.height).toBeGreaterThanOrEqual(64);
    }
  });

  test("names the differences it allows: each masked field with its reason, and each rule", () => {
    expect(Object.keys(MASKED).sort()).toEqual(["bytes", "createdAt", "seed", "updatedAt"]);
    expect(Object.values(MASKED).every((reason) => reason.length > 20)).toBe(true);
    expect(INTENTIONAL_DIFFERENCES.length).toBeGreaterThanOrEqual(5);
  });
});
