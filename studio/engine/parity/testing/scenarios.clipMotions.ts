import { mockIdeaAnswer, mockSuggestionAnswer, type MockModelReply } from "../../../renderer/engine/mockClipMotions";
import type { ClipWorld } from "./clipWorld";
import type { Control, World } from "./rigs";
import type { Scenario } from "./scenarios";
import type { Answer, Transcript } from "./transcript";

// Stage 5, 5b.2, S5.WC4 (APPENDED; the golden is append-only): part C «свои движения» told against both engines on the rig the clip stories use (the fake provider, the short timing set): the vision writer's
// suggestions and «Своя идея», with the model's answers scripted (`ClipControl.motions.script`, the mock's own vocabulary; every answer names its cost so the two rigs bill the same). A story that reads the guard
// holds the model (`motions.hold`) and waits for the call to be at the model (`motions.untilAtModel`), never on a sleep.
//
// Not played here, held by the engines' own suites on a clock they control: a `timeout` or a `network` answer (the real transport waits 60 s for the first), a 5xx or a 429 (real pauses between the retries), the
// batch's gap between two members, and the restart with a call in flight.

type Telling = Transcript;

const BUDGET = 10_000_000;
const STD_5 = 850_000;
const KLING_ONLY_5 = 504_000;
/** The two calls' worst cases at the engine's bundled prices (clips/motionPrice.ts); the mock holds the same figures (mockEngine.clipMotions.table.test.ts). */
const SUGGEST_WORST = 14_810;
const IDEA_WORST = 9_650;

const RIG = { clips: { batch: 4, budgetMicros: BUDGET } } as const;

const GOOD = [
  "she slowly tucks a strand of hair behind her ear",
  "she tilts her head a little to one side and smiles",
  "she slowly takes a breath and relaxes her shoulders",
  "she slowly looks down and smiles to herself",
] as const;
/** GOOD with the two texts that equal the code motions `g-tilt` and `g-breath` replaced (S5.WC3c: a suggestion equal to a frame's code motion is not stored). For suggestions only; GOOD stays for ideas. */
const SUGGESTED = [GOOD[0], "she slowly lifts her chin and smiles softly", "she slowly turns toward the window and smiles", GOOD[3]] as const;
const NOT_MOTION = "slowly she turns her head";
const TWO_MOVEMENTS = "she slowly turns her head and then she slowly sits down";
const UNDRESS = "she slowly takes off her robe";
/** S5.WC2c: the same with an age, which the minor-age guard refuses on every frame, at once (no repair could take the age out). */
const UNDER_AGE = "she slowly takes off her robe, aged sixteen";
/** The owner's idea: long enough that the label (his first words, cut to 40 characters) leaves the rest of it out. */
const IDEA = "медленно поворачивает голову к окну и улыбается, CANARY-9c41";

/** The writer's answer for these texts, billed `cost`. */
const suggestion = (texts: readonly string[], cost = 3_400): MockModelReply => mockSuggestionAnswer(texts, {}, cost);
const translation = (text: string, cost = 1_000): MockModelReply => mockIdeaAnswer(text, cost);
/** A paid answer that is no JSON at all: unusable. */
const UNREADABLE: MockModelReply = { kind: "answer", content: "I cannot see the photo", costMicros: 2_000 };
const REFUSED: MockModelReply = { kind: "refused" };

function clipsOf(world: World): ClipWorld {
  if (world.clipWorld === undefined) throw new Error("the rig has no clip world: the story needs `rig: { clips: ... }`");
  return world.clipWorld;
}

function resultOf(answer: Answer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`the story expected ok, got ${answer.error.code}`);
  return answer.result;
}

function jobIdOf(answer: Answer): string {
  const jobId = resultOf(answer).jobId;
  if (typeof jobId !== "string") throw new Error("expected a job id");
  return jobId;
}

const suggestPayload = (w: ClipWorld, photoId = w.photos.plain, acceptedWorstMicros = SUGGEST_WORST) => ({ avatarId: w.avatarId, photoId, acceptedWorstMicros });
const ideaPayload = (w: ClipWorld, text = IDEA, photoId = w.photos.plain, acceptedWorstMicros = IDEA_WORST) => ({ avatarId: w.avatarId, photoId, text, acceptedWorstMicros });
const photoOf = (w: ClipWorld, photoId = w.photos.plain) => ({ avatarId: w.avatarId, photoId });

function createPayload(w: ClipWorld, photoId: string, motionId: string, over: { fallback?: "auto" | "none"; acceptedWorstMicros?: number } = {}) {
  return { avatarId: w.avatarId, photoId, motionId, model: "kling", quality: "std", seconds: 5, fallback: over.fallback ?? "auto", acceptedWorstMicros: over.acceptedWorstMicros ?? STD_5 };
}

function batchPayload(w: ClipWorld, photoIds: readonly string[]) {
  return {
    avatarId: w.avatarId,
    items: photoIds.map((photoId) => ({ photoId, motionId: "g-blink" })),
    quality: "std",
    seconds: 5,
    fallback: "auto",
    acceptedWorstMicros: photoIds.length * STD_5,
  };
}

/** A `clips.create` that breaks the first rule it meets after the unit (the master is no gallery photo): refused IN_FLIGHT while the unit is held or a part C call runs, by its own fault otherwise. */
function probe(w: ClipWorld): unknown {
  return { avatarId: w.avatarId, photoId: w.masterPhotoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: STD_5 };
}

async function options(t: Telling, w: ClipWorld, photoId = w.photos.plain): Promise<void> {
  await t.call("clips.options", photoOf(w, photoId));
}

async function status(t: Telling): Promise<void> {
  await t.call("money.status", {});
}

/** A paid call: the model's answers, then the call. */
async function suggest(t: Telling, w: ClipWorld, control: Control, replies: readonly MockModelReply[], photoId = w.photos.plain): Promise<Answer> {
  control.clips.motions.script(replies);
  return t.call("clips.suggestMotions", suggestPayload(w, photoId));
}

async function translate(t: Telling, w: ClipWorld, control: Control, replies: readonly MockModelReply[], text = IDEA, photoId = w.photos.plain): Promise<Answer> {
  control.clips.motions.script(replies);
  return t.call("clips.translateIdea", ideaPayload(w, text, photoId));
}

export const CLIP_MOTION_SCENARIOS: readonly Scenario[] = [
  {
    name: "clip motions: the estimates are free, a suggestion is paid at the model's bill and its motions join the sheet with the frame reading, and the money is settled",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("the sheet before: the code's motions and no reading");
      await options(t, w);
      t.note("the two estimates are free");
      await t.call("clips.estimateSuggest", photoOf(w));
      await t.call("clips.estimateIdea", photoOf(w));
      await status(t);
      t.note("the owner accepts the worst case; the model suggests three motions at $0.0034");
      await suggest(t, w, control, [suggestion(SUGGESTED.slice(0, 3))]);
      await status(t);
      t.note("the sheet after: the suggestions after the code's, the frame reading and no chat call");
      await options(t, w);
    },
  },
  {
    name: "clip motions: a suggestion nobody can use is paid for, the model's moderation refusal is free, and the sheet is as it was",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("two answers that are no JSON: paid twice, and nothing stored");
      await suggest(t, w, control, [UNREADABLE, UNREADABLE]);
      await status(t);
      t.note("the model refuses the frame: free");
      await suggest(t, w, control, [REFUSED]);
      await status(t);
      t.note("an unusable answer, then a refusal: `none`, and the paid amount is told");
      await suggest(t, w, control, [UNREADABLE, REFUSED]);
      await status(t);
      t.note("an answer whose texts all fail the check is repaired once, and not twice: paid for both");
      await suggest(t, w, control, [suggestion([NOT_MOTION], 3_000), suggestion([NOT_MOTION], 3_000)]);
      await status(t);
      t.note("a text the age guard refuses is dropped, with no second attempt");
      await suggest(t, w, control, [suggestion([UNDER_AGE], 3_000)]);
      await status(t);
      await options(t, w);
    },
  },
  {
    name: "clip motions: a text that fails the check is repaired by the second attempt, an answer of four keeps the first three, and a second suggestion continues the ids",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await suggest(t, w, control, [suggestion([NOT_MOTION], 3_000), suggestion(SUGGESTED.slice(0, 4))]);
      await options(t, w);
      t.note("a second suggestion: the ids go on, the oldest of the three listed drop out of the sheet");
      await suggest(t, w, control, [suggestion([GOOD[3] ?? ""])]);
      await options(t, w);
      await status(t);
    },
  },
  {
    name: "clip motions: an idea is translated, paid at the model's bill, listed as o-1 under his label, and the clip made from it says `own`; a suggestion's clip says `vision`",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await suggest(t, w, control, [suggestion(SUGGESTED.slice(0, 3))]);
      await translate(t, w, control, [translation(GOOD[3] ?? "")]);
      await status(t);
      await options(t, w);
      t.note("a clip from the second suggestion, then a clip from the idea");
      const first = await t.call("clips.create", createPayload(w, w.photos.plain, "v-2"));
      await t.untilJobEnds(jobIdOf(first));
      const second = await t.call("clips.create", createPayload(w, w.photos.plain, "o-1"));
      await t.untilJobEnds(jobIdOf(second));
      await t.call("clips.list", { avatarId: w.avatarId });
      t.note("an id the sheet did not list is refused, free");
      await t.call("clips.create", createPayload(w, w.photos.plain, "v-9"));
      await t.call("clips.create", createPayload(w, w.photos.plain, "o-2"));
    },
  },
  {
    name: "clip motions: an idea that fails the checks is rejected with its closed problems, paid for the repair too; one the age guard refuses is rejected at once",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("two movements: rejected after one repair, two chat calls");
      await translate(t, w, control, [translation(TWO_MOVEMENTS), translation(TWO_MOVEMENTS)]);
      t.note("an age: rejected at once by the age guard, one chat call");
      await translate(t, w, control, [translation(UNDER_AGE)]);
      t.note("not a motion, then the model refuses the repair: rejected with the paid amount");
      await translate(t, w, control, [translation(NOT_MOTION), REFUSED]);
      t.note("an idea the model answers badly twice is `none`, paid; one it refuses is `none`, free");
      await translate(t, w, control, [UNREADABLE, UNREADABLE]);
      await translate(t, w, control, [REFUSED]);
      await status(t);
      t.note("nothing was stored");
      await options(t, w);
    },
  },
  {
    name: "clip motions: on a frame of «Смелая» an idea that takes clothing off is accepted (Q-H = 2) and its clip runs on Kling alone",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await translate(t, w, control, [translation(UNDRESS)], "снимает халат", w.photos.bold);
      await options(t, w, w.photos.bold);
      t.note("the sheet's Kling-only figure is enough: the idea never falls back to Grok");
      const created = await t.call("clips.create", createPayload(w, w.photos.bold, "o-1", { fallback: "auto", acceptedWorstMicros: KLING_ONLY_5 }));
      await t.untilJobEnds(jobIdOf(created));
      await t.call("clips.list", { avatarId: w.avatarId });
      t.note("the POSTs that left: " + (control.clips.posts().join(", ") || "none"));
      t.note("the same idea on an ordinary frame is accepted too (S5.WC2c)");
      await translate(t, w, control, [translation(UNDRESS)], "снимает халат");
    },
  },
  {
    name: "clip motions: a part C call waits for the clip money (clip-busy, a batch included), and a clip or a batch waits for any part C call (motion-busy); both free",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const [a, b] = [w.photos.plain, w.batch?.[0] ?? ""];
      t.note("a batch of two: the first member is out");
      control.clips.hold(true);
      const made = await t.call("clips.createBatch", batchPayload(w, [a, b]));
      const jobIds = Array.isArray(resultOf(made).jobIds) ? (resultOf(made).jobIds as string[]) : [];
      await t.untilPhase(jobIds[0] ?? "", "rendering");
      await t.call("clips.suggestMotions", suggestPayload(w));
      await t.call("clips.translateIdea", ideaPayload(w));
      t.note("the first member is done and the second is being submitted: the unit is still the batch's");
      control.clips.holdSubmit(true);
      control.clips.hold(false);
      await t.untilPhase(jobIds[1] ?? "", "submitting");
      await t.call("clips.suggestMotions", suggestPayload(w));
      control.clips.holdSubmit(false);
      await t.untilBatchEnds(probe(w));
      t.note("the unit is free: a suggestion goes through, and while the model has not answered no clip may start");
      control.clips.motions.script([suggestion(GOOD.slice(0, 1))]);
      control.clips.motions.hold(true);
      const call = t.start("clips.suggestMotions", suggestPayload(w));
      await control.clips.motions.untilAtModel();
      await t.call("clips.create", createPayload(w, a, "g-blink"));
      await t.call("clips.createBatch", batchPayload(w, [a]));
      t.note("any avatar and any photo: the first rule a clip meets");
      await t.call("clips.create", { ...createPayload(w, "photo-nobody-0001", "g-blink"), avatarId: "avatar-nobody-0001" });
      control.clips.motions.hold(false);
      await t.untilAnswered(call + 1);
      t.note("the call ended: a clip goes through");
      const created = await t.call("clips.create", createPayload(w, a, "g-blink"));
      await t.untilJobEnds(jobIdOf(created));
    },
  },
  {
    name: "clip motions: one call per photo and kind: a second suggestion or a second translation for the same photo is refused while the first is at the model, free",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.motions.hold(true);
      control.clips.motions.script([suggestion(GOOD.slice(0, 1))]);
      const first = t.start("clips.suggestMotions", suggestPayload(w));
      await control.clips.motions.untilAtModel();
      await t.call("clips.suggestMotions", suggestPayload(w));
      control.clips.motions.hold(false);
      await t.untilAnswered(first + 1);
      control.clips.motions.hold(true);
      control.clips.motions.script([translation(GOOD[1] ?? "")]);
      const second = t.start("clips.translateIdea", ideaPayload(w));
      await control.clips.motions.untilAtModel();
      await t.call("clips.translateIdea", ideaPayload(w));
      control.clips.motions.hold(false);
      await t.untilAnswered(second + 1);
      await options(t, w);
    },
  },
  {
    name: "clip motions: the ids of a source that ran out are `motions-full`, free, and the other source is not full",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await control.clips.motions.fillIds(w.photos.plain, "vision");
      await t.call("clips.suggestMotions", suggestPayload(w));
      await translate(t, w, control, [translation(GOOD[0] ?? "")]);
      await status(t);
      await options(t, w);
    },
  },
  {
    name: "clip motions: every refusal before the money is free and comes in the engine's order, with the photo's own reason",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("the estimates: a photo or an avatar the library does not have");
      await t.call("clips.estimateSuggest", { avatarId: w.avatarId, photoId: "photo-nobody-0001" });
      await t.call("clips.estimateIdea", { avatarId: "avatar-nobody-0001", photoId: w.photos.plain });
      t.note("a photo that cannot be brought to life, for both calls");
      for (const photoId of [w.masterPhotoId, w.photos.aged, w.photos.unknown, w.photos.hidden, w.photos.landscape, w.photos.unreadable, "photo-nobody-0001"]) {
        await t.call("clips.suggestMotions", suggestPayload(w, photoId));
        await t.call("clips.translateIdea", ideaPayload(w, IDEA, photoId));
      }
      t.note("the owner accepted a sum one micro-dollar below the worst case");
      await t.call("clips.suggestMotions", suggestPayload(w, w.photos.plain, SUGGEST_WORST - 1));
      await t.call("clips.translateIdea", ideaPayload(w, IDEA, w.photos.plain, IDEA_WORST - 1));
      t.note("the exact worst case is accepted");
      await suggest(t, w, control, [suggestion(GOOD.slice(0, 1))]);
      await status(t);
    },
  },
  {
    name: "clip motions: a month without room for the worst case refuses both calls, free",
    rig: { clips: { batch: 4, budgetMicros: IDEA_WORST - 1 } },
    async run(t, world, control) {
      const w = clipsOf(world);
      await t.call("clips.suggestMotions", suggestPayload(w));
      await t.call("clips.translateIdea", ideaPayload(w));
      await status(t);
      void control;
    },
  },
  {
    name: "clip motions: the provider refuses the key: AUTH_INVALID, free, the key is marked rejected and the next call is refused before anything is sent",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await suggest(t, w, control, [{ kind: "http", status: 401 }]);
      await t.call("clips.suggestMotions", suggestPayload(w));
      await t.call("clips.translateIdea", ideaPayload(w));
      await status(t);
    },
  },
  // Round 2 (APPENDED): the money of an attempt is the engine's formula over the message it really sends, and a bill above the reserve stops the ledger.
  {
    name: "clip motions: an attempt is reserved for the message it sends, settled at its worst case when the paid body is no chat answer, and the open reserve is told while the call waits",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("a paid body that is no chat answer: settled at the attempt's worst case, no second attempt");
      await suggest(t, w, control, [{ kind: "unusable-body" }]);
      await status(t);
      await translate(t, w, control, [{ kind: "unusable-body" }]);
      await status(t);
      t.note("a suggestion at the model: its reserve is open, at the size of its message");
      control.clips.motions.hold(true);
      control.clips.motions.script([suggestion(GOOD.slice(0, 1))]);
      const call = t.start("clips.suggestMotions", suggestPayload(w));
      await control.clips.motions.untilAtModel();
      await status(t);
      control.clips.motions.hold(false);
      await t.untilAnswered(call + 1);
      t.note("an idea of 300 letters at the model: a longer message, a larger reserve");
      control.clips.motions.hold(true);
      control.clips.motions.script([translation(GOOD[1] ?? "")]);
      const long = t.start("clips.translateIdea", ideaPayload(w, "я".repeat(300)));
      await control.clips.motions.untilAtModel();
      await status(t);
      control.clips.motions.hold(false);
      await t.untilAnswered(long + 1);
      await status(t);
    },
  },
  {
    name: "clip motions: a bill above the reserve stops the ledger: the answer is used, the repair is refused, and the next call is refused with the ledger's cause",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("the model bills $0.02 for an attempt reserved at about $0.007");
      await suggest(t, w, control, [{ kind: "answer", content: "I cannot see the photo", costMicros: 20_000 }, UNREADABLE]);
      await status(t);
      t.note("the ledger is stopped: no paid call of any kind is sent");
      await t.call("clips.suggestMotions", suggestPayload(w));
      await t.call("clips.translateIdea", ideaPayload(w));
      await t.call("clips.create", createPayload(w, w.photos.plain, "g-blink"));
    },
  },
  {
    name: "clip motions: a frame of «Смелая» while bold clips are off is refused for both calls, free",
    rig: { clips: { batch: 4, budgetMicros: BUDGET, boldClips: "off" } },
    async run(t, world) {
      const w = clipsOf(world);
      await t.call("clips.suggestMotions", suggestPayload(w, w.photos.bold));
      await t.call("clips.translateIdea", ideaPayload(w, IDEA, w.photos.bold));
      await status(t);
    },
  },
  {
    // Appended in S5.WC3c: the same answer twice. The second call is a paid `none` with the reason `repeated`; nothing is stored, the ids go on from where they were, and the sheet is as the first call left it.
    name: "clip motions: a model that repeats what is already stored is paid for and told `repeated`, nothing is stored twice, and the sheet is as it was",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("the model suggests two motions");
      await suggest(t, w, control, [suggestion([GOOD[0], GOOD[3]])]);
      t.note("the same texts again, with another frame reading: paid, `none` with the reason `repeated`, and the reading stays the first call's");
      await suggest(t, w, control, [mockSuggestionAnswer([GOOD[0], GOOD[3]], { phoneVisible: true }, 3_400)]);
      await status(t);
      t.note("the sheet: the two suggestions once, the first reading");
      await options(t, w);
    },
  },
  {
    // Appended in S5.WC3c round 3: a suggestion older than the newest three has left the sheet; suggesting it again brings it back as a new item, while one still on the sheet is `repeated`.
    name: "clip motions: a model that suggests a motion which left the sheet gets it stored again as a new item, and one still on the sheet is `repeated`",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("four suggestions in two calls: the first one drops out of the newest three");
      await suggest(t, w, control, [suggestion(SUGGESTED.slice(0, 3))]);
      await suggest(t, w, control, [suggestion([SUGGESTED[3]])]);
      await options(t, w);
      t.note("the model suggests the first one again: it is stored as v-5 and shows");
      await suggest(t, w, control, [suggestion([SUGGESTED[0]])]);
      await options(t, w);
      t.note("one that is on the sheet: repeated, paid");
      await suggest(t, w, control, [suggestion([SUGGESTED[0]])]);
      await status(t);
    },
  },
  {
    // Appended in S5.WC2c (the owner, 2026-10-17): every content refusal is lifted but the minor-age guard, a hard line. An age, a youth word or a bare number is refused at once on an
    // ordinary frame and on «Смелая», for a suggestion and for an idea: no second attempt, so no repair can take the age out.
    name: "clip motions: the age guard refuses a suggestion and an idea that name an age at once, on an ordinary frame and on «Смелая», with no second attempt",
    rig: { clips: { batch: 4, budgetMicros: BUDGET, boldClips: "kling-only" } },
    async run(t, world, control) {
      const w = clipsOf(world);
      for (const photoId of [w.photos.plain, w.photos.bold]) {
        t.note(photoId === w.photos.plain ? "an ordinary frame" : "a frame of «Смелая»");
        await suggest(t, w, control, [suggestion([UNDER_AGE], 3_000), suggestion(GOOD.slice(0, 1))], photoId);
        await translate(t, w, control, [translation("she slowly undresses, a young girl"), translation(UNDRESS)], "снимает халат", photoId);
        await translate(t, w, control, [translation("she slowly undresses, sixteen"), translation(UNDRESS)], "снимает халат", photoId);
        await status(t);
      }
      t.note("nothing was stored");
      await options(t, w);
      await options(t, w, w.photos.bold);
    },
  },
  {
    // Appended in S5.WC2c: routing follows the frame, never the motion. An idea that takes clothing off on an ordinary frame is accepted, and its clip keeps the frame's Grok
    // fallback: the window's fallback figure is its worst case, as for any motion of the frame (its prompt, «Nothing new appears.» alone, is the engines' own unit tests').
    name: "clip motions: an idea that takes clothing off on an ordinary frame is accepted, and its clip keeps the frame's Grok fallback",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await translate(t, w, control, [translation(UNDRESS)], "снимает халат");
      await options(t, w);
      t.note("the Kling-only figure is not enough: the fallback stays the frame's");
      await t.call("clips.create", createPayload(w, w.photos.plain, "o-1", { fallback: "auto", acceptedWorstMicros: KLING_ONLY_5 }));
      const created = await t.call("clips.create", createPayload(w, w.photos.plain, "o-1", { fallback: "auto" }));
      await t.untilJobEnds(jobIdOf(created));
      await t.call("clips.list", { avatarId: w.avatarId });
      t.note("the POSTs that left: " + (control.clips.posts().join(", ") || "none"));
    },
  },
];
