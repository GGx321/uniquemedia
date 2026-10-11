import { ENOUGH, isDone, record } from "./scenarios.autopilotRun";
import type { Scenario } from "./scenarios";
import type { Answer } from "./transcript";

// Stage 5, S5.7a (APPENDED; the golden is append-only, plan s5a2 §6.4): the additive contract of «Подача» and the face gate's mark, told against both engines.
//
// - `level` joins a scene set's compose and a launch's settings, and `poses` stops being required. A request in the old shape is still answered as it was; a request in the new shape
//   is answered the same way, the set echoes its `poses` only when it was sent and its `level` only when it is flirty, and until S5.7b draws the mix a flirty level changes no plan.
// - `qa.faceMarked` rides on a photo the face gate marked (a face-hidden frame), so the window and the autopilot need not guess it from the likeness.

const NOTHING = 0;

/** What a story reads of the avatar's open set, quietly: the transcript summarises a set, so the echoes are told as notes. */
async function setOf(t: Parameters<Scenario["run"]>[0], avatarId: string): Promise<Record<string, unknown>> {
  const answers: Answer[] = [];
  await t.quiet(async () => {
    answers.push(await t.call("scenes.get", { avatarId }));
  });
  const answer = answers[0];
  const set = answer?.ok === true ? record(answer.result.sceneSet) : null;
  if (set === null) throw new Error("the avatar has no scene set to read");
  return set;
}

export const PRESENTATION_SCENARIOS: readonly Scenario[] = [
  {
    name: "scene sets, presentation (S5.7a): a compose with the old poses, with none and with a flirty level is accepted — the set echoes poses only when sent and the level only when flirty",
    rig: { sceneSets: true },
    async run(t, w) {
      t.note("the avatar's open set goes first: an empty compose is free, and each one below is the avatar's only set");
      await t.call("scenes.discard", { sceneSetId: "set-parity-0001" });
      t.note("the old shape, with the poses a window of the last build sends: the set echoes them and no level");
      await t.call("scenes.compose", { avatarId: w.avatarId, count: 0, categories: [], poses: { profile: false, back: true }, acceptedWorstMicros: NOTHING });
      const old = await setOf(t, w.avatarId);
      t.note(`the set echoes its poses: ${JSON.stringify(old.poses)}; and no level: ${String(!("level" in old))}`);
      await t.call("scenes.discard", { sceneSetId: String(old.sceneSetId) });
      t.note("the new shape, with no poses and a flirty level: the set echoes the level and no poses");
      await t.call("scenes.compose", { avatarId: w.avatarId, count: 0, categories: [], level: "flirty", acceptedWorstMicros: NOTHING });
      const flirty = await setOf(t, w.avatarId);
      t.note(`the set echoes no poses: ${String(!("poses" in flirty))}; and its level: ${String(flirty.level)}`);
      await t.call("scenes.discard", { sceneSetId: String(flirty.sceneSetId) });
      t.note("an ordinary level asked for by name is the absence of one: the set echoes neither");
      await t.call("scenes.compose", { avatarId: w.avatarId, count: 0, categories: [], level: "ordinary", acceptedWorstMicros: NOTHING });
      const ordinary = await setOf(t, w.avatarId);
      t.note(`the set echoes no poses: ${String(!("poses" in ordinary))}; and no level: ${String(!("level" in ordinary))}`);
    },
  },
  {
    name: "launch settings, presentation (S5.7a): the preview of a draft with the old poses, with none and with a flirty level is the same plan, and a flirty launch with no poses runs to done",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const settings = { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], library: false, generate: true, sceneReview: false, stickers: false };
      const draft = { ...settings, planSeed: 4_242 };
      t.note("the draft a window of the last build sends, with its poses");
      await t.call("autopilot.estimate", { draft: { ...draft, poses: { profile: false, back: false } } });
      t.note("the draft of this build: no poses, and a flirty level changes no figure of the plan");
      await t.call("autopilot.estimate", { draft });
      await t.call("autopilot.estimate", { draft: { ...draft, level: "flirty" } });
      t.note("the flirty launch starts, composes and draws with no poses, and ends done");
      const started = await t.callLaunch("autopilot.start", { draft: { ...draft, level: "flirty" }, acceptedWorstMicros: ENOUGH });
      const launchId = started.ok ? record(started.result.launch)?.launchId : undefined;
      if (typeof launchId !== "string") throw new Error("the launch did not start");
      await t.untilLaunch(launchId, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId });
    },
  },
  {
    name: "template launch (running), the face gate's mark (S5.7a): every frame the gate marked carries the flag and no judged frame does, and the marked frames are the ones under the line",
    rig: { launch: true, faceMarks: true },
    async run(t, w, control) {
      await control.musicTracks();
      const listed = async (): Promise<{ photoId: string; faceCos: number | null; marked: boolean }[]> => {
        const answers: Answer[] = [];
        await t.quiet(async () => {
          answers.push(await t.callLaunch("photos.list", { avatarId: w.avatarId }));
        });
        const answer = answers[0];
        const photos = answer?.ok === true && Array.isArray(answer.result.photos) ? answer.result.photos : [];
        return photos.flatMap((photo) => {
          const p = record(photo);
          if (p === null || typeof p.photoId !== "string") return [];
          const qa = record(p.qa);
          return [{ photoId: p.photoId, faceCos: typeof qa?.faceCos === "number" ? qa.faceCos : null, marked: qa?.faceMarked === true }];
        });
      };
      const before = new Set((await listed()).map((p) => p.photoId));
      t.note("10 photos of «Дом»: some frames hold the phone over her face, and the gate marks them instead of judging them");
      const started = await t.callLaunch("autopilot.start", {
        draft: { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], library: false, generate: true, sceneReview: false, stickers: false, planSeed: 4_242 },
        acceptedWorstMicros: ENOUGH,
      });
      const launchId = started.ok ? record(started.result.launch)?.launchId : undefined;
      if (typeof launchId !== "string") throw new Error("the launch did not start");
      await t.untilLaunch(launchId, "done", isDone);
      const drawn = (await listed()).filter((p) => !before.has(p.photoId));
      const marked = drawn.filter((p) => p.marked);
      // Which slots are dealt a hidden face is each engine's own (the engine's deck is shuffled within a cycle, the mock's runs in order), so the story is bound to what is the contract's: the flag
      // sits on exactly the frames the gate marked (the ones kept below the 0.55 line), some but not all of the frames, and a judged frame carries none.
      t.note(`some frames are marked, and not all of them: ${String(marked.length > 0 && marked.length < drawn.length)}`);
      t.note(`every marked frame keeps its likeness under the 0.55 line: ${String(marked.every((p) => p.faceCos !== null && p.faceCos < 0.55))}`);
      t.note(`no judged frame carries the flag, and every frame under the line is marked: ${String(drawn.every((p) => p.marked === (p.faceCos !== null && p.faceCos < 0.55)))}`);
    },
  },
];
