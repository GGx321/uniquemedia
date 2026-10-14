import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { contractCategory, buildRunPlan, RunPlanSchema, type RunPlan } from "../runs/plan";
import { plan } from "../scenes";
import type { OwnPlanSlot, PlanSlot } from "../scenes/schema";
import { openLibrary, type Library } from "../library/library";
import type { PhotoSidecar } from "../library/schemas";
import { PLAN_FILE, RUNS_DIR } from "../library/layout";
import { useTempDir } from "../library/testing/helpers";
import { momentOfSlot } from "../../shared/scenes/template";
import { boldContentLevel } from "../../shared/scenes/contentLine";
import { captureOfShot } from "../../shared/scenes/captures";
import { GROK_FALLBACK, isBoldCategory, type AvatarDescriptor } from "../../shared/engine";
import { assembleSlot } from "../scenes/assembler";
import { captureLineOf, slotKeyOf } from "../scenes/phoneLook";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { clipFallbackOf, frameFactsOf, frameRefusalOf, readFrameFacts, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { SHIPPED_POV_CAPTURE_LINES } from "./videoLook";
import { AVATAR, MODELS, everyMoment, photoCaptureLineOf, photoOf, pick, planlessPhoto, sceneRun, sentenceOf, slotOf } from "./testing/frameFixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.4, I5.52, I5.57): what a clip knows of its photo, from the sidecar, the run's plan.json and the banks, never from pixels. The chain is the
// one the template and the restored marks already walk: the attempt id's run, the sidecar's slot in that run's plan, the bank moment by (category, place, activity). An unreadable
// plan is no plan, never an error.

const root = useTempDir("studio-clip-facts-");

async function library(): Promise<Library> {
  return (await openLibrary(root())).library;
}

const readerOf =
  (lib: Library) =>
  (runId: string): Promise<RunPlan> =>
    lib.readRun(runId, RunPlanSchema);

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

const silent = (): void => undefined;

/** A real planner's run of the five at «Кокетливая» with legs frames, as main writes it. */
function ordinaryRun(runId: string): RunPlan {
  const categories = ["home", "travel", "photoshoot", "glamour", "fitness"] as const;
  return buildRunPlan({
    runId,
    avatarId: AVATAR,
    createdAt: "2026-10-13T10:00:00.000Z",
    request: { avatarId: AVATAR, count: 40, categories: categories.map((c) => contractCategory(c)), level: "flirty", legsShare: 30 },
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 5_000_000,
    plannedWorstMicros: 5_000_000,
    scenes: plan({ seed: 5, count: 40, categories, level: "flirty", legsShare: 30 }),
  });
}

/** A real planner's «Смелая» run of the two bold banks. */
function boldRun(runId: string): RunPlan {
  const categories = ["nightwear", "beach"] as const;
  return buildRunPlan({
    runId,
    avatarId: AVATAR,
    createdAt: "2026-10-13T10:00:00.000Z",
    request: { avatarId: AVATAR, count: 30, categories: categories.map((c) => contractCategory(c)), level: "bold", legsShare: 15 },
    imageAgeCheck: "off",
    models: MODELS,
    capMicros: 5_000_000,
    plannedWorstMicros: 5_000_000,
    scenes: plan({ seed: 9, count: 30, categories, level: "bold", legsShare: 15 }),
  });
}

const planned = (run: RunPlan): PlanSlot[] => run.scenes.slots.filter((s): s is PlanSlot => s.category !== "own");

describe("the chain: photo → run → slot → moment (§5.4)", () => {
  test("an ordinary run: every photo finds its own slot and its bank moment", async () => {
    const lib = await library();
    const run = ordinaryRun("run-00000001");
    await lib.createRun(run.runId, run, RunPlanSchema);
    for (const slot of planned(run)) {
      const facts = factsOf(await readFrameFacts(photoOf(run, slot), readerOf(lib), silent));
      expect(facts.plan).toBe("slot");
      expect(facts.category).toBe(slot.category);
      expect(facts.moment).toBe(momentOfSlot(slot) ?? null);
      expect(facts.moment).not.toBeNull();
      expect(facts.capture).toBe(slot.capture ?? captureOfShot(slot.shot));
      expect(facts.pose).toBe(slot.pose);
      expect(facts.legs).toBe(slot.framing === "legs");
      expect(facts.sceneMotion).toBe(true);
      expect(facts.activity).toBe(slot.activity);
    }
  });

  test("a scene-set run: a planned scene finds its slot; an own scene reads its shot and pose and has no moment and no activity", async () => {
    const lib = await library();
    const drawn = planned(ordinaryRun("run-00000002")).slice(0, 4);
    const run = sceneRun("run-00000003", [...drawn, { kind: "own", shot: "friend", pose: "three-quarter", text: "She laughs on a sunny terrace with a friend's dog at her feet." }]);
    await lib.createRun(run.runId, run, RunPlanSchema);
    const slots = run.scenes.slots;
    for (const slot of slots.slice(0, 4)) {
      const facts = factsOf(await readFrameFacts(photoOf(run, slot), readerOf(lib), silent));
      expect(facts.plan).toBe("slot");
      if (slot.category === "own") throw new Error("a planned scene became an own scene");
      expect(facts.moment).toBe(momentOfSlot(slot) ?? null);
      expect(facts.sceneMotion).toBe(true);
    }
    const own = slots[4] as OwnPlanSlot;
    const facts = factsOf(await readFrameFacts(photoOf(run, own), readerOf(lib), silent));
    expect(facts).toMatchObject({ plan: "own", category: "own", moment: null, sceneMotion: false, activity: null, capture: "friend", pose: "three-quarter", face: "yes", faceRole: "judged", legs: false, legwear: null, bold: false });
  });

  test("an autopilot launch slice: the slice renumbers its scenes, and a photo finds the slice's own slot, never the set's", async () => {
    const lib = await library();
    const set = planned(ordinaryRun("run-00000004")).slice(0, 8);
    // A slice draws scenes 3, 5 and 6 of the set: the run numbers them slot-1..slot-3.
    const slice = sceneRun("run-00000005", [set[2], set[4], set[5]] as PlanSlot[]);
    await lib.createRun(slice.runId, slice, RunPlanSchema);
    const slots = slice.scenes.slots as PlanSlot[];
    expect(slots.map((s) => s.attemptIdBase)).toEqual(["slot-1", "slot-2", "slot-3"]);
    for (const [i, slot] of slots.entries()) {
      const facts = factsOf(await readFrameFacts(photoOf(slice, slot), readerOf(lib), silent));
      expect(facts.activity).toBe(([set[2], set[4], set[5]] as PlanSlot[])[i]?.activity ?? "");
      expect(facts.moment).toBe(momentOfSlot(slot) ?? null);
    }
  });

  test("a «Смелая» run: the slot's legwear and level come with the facts; a noLegwear moment never carries legwear", async () => {
    const lib = await library();
    const run = boldRun("run-00000006");
    await lib.createRun(run.runId, run, RunPlanSchema);
    for (const slot of planned(run)) {
      const facts = factsOf(await readFrameFacts(photoOf(run, slot), readerOf(lib), silent));
      expect(facts.bold).toBe(true);
      expect(facts.level).toBe(boldContentLevel());
      expect(facts.legwear).toBe(momentOfSlot(slot)?.noLegwear === true ? null : (slot.legwear ?? null));
    }
  });
});

describe("a plan that cannot be read is no plan (§5.4 step 5)", () => {
  async function noPlanFacts(write: (dir: string) => Promise<void>): Promise<{ facts: FrameFacts; logged: string[] }> {
    const lib = await library();
    const run = ordinaryRun("run-00000007");
    const slot = planned(run)[0];
    if (slot === undefined) throw new Error("no slot");
    const dir = join(root(), RUNS_DIR, run.runId);
    await mkdir(dir, { recursive: true });
    await write(dir);
    const logged: string[] = [];
    const facts = factsOf(await readFrameFacts(photoOf(run, slot, { qa: { faceCos: 0.7 } }), readerOf(lib), (line) => logged.push(line)));
    return { facts, logged };
  }

  test("garbage in plan.json: no plan, logged, never a throw", async () => {
    const { facts, logged } = await noPlanFacts((dir) => writeFile(join(dir, PLAN_FILE), "{ not json"));
    expect(facts).toMatchObject({ plan: "none", moment: null, sceneMotion: false, activity: null, capture: "unknown", pose: "front" });
    expect(logged.length).toBe(1);
  });

  test("a plan that fails the strict schema (an unknown key): no plan", async () => {
    const run = ordinaryRun("run-00000007");
    const { facts } = await noPlanFacts((dir) => writeFile(join(dir, PLAN_FILE), JSON.stringify({ ...run, extra: true })));
    expect(facts.plan).toBe("none");
  });

  test("a run the library does not have: no plan", async () => {
    const lib = await library();
    const run = ordinaryRun("run-00000008");
    const slot = planned(run)[0];
    if (slot === undefined) throw new Error("no slot");
    const facts = factsOf(await readFrameFacts(photoOf(run, slot), readerOf(lib), silent));
    expect(facts.plan).toBe("none");
  });

  test("a slot the plan does not hold, or an attempt id with no run: no plan, and the plan is never read for the second", async () => {
    const lib = await library();
    const run = ordinaryRun("run-00000009");
    await lib.createRun(run.runId, run, RunPlanSchema);
    const slot = planned(run)[0];
    if (slot === undefined) throw new Error("no slot");
    const missing = photoOf(run, slot);
    const stray = { ...missing, source: { ...missing.source, slot: "slot-999" } };
    expect(factsOf(await readFrameFacts(stray, readerOf(lib), silent)).plan).toBe("none");
    let reads = 0;
    const noRun = { ...missing, source: { ...missing.source, attemptId: "not-an-attempt-id" } };
    const facts = factsOf(await readFrameFacts(noRun, async (id) => {
      reads++;
      return readerOf(lib)(id);
    }, silent));
    expect(facts.plan).toBe("none");
    expect(reads).toBe(0);
  });

  test("a reader that throws anything at all: no plan", async () => {
    const run = ordinaryRun("run-00000010");
    const slot = planned(run)[0];
    if (slot === undefined) throw new Error("no slot");
    const facts = factsOf(await readFrameFacts(photoOf(run, slot), () => Promise.reject(new TypeError("boom")), silent));
    expect(facts.plan).toBe("none");
  });
});

describe("«Как в сцене» only when the photo's prompt says it (§5.4 step 4)", () => {
  const picked = pick("home", (m) => m.captures.includes("timer") && m.level === undefined && m.legs === undefined);
  const slot = slotOf(picked, "timer");
  const run = sceneRun("run-00000011", [slot]);
  const runSlot = run.scenes.slots[0] as PlanSlot;

  test("the template's «, she …» counts", () => {
    const facts = factsOf(frameFactsOf(photoOf(run, runSlot, { prompt: `In her bedroom, she ${picked.moment.text}, wearing a grey tee.` }), run));
    expect(facts.sceneMotion).toBe(true);
  });

  test("the plain sentence's «She …» counts (case-insensitive)", () => {
    const facts = factsOf(frameFactsOf(photoOf(run, runSlot, { prompt: `She ${picked.moment.text}, wearing a grey tee.` }), run));
    expect(facts.sceneMotion).toBe(true);
  });

  test("an owner-edited sentence that dropped it: code motions only, and no pose sentence either", () => {
    const facts = factsOf(frameFactsOf(photoOf(run, runSlot, { prompt: "She dances in the kitchen with a wooden spoon." }), run));
    expect(facts.moment).toBe(picked.moment);
    expect(facts.sceneMotion).toBe(false);
    expect(facts.activity).toBeNull();
  });

  test("a longer word is not the moment: «she {text}» ends on a word boundary", () => {
    const facts = factsOf(frameFactsOf(photoOf(run, runSlot, { prompt: `She ${picked.moment.text}s and more.` }), run));
    expect(facts.sceneMotion).toBe(false);
  });

  test("a renamed place or moment: no moment, code motions only, never a throw", () => {
    const renamed = sceneRun("run-00000012", [{ ...slot, location: `${slot.location} renamed` }]);
    const renamedSlot = renamed.scenes.slots[0] as PlanSlot;
    const facts = factsOf(frameFactsOf(photoOf(renamed, renamedSlot), renamed));
    expect(facts.plan).toBe("slot");
    expect(facts.moment).toBeNull();
    expect(facts.sceneMotion).toBe(false);
  });
});

describe("frame facts of what is not a run's frame", () => {
  test("an imported photo is not a gallery photo", () => {
    const photo = planlessPhoto("home", {});
    const imported = { ...photo, source: { kind: "imported" as const, importedAt: "2026-10-13T10:00:00.000Z" } };
    expect(frameFactsOf(imported, null)).toEqual({ kind: "not-a-gallery-photo" });
  });

  test("a portrait candidate (generated, no category) is not a gallery photo", () => {
    const photo = planlessPhoto("home", {});
    const { category: _drop, ...source } = photo.source as Extract<typeof photo.source, { kind: "generated" }>;
    expect(frameFactsOf({ ...photo, source }, null)).toEqual({ kind: "not-a-gallery-photo" });
  });

  test("a missing plan: capture unknown, pose front, «Смелая» from the sidecar's category", () => {
    const facts = factsOf(frameFactsOf(planlessPhoto("beach", { faceCos: 0.7 }), null));
    expect(facts).toMatchObject({ plan: "none", category: "beach", capture: "unknown", pose: "front", moment: null, activity: null, legs: false, legwear: null, bold: true });
  });
});

describe("age (§5.4 table: the same rule as `eligible`)", () => {
  test("no age verdict passes", () => {
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null)).ageRefused).toBe(false);
  });

  test("an adult verdict at the gallery's confidence passes", () => {
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7, age: { adult: true, confidence: 0.99 } }), null)).ageRefused).toBe(false);
  });

  test("a verdict that is not adult is refused", () => {
    const facts = factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7, age: { adult: false, confidence: 0.99 } }), null));
    expect(facts.ageRefused).toBe(true);
    expect(frameRefusalOf(facts, "kling-only")).toBe("age-unverified");
  });

  test("an adult verdict below the gallery's confidence is refused", () => {
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7, age: { adult: true, confidence: 0.1 } }), null)).ageRefused).toBe(true);
  });
});

describe("frames of «Смелая» (I5.57) under each BOLD_CLIPS value", () => {
  const night = pick("nightwear", (m) => m.captures.includes("mirror") && m.level === "bold");
  const run = sceneRun("run-00000013", [slotOf(night, "mirror")]);
  const boldSlot = run.scenes.slots[0] as PlanSlot;
  const home = pick("home", (m) => m.captures.includes("mirror") && m.level === undefined);
  const homeRun = sceneRun("run-00000014", [slotOf(home, "mirror")]);
  const homeSlot = homeRun.scenes.slots[0] as PlanSlot;

  test("by the slot's category", () => {
    expect(factsOf(frameFactsOf(photoOf(run, boldSlot), run)).bold).toBe(true);
    expect(factsOf(frameFactsOf(photoOf(homeRun, homeSlot), homeRun)).bold).toBe(false);
  });

  test("by the sidecar's category when there is no plan", () => {
    expect(factsOf(frameFactsOf(planlessPhoto("nightwear", { faceCos: 0.7 }), null)).bold).toBe(true);
    expect(factsOf(frameFactsOf(planlessPhoto("shoot", { faceCos: 0.7 }), null)).bold).toBe(false);
  });

  test("`off` refuses a frame of «Смелая» (bold-off) and nothing else; `kling-only` and `with-fallback` offer it", () => {
    const bold = factsOf(frameFactsOf(photoOf(run, boldSlot), run));
    const ordinary = factsOf(frameFactsOf(photoOf(homeRun, homeSlot), homeRun));
    expect(frameRefusalOf(bold, "off")).toBe("bold-off");
    expect(frameRefusalOf(bold, "kling-only")).toBeNull();
    expect(frameRefusalOf(bold, "with-fallback")).toBeNull();
    for (const mode of ["off", "kling-only", "with-fallback"] as const) expect(frameRefusalOf(ordinary, mode)).toBeNull();
  });

  test("a frame of «Смелая» runs on Kling alone under kling-only (and off): its fallback is none in both engine modes", () => {
    const bold = factsOf(frameFactsOf(photoOf(run, boldSlot), run));
    for (const mode of ["auto", "offer"] as const) {
      expect(clipFallbackOf(bold, "kling-only", mode)).toBe("none");
      expect(clipFallbackOf(bold, "off", mode)).toBe("none");
      expect(clipFallbackOf(bold, "with-fallback", mode)).toBe(mode);
    }
  });

  test("an ordinary frame follows the engine's mode, whatever BOLD_CLIPS says", () => {
    const ordinary = factsOf(frameFactsOf(photoOf(homeRun, homeSlot), homeRun));
    for (const mode of ["auto", "offer"] as const) {
      for (const boldClips of ["off", "kling-only", "with-fallback"] as const) expect(clipFallbackOf(ordinary, boldClips, mode)).toBe(mode);
    }
  });

  test("the defaults are the shipped switches: BOLD_CLIPS kling-only, GROK_FALLBACK auto", () => {
    expect(clipFallbackOf(factsOf(frameFactsOf(photoOf(run, boldSlot), run)))).toBe("none");
    expect(clipFallbackOf(factsOf(frameFactsOf(photoOf(homeRun, homeSlot), homeRun)))).toBe(GROK_FALLBACK);
  });

  test("an age refusal comes before bold-off", () => {
    const bold = factsOf(frameFactsOf(photoOf(run, boldSlot, { qa: { age: { adult: false, confidence: 0.99 } } }), run));
    expect(frameRefusalOf(bold, "off")).toBe("age-unverified");
  });

  test("the mix level never decides it: a beach slot at ordinary level is still a frame of «Смелая»", () => {
    const beach = pick("beach", (m) => m.captures.includes("friend") && m.level === undefined);
    const beachRun = sceneRun("run-00000015", [slotOf(beach, "friend")]);
    const facts = factsOf(frameFactsOf(photoOf(beachRun, beachRun.scenes.slots[0] as PlanSlot), beachRun));
    expect(facts.bold).toBe(true);
    expect(facts.level).toBe(boldContentLevel());
  });
});

describe("the face role (I5.52): a clip is judged only when its photo was", () => {
  const role = (slot: PlanSlot, qa: { faceCos?: number; faceMarked?: true } = { faceCos: 0.7 }): string => {
    const run = sceneRun("run-00000016", [slot]);
    return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot, { qa }), run)).faceRole;
  };
  const friendly = pick("photoshoot", (m) => m.captures.includes("friend") && m.level === undefined && m.legs === undefined && m.angle === undefined);
  const mirror = pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined && m.angle === undefined);
  const pov = pick("home", (m) => m.captures.includes("pov-legs"));
  const low = pick("photoshoot", (m) => m.captures.includes("low-feet"));
  const legsMirror = pick("home", (m) => m.captures.includes("mirror-hidden") && m.legs?.framing === "legs");

  test("front and three-quarter are judged", () => {
    expect(role(slotOf(friendly, "friend", "front"))).toBe("judged");
    expect(role(slotOf(friendly, "friend", "three-quarter"))).toBe("judged");
  });

  test("a profile pose is not judged: the gate skipped it by pose", () => {
    expect(role(slotOf(friendly, "friend", "profile"))).toBe("profile");
  });

  test("mirror-hidden, pov-legs, back, low-feet and a legs framing are hidden: the photo was marked, never judged", () => {
    expect(role(slotOf(mirror, "mirror-hidden", "front"))).toBe("hidden");
    expect(role(slotOf(pov, "pov-legs", "front"))).toBe("hidden");
    expect(role(slotOf(friendly, "friend", "back"))).toBe("hidden");
    expect(role(slotOf(low, "low-feet", "front"))).toBe("hidden");
    expect(role(slotOf(legsMirror, "mirror-hidden", "front"))).toBe("hidden");
  });

  test("an own scene is judged by its pose like any slot", () => {
    const run = sceneRun("run-00000017", [
      { kind: "own", shot: "friend", pose: "front", text: "She waves from a boat." },
      { kind: "own", shot: "friend", pose: "profile", text: "She looks out from a boat." },
      { kind: "own", shot: "friend", pose: "back", text: "She walks along a pier." },
      { kind: "own", shot: "selfie", pose: "three-quarter", text: "She smiles on a train." },
    ]);
    const roles = run.scenes.slots.map((slot) => factsOf(frameFactsOf(photoOf(run, slot as OwnPlanSlot), run)).faceRole);
    expect(roles).toEqual(["judged", "profile", "hidden", "judged"]);
  });

  test("no plan: judged only when the photo carries a likeness and no mark", () => {
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null)).faceRole).toBe("judged");
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7, faceMarked: true }), null)).faceRole).toBe("hidden");
    expect(factsOf(frameFactsOf(planlessPhoto("home", {}), null)).faceRole).toBe("hidden");
  });

  test("whether her face shows, as the gate reads it", () => {
    const run = sceneRun("run-00000018", [slotOf(mirror, "mirror-hidden"), slotOf(friendly, "friend", "front"), slotOf(low, "low-feet")]);
    const faces = run.scenes.slots.map((slot) => factsOf(frameFactsOf(photoOf(run, slot as PlanSlot), run)).face);
    expect(faces).toEqual(["no", "yes", "maybe"]);
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null)).face).toBe("yes");
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7, faceMarked: true }), null)).face).toBe("no");
    expect(factsOf(frameFactsOf(planlessPhoto("home", {}), null)).face).toBe("maybe");
  });
});

describe("a pov-legs photo whose prompt holds no shipped POV line reads as unknown (S5.WP1, plan s5b2 I5.69)", () => {
  /** The pov-legs line before the C3′ fix: such a photo is really a selfie from above (C3 K1). */
  const PRE_FIX = "A photo she took looking down along her own legs from where she lies or sits, held at her eye level; nothing in her hand can be seen.";
  const pov = pick("home", (m) => m.captures.includes("pov-legs"));
  const run = sceneRun("run-00000022", [slotOf(pov, "pov-legs")]);
  const slot = run.scenes.slots[0] as PlanSlot;
  const opened = (opening: string): string => `${opening} ${sentenceOf(run.runId, slot)}. She is an adult woman.`;
  const factsWith = (opening: string): FrameFacts => factsOf(frameFactsOf(photoOf(run, slot, { prompt: opened(opening) }), run));
  /** The facts but the photo id, which every photo has its own of. */
  const fields = ({ photoId: _id, ...rest }: FrameFacts): Omit<FrameFacts, "photoId"> => rest;

  test("the pre-fix line: the capture is unknown", () => {
    expect(factsWith(PRE_FIX).capture).toBe("unknown");
  });

  test("no capture line at all: the capture is unknown", () => {
    expect(factsOf(frameFactsOf(photoOf(run, slot, { prompt: `${sentenceOf(run.runId, slot)}. She is an adult woman.` }), run)).capture).toBe("unknown");
  });

  test("each shipped POV wording keeps pov-legs", () => {
    expect(SHIPPED_POV_CAPTURE_LINES.length).toBeGreaterThanOrEqual(2);
    for (const line of SHIPPED_POV_CAPTURE_LINES) expect(factsWith(line).capture).toBe("pov-legs");
  });

  test("only the capture moves: the face role and the face stay the gate's, the legs framing, the moment, the motion and the activity stay", () => {
    const proven = factsWith(SHIPPED_POV_CAPTURE_LINES[0] ?? "");
    const disproved = factsWith(PRE_FIX);
    expect(disproved.faceRole).toBe("hidden");
    expect(disproved.legs).toBe(true);
    expect(fields(disproved)).toEqual({ ...fields(proven), capture: "unknown" });
  });

  test("no other capture moves: every bank moment on every capture it lists, with the pre-fix line, with no capture line, and with its own line", () => {
    let checked = 0;
    for (const picked of everyMoment()) {
      for (const capture of picked.moment.captures) {
        const each = sceneRun("run-00000023", [slotOf(picked, capture)]);
        const eachSlot = each.scenes.slots[0] as PlanSlot;
        const sentence = sentenceOf(each.runId, eachSlot);
        const own = factsOf(frameFactsOf(photoOf(each, eachSlot), each));
        expect(own.capture).toBe(capture);
        for (const prompt of [`${PRE_FIX} ${sentence}. She is an adult woman.`, `${sentence}. She is an adult woman.`]) {
          const facts = factsOf(frameFactsOf(photoOf(each, eachSlot, { prompt }), each));
          expect(fields(facts)).toEqual({ ...fields(own), capture: capture === "pov-legs" ? "unknown" : capture });
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(271);
  });

  test("an own scene and a photo with no plan are untouched: their captures never read the prompt", () => {
    const ownRun = sceneRun("run-00000024", [{ kind: "own", shot: "selfie", pose: "front", text: "She smiles on a train." }]);
    expect(factsOf(frameFactsOf(photoOf(ownRun, ownRun.scenes.slots[0] as OwnPlanSlot, { prompt: PRE_FIX }), ownRun)).capture).toBe("selfie");
    expect(factsOf(frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null)).capture).toBe("unknown");
  });
});

describe("one source for captures and faces (static)", () => {
  const source = readFileSync(join(import.meta.dir, "frameFacts.ts"), "utf8");

  test("frameFacts takes the face role from V4b's faceRole.ts and keeps no copy: one definition for the role it computes and faceCheck takes", () => {
    expect(source).toMatch(/from "\.\/faceRole"/);
    expect(source).not.toMatch(/type\s+ClipFaceRole\s*=/);
  });

  test("frameFacts takes captureOfShot and faceVisibleOf from 5a.2's captures and keeps no copy", () => {
    expect(source).toMatch(/from "\.\.\/\.\.\/shared\/scenes\/captures"/);
    expect(source).not.toMatch(/function\s+(captureOfShot|faceVisibleOf|shotOf)\b/);
  });

  test("frameFacts finds a moment through the template's lookup and the gate's pose through facePoseOf", () => {
    expect(source).toMatch(/\bmomentOfSlot\(/);
    expect(source).toMatch(/\bfacePoseOf\(/);
    expect(source).toMatch(/\brunIdOfAttempt\(/);
  });

  test("the sentence a fixture's photo carries is the run's own", () => {
    const run = sceneRun("run-00000019", [slotOf(pick("home", (m) => m.captures.includes("timer")), "timer")]);
    const slot = run.scenes.slots[0] as PlanSlot;
    expect(photoOf(run, slot).source).toMatchObject({ prompt: expect.stringContaining(sentenceOf(run.runId, slot)) });
  });
});

describe("the kit's photo prompt opens with the capture line a run writes (S5.WP1, plan s5b2 I5.69, M2)", () => {
  const descriptor: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
  const master = asLibraryReference(JPEG);
  const photoPromptOf = (photo: PhotoSidecar): string => (photo.source.kind === "generated" ? photo.source.prompt : "");

  /** Run ids enough that a friend's or a candid photo draws the knees-up variant on some of them, where a whole-body framing changes the line. */
  const RUN_IDS = ["run-00000020", "run-00000021", "run-00000022", "run-00000023", "run-00000024", "run-00000025"];

  test("every bank moment on every capture it lists, under several keys: the same opening sentence as the real assembler's prompt for that slot", () => {
    let checked = 0;
    // Where the whole-body framing changed the line (the line is not the one the key draws alone): the cases that hold the kit to the assembler's framing rule.
    let framedFeet = 0;
    let framedBoldCrouch = 0;
    for (const picked of everyMoment()) {
      for (const capture of picked.moment.captures) {
        for (const runId of RUN_IDS) {
          const run = sceneRun(runId, [slotOf(picked, capture)]);
          const slot = run.scenes.slots[0] as PlanSlot;
          const line = photoCaptureLineOf(run.runId, slot);
          const assembled = assembleSlot(descriptor, slot, sentenceOf(run.runId, slot), master, { runId: run.runId }).prompt;
          expect(assembled.startsWith(`${line} `)).toBe(true);
          expect(photoPromptOf(photoOf(run, slot)).startsWith(`${line} `)).toBe(true);
          if (line !== captureLineOf(capture, slotKeyOf(run.runId, slot.attemptIdBase))) {
            if (isBoldCategory(slot.category) && /\bcrouch/i.test(slot.activity)) framedBoldCrouch++;
            else framedFeet++;
          }
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThanOrEqual(271 * RUN_IDS.length);
    expect(framedFeet).toBeGreaterThan(0);
    expect(framedBoldCrouch).toBeGreaterThan(0);
  });

  test("an own scene: the line of its shot, as the assembler reads an own scene", () => {
    const run = sceneRun("run-00000021", [{ kind: "own", shot: "selfie", pose: "front", text: "She smiles on a train." }]);
    const own = run.scenes.slots[0] as OwnPlanSlot;
    const assembled = assembleSlot(descriptor, own, sentenceOf(run.runId, own), master, { runId: run.runId }).prompt;
    expect(assembled.startsWith(`${photoCaptureLineOf(run.runId, own)} `)).toBe(true);
    expect(photoPromptOf(photoOf(run, own)).startsWith(`${photoCaptureLineOf(run.runId, own)} `)).toBe(true);
  });
});
