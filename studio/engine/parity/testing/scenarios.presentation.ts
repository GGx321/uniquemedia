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
  {
    name: "scene sets, «Подача» and the angle from the scene (S5.7b): a flirty compose holds exactly round(0.6 × n) flirty scenes, a category faces away in at most a fifth of its scenes and never on a hand-held capture",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const HAND = new Set(["mirror-hidden", "mirror", "above", "prone", "over-shoulder", "selfie"]);
      /** The avatar's set once its write has settled, read quietly: the transcript tells the facts below as notes (which scene is which is each engine's own deal). */
      const settled = async (): Promise<Record<string, unknown>[]> => {
        const scenes: Record<string, unknown>[] = [];
        await t.quiet(async () => {
          for (let i = 0; i < 2_000; i++) {
            const answer = await t.call("scenes.get", { avatarId: w.avatarId });
            const set = answer.ok ? record(answer.result.sceneSet) : null;
            if (set !== null && set.status === "ready") {
              const listed: unknown[] = Array.isArray(set.scenes) ? set.scenes : [];
              for (const scene of listed) {
                const row = record(scene);
                if (row !== null) scenes.push(row);
              }
              return;
            }
            await t.settle();
            await t.quiesce();
          }
          throw new Error("the scene set never finished its write");
        });
        return scenes;
      };
      const facts = (scenes: readonly Record<string, unknown>[]): void => {
        const away = scenes.filter((s) => s.pose === "profile" || s.pose === "back");
        t.note(`the set holds ${scenes.length} scenes, ${scenes.filter((s) => s.level === "flirty").length} of them flirty`);
        t.note(`at most a fifth of the scenes face away: ${String(away.length <= Math.floor(scenes.length / 5))}`);
        t.note(`no scene on a hand-held capture faces away: ${String(away.every((s) => !HAND.has(String(s.capture ?? s.shot))))}`);
      };
      t.note("a flirty compose of 10 scenes of «Дом», with the poses a window of the last build sends (the angle comes from the scene, so they are ignored)");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 10, categories: ["home"], level: "flirty", poses: { profile: true, back: true }, acceptedWorstMicros: ENOUGH });
      const flirty = await settled();
      facts(flirty);
      t.note("the same compose ordinary: no scene is flirty");
      const found = await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      const sceneSetId = found.ok ? record(found.result.sceneSet)?.sceneSetId : undefined;
      if (typeof sceneSetId !== "string") throw new Error("the avatar has no scene set to discard");
      await t.callLaunch("scenes.discard", { sceneSetId });
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 10, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: ENOUGH });
      const ordinary = await settled();
      facts(ordinary);
    },
  },
  {
    name: "scene sets, «Ножки» (S5.8a): a compose holds exactly min(round-half-up(share × B), ⌊0.3 × count⌋) legs scenes of the built-in banks, an ordinary compose none, and a request for legs with no built-in category is refused for free",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      /** The avatar's set once its write has settled, read quietly: the transcript tells the facts below as notes (which scene is which is each engine's own deal). */
      const settled = async (): Promise<Record<string, unknown>[]> => {
        const scenes: Record<string, unknown>[] = [];
        await t.quiet(async () => {
          for (let i = 0; i < 2_000; i++) {
            const answer = await t.call("scenes.get", { avatarId: w.avatarId });
            const set = answer.ok ? record(answer.result.sceneSet) : null;
            if (set !== null && set.status === "ready") {
              const listed: unknown[] = Array.isArray(set.scenes) ? set.scenes : [];
              for (const scene of listed) {
                const row = record(scene);
                if (row !== null) scenes.push(row);
              }
              return;
            }
            await t.settle();
            await t.quiesce();
          }
          throw new Error("the scene set never finished its write");
        });
        return scenes;
      };
      const LEGS_CAPTURES = new Set(["pov-legs", "low-feet"]);
      const facts = (scenes: readonly Record<string, unknown>[]): void => {
        const legs = scenes.filter((s) => s.framing === "legs");
        t.note(`the set holds ${scenes.length} scenes, ${legs.length} of them legs scenes`);
        t.note(`every legs scene names its capture: ${String(legs.every((s) => typeof s.capture === "string"))}`);
        t.note(`at home she shoots herself: no legs scene is a friend's low photo: ${String(legs.every((s) => s.category !== "home" || s.capture !== "low-feet"))}`);
        t.note(`only a legs scene is shot as legs: ${String(scenes.every((s) => s.framing === "legs" || !LEGS_CAPTURES.has(String(s.capture))))}`);
      };
      t.note("a compose of 10 scenes of «Дом» with 30 % legs: 3 of the 10, the cap of 30 % of the run being 3");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 10, categories: ["home"], legsShare: 30, acceptedWorstMicros: ENOUGH });
      facts(await settled());
      const found = await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      const sceneSetId = found.ok ? record(found.result.sceneSet)?.sceneSetId : undefined;
      if (typeof sceneSetId !== "string") throw new Error("the avatar has no scene set to discard");
      await t.callLaunch("scenes.discard", { sceneSetId });
      t.note("the same compose with no legs: none of its scenes is a legs scene");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 10, categories: ["home"], acceptedWorstMicros: ENOUGH });
      facts(await settled());
      t.note("legs asked for with only a custom category are refused for free, whatever the command: nothing is composed, priced or started");
      const custom = { avatarId: w.avatarId, count: 10, categories: ["cat-paris-cafes"], legsShare: 15 };
      await t.call("scenes.estimateCompose", custom);
      await t.call("scenes.compose", { ...custom, acceptedWorstMicros: NOTHING });
      await t.call("runs.estimate", { ...custom, count: 5 });
      await t.call("autopilot.estimate", { draft: { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["cat-paris-cafes"], legsShare: 15, library: false, generate: true, sceneReview: false, stickers: false } });
    },
  },
];
