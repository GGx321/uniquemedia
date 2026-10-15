import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MOTION_PROBLEMS, MotionProblems, type ClipMotionSource, type MotionProblem } from "../../shared/engine";
import type { BankCategory } from "../../shared/scenes/banks/types";
import { bankMotionFindings, motionTextProblems, NO_REPAIR_PROBLEMS, repairMayHelp, takesOff, type MotionFrame } from "../../shared/scenes/motionText";
import { boldContentLevel } from "../../shared/scenes/contentLine";
import { PhotoSidecarSchema } from "../library/schemas";
import { RunPlanSchema } from "../runs/plan";
import type { OwnPlanSlot, PlanSlot } from "../scenes/schema";
import { frameFactsOf, type FrameFacts, type FrameFactsResult } from "./frameFacts";
import { CODE_MOTIONS, codeMotionsFor } from "./motion";
import { everyMoment, photoOf, pick, planlessPhoto, sceneRun, slotOf, type Picked } from "./testing/frameFixtures";
import type { Capture } from "../../shared/scenes/captures";
import { posesFor } from "../../shared/scenes/captures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WC2 (plan s5b2 I5.66, §8 WC2): ONE motion check, `motionTextProblems(text, frame, source)`. A text a model wrote (a vision suggestion) or the owner's idea
// made (an own motion) is data, checked like a bank motion: the bank's grammar, then the frame's rules, answered as the contract's closed `MotionProblem`s in their display order.
// Each rule has its red case here; the frames are the kit's (a run's plan and photo), never hand-made facts, except where a test isolates one half of a rule and says so.

function factsOf(result: FrameFactsResult): FrameFacts {
  if (result.kind !== "gallery") throw new Error(`expected a gallery photo, got ${result.kind}`);
  return result.facts;
}

/** The facts of a planned photo of the first moment `test` picks, on `capture`, drawn with its own capture line. */
function planned(category: BankCategory, test: Parameters<typeof pick>[1], capture: Capture, pose: PlanSlot["pose"] = "front"): FrameFacts {
  const run = sceneRun("run-00000401", [slotOf(pick(category, test), capture, pose)]);
  return factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run));
}

/** A friend's photo, her face showing, of a moment that does not use her phone (an ordinary frame of «Путешествия»). */
const FRIEND = planned("travel", (m) => m.captures.includes("friend") && m.legs === undefined && m.phone !== true && m.angle === undefined, "friend");
/** A friend's photo of a moment that uses her phone («checks her phone for her ride»): the bank lets its motion name the phone. */
const FRIEND_PHONE = planned("glamour", (m) => m.phone === true && m.captures.includes("friend"), "friend");
/** A timer frame: the phone is propped. */
const TIMER = planned("home", (m) => m.captures.includes("timer") && m.legs === undefined && m.angle === undefined, "timer");
/** A mirror frame whose phone covers her face. */
const HIDDEN = planned("home", (m) => m.captures.includes("mirror-hidden") && m.legs === undefined, "mirror-hidden");
/** A frame of «Смелая»: a mirror selfie in «Ночнушки и бельё», her face showing. */
const BOLD = planned("nightwear", (m) => m.captures.includes("mirror") && m.legs === undefined && m.angle === undefined, "mirror");

/** C3 K1's own photo and plan: a pov-legs slot drawn before the C3′ fix, so its prompt holds no POV line (unknown), really a selfie from above with the phone in her hand. */
const K1 = ((): FrameFacts => {
  const k1 = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "c3-k1.json"), "utf8")) as { photo: unknown; plan: unknown };
  return factsOf(frameFactsOf(PhotoSidecarSchema.parse(k1.photo), RunPlanSchema.parse(k1.plan)));
})();

const vision = (text: string, frame: MotionFrame = FRIEND): MotionProblem[] => motionTextProblems(text, frame, "vision");

describe("the frames the cases use are what they say (so a red case is the rule's, not the kit's)", () => {
  test("the friend frame: ordinary, her face showing, a moment without a phone; the phone frame's moment uses it", () => {
    expect({ capture: FRIEND.capture, face: FRIEND.face, bold: FRIEND.bold, phone: FRIEND.moment?.phone }).toEqual({ capture: "friend", face: "yes", bold: false, phone: undefined });
    expect({ capture: FRIEND_PHONE.capture, phone: FRIEND_PHONE.moment?.phone }).toEqual({ capture: "friend", phone: true });
  });

  test("the timer, the face-hidden mirror and the «Смелая» mirror", () => {
    expect({ capture: TIMER.capture, face: TIMER.face }).toEqual({ capture: "timer", face: "yes" });
    expect({ capture: HIDDEN.capture, face: HIDDEN.face }).toEqual({ capture: "mirror-hidden", face: "no" });
    expect({ capture: BOLD.capture, face: BOLD.face, bold: BOLD.bold }).toEqual({ capture: "mirror", face: "yes", bold: true });
  });

  test("K1 reads as unknown, planned pov-legs, its moment uses no phone", () => {
    expect({ capture: K1.capture, plannedCapture: K1.plannedCapture, phone: K1.moment?.phone }).toEqual({ capture: "unknown", plannedCapture: "pov-legs", phone: undefined });
  });
});

describe("the bank's grammar, held to a vision or own text (I5.66)", () => {
  test("a text that reads well passes: she or her first, one small movement, at most 60 characters", () => {
    expect(vision("she slowly turns her head a little toward the window")).toEqual([]);
    expect(vision("her shoulders rise a little as she breathes in")).toEqual([]);
  });

  test("over 60 characters: too-long", () => {
    const text = "she slowly turns her head a little toward the window and back";
    expect(text.length).toBe(61);
    expect(vision(text)).toEqual(["too-long"]);
  });

  test("not opening with «she» or «her»: not-motion", () => {
    expect(vision("slowly she turns her head")).toEqual(["not-motion"]);
  });

  test("neither small nor slow: not-small", () => {
    expect(vision("she turns her head toward the window")).toEqual(["not-small"]);
  });

  test("two movements («then», a second «and»): two-movements", () => {
    expect(vision("she slowly smiles then turns her head")).toEqual(["two-movements"]);
    expect(vision("she slowly smiles and turns and nods")).toEqual(["two-movements"]);
  });

  test("the bank's staging words (zoom, cut, pan, frame, shot): staging", () => {
    expect(vision("she slowly turns as the shot widens")).toEqual(["staging"]);
  });

  test("a camera or a lens: staging", () => {
    expect(vision("she slowly leans toward the camera")).toEqual(["staging"]);
    expect(vision("she slowly leans toward the lens")).toEqual(["staging"]);
  });

  test("selfie or front camera, on any frame (it draws a phone): phone", () => {
    expect(vision("she slowly poses for a selfie")).toEqual(["phone"]);
  });

  test("a youth word: content", () => {
    expect(vision("she slowly sits like a teen")).toEqual(["content"]);
  });

  test("a youth prop: content", () => {
    expect(vision("she slowly hugs a teddy bear")).toEqual(["content"]);
  });

  test("a hair colour, with a movement present: content, not not-motion", () => {
    expect(vision("she slowly tucks her blonde hair behind her ear")).toEqual(["content"]);
  });
});

describe("the frame's rules (I5.51, I5.66)", () => {
  test("a revealing word on an ordinary frame: content; on a frame of «Смелая» the bold level lets it", () => {
    expect(vision("she slowly adjusts her bra strap")).toEqual(["content"]);
    expect(vision("she slowly adjusts her bra strap", BOLD)).toEqual([]);
  });

  test("a video word beyond the bank's list (dolly, orbit, cinematic …): staging", () => {
    expect(vision("she slowly turns in a cinematic orbit")).toEqual(["staging"]);
  });

  test("her face moves where the photo does not show it: face-hidden; where it shows, the same text passes", () => {
    expect(vision("she slowly blinks and smiles", HIDDEN)).toEqual(["face-hidden"]);
    expect(vision("she slowly blinks and smiles", FRIEND)).toEqual([]);
  });
});

describe("one phone rule, the union of the bank's and the runtime's (I5.66)", () => {
  const PHONE = "she slowly glances at her phone";

  test("the bank's half: a phone the slot's moment does not use is refused, on any capture", () => {
    expect(vision(PHONE, FRIEND)).toEqual(["phone"]);
  });

  test("the bank's half lets the moment's own phone through, on a capture where no phone is in her hand", () => {
    expect(vision(PHONE, FRIEND_PHONE)).toEqual([]);
  });

  test("the runtime's half: a phone in her hand or propped refuses a text that names a phone, even when the moment uses one (the halves are pinned apart on purpose)", () => {
    expect(vision(PHONE, { ...FRIEND_PHONE, capture: "selfie", plannedCapture: "selfie" })).toEqual(["phone"]);
    expect(vision(PHONE, { ...FRIEND_PHONE, capture: "timer", plannedCapture: "timer" })).toEqual(["phone"]);
  });

  test("an own scene and a photo with no plan have no moment that uses a phone: a phone is refused", () => {
    const run = sceneRun("run-00000402", [{ kind: "own", shot: "friend", pose: "front", text: "She waves from a boat." }]);
    const own = factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as OwnPlanSlot), run));
    const planless = factsOf(frameFactsOf(planlessPhoto("travel", { faceCos: 0.7 }), null));
    expect(vision(PHONE, own)).toEqual(["phone"]);
    expect(vision(PHONE, planless)).toEqual(["phone"]);
  });
});

describe("the phone rule reads the PLANNED hand-held capture (the WP1 review, 2026-10-14)", () => {
  test("C3 K1 (an old pov-legs photo P1 reads as unknown, really a selfie from above): «she glances at her phone» is refused, phone first", () => {
    expect(vision("she glances at her phone", K1)[0]).toBe("phone");
    expect(vision("she slowly glances at her phone", K1)).toEqual(["phone"]);
  });

  test("with the bank's half silenced (a moment that uses the phone), the planned pov-legs alone still refuses it; the same frame with nothing planned does not", () => {
    const usesPhone = { ...K1, moment: { phone: true as const } };
    expect(vision("she slowly glances at her phone", usesPhone)).toEqual(["phone"]);
    expect(vision("she slowly glances at her phone", { ...usesPhone, plannedCapture: "unknown" })).toEqual([]);
  });
});

describe("the closed problems come once each, in the contract's display order", () => {
  test("several rules at once: not-motion, content, staging (a camera and a zoom are one staging)", () => {
    expect(vision("Slowly the camera zooms in on a teen")).toEqual(["not-motion", "content", "staging"]);
  });

  test("every answer the corpus below gets is a valid contract MotionProblems or empty", () => {
    const corpus = [
      "she slowly turns her head a little toward the window and back",
      "slowly she turns her head",
      "she turns her head toward the window",
      "she slowly smiles then turns her head",
      "Slowly the camera zooms in on a teen",
      "she glances at her phone",
      "she slowly poses for a selfie with her blonde hair, then zooms",
    ];
    for (const frame of [FRIEND, FRIEND_PHONE, TIMER, HIDDEN, BOLD, K1]) {
      for (const source of ["vision", "own"] as const) {
        for (const text of corpus) {
          const problems = motionTextProblems(text, frame, source);
          if (problems.length > 0) expect(MotionProblems.safeParse(problems).success).toBe(true);
          expect(problems.every((p) => MOTION_PROBLEMS.includes(p))).toBe(true);
        }
      }
    }
  });
});

// ---------- which rules each source takes ----------

/** The pose a moment is drawn with on a capture (the sweep's rule). */
function poseOf(picked: Picked, capture: Capture): PlanSlot["pose"] {
  const poses = posesFor(capture);
  return picked.moment.angle !== undefined && poses.includes(picked.moment.angle) ? picked.moment.angle : (poses[0] ?? "front");
}

/** Every bank moment on every capture it lists, as a frame. */
function everyFrame(): { where: string; picked: Picked; facts: FrameFacts }[] {
  return everyMoment().flatMap((picked) =>
    picked.moment.captures.map((capture) => {
      const run = sceneRun("run-00000403", [slotOf(picked, capture, poseOf(picked, capture))]);
      return { where: `${picked.category}/${picked.place.name}/«${picked.moment.text}» on ${capture}`, picked, facts: factsOf(frameFactsOf(photoOf(run, run.scenes.slots[0] as PlanSlot), run)) };
    }),
  );
}

/** The frames whose own bank motion moves a face the photo hides (prompt.sweep.test.ts's DROPPED). */
const FACE_DROPPED = new Set([
  "fitness/a gym floor/«holds a water bottle» on mirror-hidden",
  "fitness/the gym locker room/«holds a water bottle» on mirror-hidden",
  "nightwear/her bed/«sits cross-legged with her coffee» on mirror-hidden",
]);

describe("the sources: a scene motion's grammar ran when its bank loaded; code, vision and own take it here", () => {
  const SIXTY_ONE = "she slowly turns her head a little toward the window and back";

  test("a scene text takes the frame's rules only (the bank loader held it to the grammar): 61 characters pass as scene, never as code, vision or own", () => {
    expect(motionTextProblems(SIXTY_ONE, TIMER, "scene")).toEqual([]);
    for (const source of ["code", "vision", "own"] as const satisfies readonly ClipMotionSource[]) expect(motionTextProblems(SIXTY_ONE, TIMER, source)).toEqual(["too-long"]);
  });

  test("a scene text still takes the frame's rules: a phone on a propped capture, a face the photo hides", () => {
    expect(motionTextProblems("she checks her phone slowly", TIMER, "scene")).toEqual(["phone"]);
    expect(motionTextProblems("she slowly blinks and smiles", HIDDEN, "scene")).toEqual(["face-hidden"]);
  });

  test("the 7 code motions pass the one check, as code, on every frame they are offered", () => {
    let offered = 0;
    for (const { where, facts } of everyFrame()) {
      for (const motion of codeMotionsFor(facts)) {
        expect([where, motion.id, motionTextProblems(motion.text, facts, "code")]).toEqual([where, motion.id, []]);
        offered++;
      }
    }
    expect(new Set(CODE_MOTIONS.map((m) => m.id)).size).toBe(7);
    expect(offered).toBeGreaterThan(0);
  });

  test("all 271 bank motions pass as scene on every capture their moment lists, but the three pinned face-hidden frames", () => {
    let passed = 0;
    for (const { where, picked, facts } of everyFrame()) {
      const problems = motionTextProblems(picked.moment.motion, facts, "scene");
      if (FACE_DROPPED.has(where)) expect(problems).toEqual(["face-hidden"]);
      else {
        expect([where, problems]).toEqual([where, []]);
        passed++;
      }
    }
    expect(new Set(everyMoment().map((p) => p.moment)).size).toBe(271);
    expect(passed).toBeGreaterThanOrEqual(271);
  });

  test("the vocabulary the bank proves is open to a model: every bank motion would pass as a vision and an own text on its frames, but the same three", () => {
    for (const { where, picked, facts } of everyFrame()) {
      for (const source of ["vision", "own"] as const) {
        const problems = motionTextProblems(picked.moment.motion, facts, source);
        expect([where, source, problems]).toEqual([where, source, FACE_DROPPED.has(where) ? ["face-hidden"] : []]);
      }
    }
  });
});

// ---------- Q-H = 2 (the owner, 2026-10-14): a motion that takes clothing off ----------

describe("TAKES_OFF: the pinned list of a motion that takes clothing off (plan §5.3)", () => {
  /** The plan's seven («takes off», «pulls off», «removes her», «unbuttons», «unzips her», «slips out of», «lets … fall»), each as a motion would say it, the particle split too. */
  const PINNED = [
    "she slowly takes off her robe",
    "she slowly takes her robe off",
    "she slowly pulls off her top",
    "she slowly pulls the sheet off",
    "she slowly removes her robe",
    "she slowly unbuttons her shirt",
    "she slowly unzips her dress",
    "she slowly slips out of her dress",
    "she slowly lets the strap fall",
    "she slowly lets her robe fall to the floor",
  ];
  /** Beyond the seven (S5.WC2, for the review): the same act in the words a model reaches for. */
  const ALSO = ["she slowly slips the robe off her shoulders", "she slowly slides the strap off her shoulder", "she slowly peels off her top", "she slowly shrugs off her jacket", "she slowly undresses", "she slowly strips"];

  for (const text of [...PINNED, ...ALSO]) {
    test(`takes clothing off: «${text}»`, () => {
      expect(takesOff(text)).toBe(true);
    });
  }

  /** What only looks like it: hair, a hand, her head or her body, a breath, a sip, sand, a bag, the bed. */
  const NOT = [
    "she slowly lets her hair fall over her shoulder",
    "she slowly lets her head fall back",
    "she slowly lets her arms fall to her sides",
    "she slowly removes her hand from her hip",
    "she slowly pulls her hair off her face",
    "she slowly takes a breath",
    "she slowly takes a small sip",
    "she brushes the sand off slowly",
    "she slowly unzips her bag",
    "she slowly slides off the bed",
    "she slowly takes her sunglasses in her hand",
  ];
  for (const text of NOT) {
    test(`does not: «${text}»`, () => {
      expect(takesOff(text)).toBe(false);
    });
  }

  test("no bank motion and no code motion takes clothing off (the bank is unchanged by Q-H)", () => {
    expect(everyMoment().filter((p) => takesOff(p.moment.motion)).map((p) => p.moment.motion)).toEqual([]);
    expect(CODE_MOTIONS.filter((m) => takesOff(m.text)).map((m) => m.id)).toEqual([]);
  });
});

describe("Q-H = 2: an own idea that takes clothing off is accepted on a frame of «Смелая» only (I5.66, §12)", () => {
  const ROBE = "she slowly takes off her robe";

  test("an own idea on a frame of «Смелая»: accepted", () => {
    expect(motionTextProblems(ROBE, BOLD, "own")).toEqual([]);
  });

  test("the same own idea on a frame that is not «Смелая»: takes-off", () => {
    expect(motionTextProblems(ROBE, FRIEND, "own")).toEqual(["takes-off"]);
    expect(motionTextProblems(ROBE, TIMER, "own")).toEqual(["takes-off"]);
  });

  test("a vision text that takes clothing off is refused on every frame, «Смелая» included: the writer never proposes it", () => {
    expect(motionTextProblems(ROBE, BOLD, "vision")).toEqual(["takes-off"]);
    expect(motionTextProblems(ROBE, FRIEND, "vision")).toEqual(["takes-off"]);
  });

  test("a scene or code text that takes clothing off never passes either; the bank's loader does not read the rule (the bank is unchanged)", () => {
    for (const source of ["scene", "code"] as const) expect(motionTextProblems(ROBE, BOLD, source)).toEqual(["takes-off"]);
    expect(bankMotionFindings(ROBE, boldContentLevel(), false)).toEqual([]);
  });

  test("an explicit word with the verb on an ordinary frame: content and takes-off, in the contract's fixed order (content first; the WCD review's L5 is reported, not reordered)", () => {
    expect(motionTextProblems("she slowly takes off her bra", FRIEND, "own")).toEqual(["content", "takes-off"]);
    expect(motionTextProblems("she slowly takes off her bra", BOLD, "own")).toEqual([]);
  });
});

describe("takes-off gets no repair attempt (WC3 reads this)", () => {
  test("the problems a repair cannot help are takes-off alone", () => {
    expect([...NO_REPAIR_PROBLEMS]).toEqual(["takes-off"]);
  });

  test("a rejection holding takes-off is final; any other may be repaired once", () => {
    expect(repairMayHelp(["takes-off"])).toBe(false);
    expect(repairMayHelp(["content", "takes-off"])).toBe(false);
    expect(repairMayHelp(["not-small"])).toBe(true);
    expect(repairMayHelp(["content", "phone"])).toBe(true);
  });
});
