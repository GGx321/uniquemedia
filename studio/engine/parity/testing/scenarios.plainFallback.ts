import { begin, ENOUGH, record, review } from "./scenarios.autopilotRun";
import type { Scenario } from "./scenarios";
import type { Answer } from "./transcript";
import { LLM_ONLY_REF } from "../../scenes/testing/llmOnlyFixture";
import { plainSentence } from "../../../shared/scenes/plain";

// Stage 5, S5.6d (APPENDED; the golden is append-only, plan s5a2 §5.7): what a writer that cannot write a scene changed, told against both engines. Before S5.6d a chunk the model rejected twice was
// given up on (its scenes read «не составлена»), and a rewrite it rejected twice failed. Now a PLANNED scene the model could not write in the chunk's two answers takes the plain sentence, so the
// whole set is written and nothing is given up. The stories plan from `cat-llm-only-fixture` (the dated list of scenarios.autopilotRun.ts): a category whose activities the code template cannot
// write, so the model is asked, and the fake OpenRouter answers the writer with an answer that has no scene in it (`control.launch.rejectWriter`).
//
// What is not here: an idea write that keeps the scenes the model got right, and the slot a sentence that breaks the word rules ends. The fake writer answers a request with a sentence per scene
// and no shot or pose, which an idea write asks for, and a run draws its sentences from the engine's planner, so neither can be told the same way to both engines; their tests are in
// the engine's (writerPhase.repair, reviewWriteJob, runJob) and the mock's (mockEngine.sceneSets.writes, mockEngine.runs) own suites.

const ON_THE_WRITER = { categories: [LLM_ONLY_REF] };

/** The scenes of the avatar's set as a story reads them, and the revision the set is at (each engine counts its own; the transcript writes `<seen>`). */
async function readSet(t: Parameters<Scenario["run"]>[0], avatarId: string): Promise<{ sceneSetId: string; revision: number }> {
  const answer = await t.callLaunch("scenes.get", { avatarId });
  const set = answer.ok ? record(answer.result.sceneSet) : null;
  if (set === null || typeof set.sceneSetId !== "string" || typeof set.revision !== "number") throw new Error("the avatar has no scene set to read");
  return { sceneSetId: set.sceneSetId, revision: set.revision };
}

/** Lets the avatar's scene set finish its job (a write is a job; the real engine ends it in its own time, the mock on its clock). */
async function untilSetReady(t: Parameters<Scenario["run"]>[0], avatarId: string): Promise<void> {
  await t.quiet(async () => {
    for (let i = 0; i < 2_000; i++) {
      const answer = await t.call("scenes.get", { avatarId });
      if (answer.ok && record(answer.result.sceneSet)?.status === "ready") return;
      await t.settle();
      await t.quiesce();
    }
    throw new Error("the scene set never finished its write");
  });
}

/** The scenes of the avatar's set as the story reads them: text and the place the sentence is built from (the transcript summarises the set, so a story that wants the text says what it saw). */
async function scenesOf(t: Parameters<Scenario["run"]>[0], avatarId: string): Promise<{ sceneId: number; text: string | null; plain: string | null }[]> {
  const answers: Answer[] = [];
  await t.quiet(async () => {
    answers.push(await t.callLaunch("scenes.get", { avatarId }));
  });
  const answer = answers[0];
  const scenes = answer?.ok === true ? record(answer.result.sceneSet)?.scenes : undefined;
  if (!Array.isArray(scenes)) throw new Error("the avatar has no scene set to read");
  return scenes.flatMap((scene) => {
    const s = record(scene);
    const place = record(s?.place);
    if (s === null || typeof s.sceneId !== "number") return [];
    const plain =
      place !== null && typeof s.category === "string" && typeof place.location === "string" && typeof place.activity === "string" && typeof place.outfit === "string"
        ? plainSentence({ category: s.category, location: place.location, activity: place.activity, outfit: place.outfit, ...(typeof s.shot === "string" && (s.shot === "friend" || s.shot === "selfie" || s.shot === "mirror" || s.shot === "candid" || s.shot === "photographer") ? { shot: s.shot } : {}) })
        : null;
    return [{ sceneId: s.sceneId, text: typeof s.text === "string" ? s.text : null, plain }];
  });
}

export const PLAIN_FALLBACK_SCENARIOS: readonly Scenario[] = [
  {
    name: "scene writer (running launch): a compose whose writer is rejected twice writes the plain sentence for every scene — nothing is given up, and the set waits for the review",
    rig: { launch: true, llmOnlyFixture: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("the model's two answers for the chunk are rejected: no scene in either");
      control.launch.rejectWriter(2);
      const { launch } = await begin(t, w, { sceneReview: true, ...ON_THE_WRITER });
      await review(t, launch);
      t.note("every scene is written (its place, its moment and its outfit in a sentence of the code's own), no chunk is given up, and both rejected answers were paid for");
      const composed = await scenesOf(t, w.avatarId);
      t.note(`every scene reads the plain sentence of its place: ${String(composed.length > 0 && composed.every((s) => s.text !== null && s.text === s.plain))}`);
      await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "scene writer (running launch): a «Другая сцена» whose writer is rejected twice takes the plain sentence, and the write is done",
    rig: { launch: true, llmOnlyFixture: true },
    async run(t, w, control) {
      await control.musicTracks();
      const { launch } = await begin(t, w, { sceneReview: true, ...ON_THE_WRITER });
      await review(t, launch);
      t.note("«Стоп» gives the composed set back to the owner");
      await t.callLaunch("autopilot.stop", { launchId: launch });
      const set = await readSet(t, w.avatarId);
      const before = (await scenesOf(t, w.avatarId)).find((s) => s.sceneId === 2);
      t.note("the owner asks for another scene 2; the model's two answers are rejected");
      control.launch.rejectWriter(2);
      const sent = { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "rewrite", sceneIds: [2], redraw: false }, acceptedWorstMicros: ENOUGH };
      await t.callLaunch("scenes.write", sent, { written: { ...sent, revision: "<seen>" } });
      await untilSetReady(t, w.avatarId);
      const after = (await scenesOf(t, w.avatarId)).find((s) => s.sceneId === 2);
      t.note(`scene 2 changed: ${String(after?.text !== before?.text)}; it reads the plain sentence of its place: ${String(after?.text !== null && after?.text === after?.plain)}`);
      t.note(`the scene was not plain before the write: ${String(before?.text !== before?.plain)}`);
      await t.callLaunch("scenes.get", { avatarId: w.avatarId });
    },
  },
];
