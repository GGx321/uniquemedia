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
  // Stage 5, 5a.3, S5.9a (APPENDED; the golden is append-only, plan s5a3 §12): «Смелая» on the contract, before the two «Смелая» categories exist.
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4 #1, Q-P): the owner asked for «Смелая» on every category, so a bold compose over «Дом» holds the 40 / 40 / 20 mix, 4 flirty and 4 bold, every scene on the
  // Seedream route. The name below tells the pre-5a.4 rule and is kept byte for byte, so the key does not move and its diff stays inside it; this scenario's successor is story 1 of
  // scenarios.boldAny.ts (S5.BA7). The first compose's notes are the ones that changed; the «Кокетливая» compose and the previews are as they were.
  {
    name: "scene sets, «Смелая» (S5.9a): a bold compose over «Дом» alone holds the flirty counts of «Кокетливая», the set echoes the level it was asked at, and a bold draft is previewed",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      /** The avatar's set once its write has settled, read quietly: the transcript tells the facts below as notes (which scene is which is each engine's own deal). */
      const settled = async (): Promise<{ set: Record<string, unknown>; scenes: Record<string, unknown>[] }> => {
        const scenes: Record<string, unknown>[] = [];
        const sets: Record<string, unknown>[] = [];
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
              sets.push(set);
              return;
            }
            await t.settle();
            await t.quiesce();
          }
          throw new Error("the scene set never finished its write");
        });
        const [set] = sets;
        if (set === undefined) throw new Error("the avatar has no scene set to read");
        return { set, scenes };
      };
      const facts = (read: { set: Record<string, unknown>; scenes: Record<string, unknown>[] }, onRoute = false): void => {
        t.note(`the set holds ${read.scenes.length} scenes, ${read.scenes.filter((s) => s.level === "flirty").length} of them flirty and ${read.scenes.filter((s) => s.level === "bold").length} bold`);
        // 5a.4 (S5.BA3): a bold compose over «Дом» draws every scene on the route; the «Кокетливая» compose below still draws none, and says it as it always did.
        t.note(onRoute ? `every scene is drawn on the Seedream route: ${String(read.scenes.every((s) => s.route === "seedream"))}` : `no scene is drawn on the Seedream route yet: ${String(read.scenes.every((s) => !("route" in s)))}`);
        t.note(`the set echoes its level: ${String(read.set.level)}`);
      };
      t.note("a bold compose of 10 scenes of «Дом»: «Смелая» is every category's, so it holds the 40 / 40 / 20 mix, 4 flirty and 4 bold, every scene on the route");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 10, categories: ["home"], level: "bold", acceptedWorstMicros: ENOUGH });
      facts(await settled(), true);
      const found = await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      const sceneSetId = found.ok ? record(found.result.sceneSet)?.sceneSetId : undefined;
      if (typeof sceneSetId !== "string") throw new Error("the avatar has no scene set to discard");
      await t.callLaunch("scenes.discard", { sceneSetId });
      t.note("the same compose flirty: the same counts");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 10, categories: ["home"], level: "flirty", acceptedWorstMicros: ENOUGH });
      facts(await settled());
      // 5a.4 (S5.BA5, 2026-10-26, plan s5a4 I5.77, BA3 review H-1 and L-2): a draft at «Смелая» plans what a flirty one plans, but every photo it draws is on the Seedream route, so the engine
      // prices it at the bold unit (the transcript writes no price). The note said «previewed like a flirty one», true of the price before 5a.4 only; the key's one granted second flip.
      t.note("a bold draft plans like a flirty one and prices every photo on the route");
      const flirtyFound = await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      const flirtySetId = flirtyFound.ok ? record(flirtyFound.result.sceneSet)?.sceneSetId : undefined;
      if (typeof flirtySetId !== "string") throw new Error("the avatar has no scene set to discard");
      await t.callLaunch("scenes.discard", { sceneSetId: flirtySetId });
      const draft = { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], library: false, generate: true, sceneReview: false, stickers: false, planSeed: 4_242 };
      await t.call("autopilot.estimate", { draft: { ...draft, level: "flirty" } });
      await t.call("autopilot.estimate", { draft: { ...draft, level: "bold" } });
    },
  },
  // Stage 5, 5a.3, S5.9c (APPENDED; the golden is append-only, plan s5a3 §12): the two «Смелая» categories under «Смелая». Counts and rules only: which scene is which, and what it wears, is each
  // engine's own deal (the mock keeps its own dealing), but the 20 / 40 / 40 mix, the routes' rule, the level a redraw keeps and the free refusal are facts both engines tell.
  {
    name: "scene sets, «Смелая» categories (S5.9c): a bold compose of «Ночнушки и бельё» and «Пляж и бассейн» holds the 20 / 40 / 40 mix of each, «Другая сцена» keeps a scene's level for nothing, and a «Смелая» category below «Смелая» is refused for free",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      /** The avatar's set once its write has settled, read quietly: the transcript tells the facts below as notes. */
      const settled = async (): Promise<{ set: Record<string, unknown>; scenes: Record<string, unknown>[] }> => {
        const scenes: Record<string, unknown>[] = [];
        const sets: Record<string, unknown>[] = [];
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
              sets.push(set);
              return;
            }
            await t.settle();
            await t.quiesce();
          }
          throw new Error("the scene set never finished its write");
        });
        const [set] = sets;
        if (set === undefined) throw new Error("the avatar has no scene set to read");
        return { set, scenes };
      };
      const levelOf = (scene: Record<string, unknown>): string => (typeof scene.level === "string" ? scene.level : "ordinary");
      const counts = (scenes: readonly Record<string, unknown>[], category: string): string => {
        const own = scenes.filter((s) => s.category === category);
        return `${category}: ${own.length} scenes, ${own.filter((s) => levelOf(s) === "bold").length} bold, ${own.filter((s) => levelOf(s) === "flirty").length} flirty, ${own.filter((s) => levelOf(s) === "ordinary").length} ordinary`;
      };
      t.note("a bold compose of 20 scenes over «Ночнушки и бельё» and «Пляж и бассейн»: 10 each, 4 bold, 4 flirty and 2 ordinary in each");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 20, categories: ["nightwear", "beach"], level: "bold", acceptedWorstMicros: ENOUGH });
      const first = await settled();
      t.note(counts(first.scenes, "nightwear"));
      t.note(counts(first.scenes, "beach"));
      t.note(`every scene is written: ${String(first.scenes.every((s) => typeof s.text === "string"))}`);
      t.note(`every beach scene is drawn on the Seedream route: ${String(first.scenes.filter((s) => s.category === "beach").every((s) => s.route === "seedream"))}`);
      t.note(`no ordinary scene of the nightwear is: ${String(first.scenes.filter((s) => s.category === "nightwear" && levelOf(s) === "ordinary").every((s) => !("route" in s)))}`);
      t.note(`the set echoes its level: ${String(first.set.level)}`);
      t.note("«Другая сцена» on the first five scenes, with a worst case of nothing: the code template writes them, and each keeps its level");
      const before = first.scenes.slice(0, 5).map(levelOf);
      const sent = { sceneSetId: first.set.sceneSetId, revision: first.set.revision, target: { kind: "rewrite", sceneIds: [1, 2, 3, 4, 5], redraw: true }, acceptedWorstMicros: NOTHING };
      await t.callLaunch("scenes.write", sent, { written: { ...sent, revision: "<seen>" } });
      const second = await settled();
      t.note(`the five keep their levels: ${String(second.scenes.slice(0, 5).map(levelOf).join() === before.join())}`);
      t.note(`the set still holds the mix: ${counts(second.scenes, "nightwear")}`);
      const sceneSetId = second.set.sceneSetId;
      if (typeof sceneSetId !== "string") throw new Error("the avatar has no scene set to discard");
      await t.callLaunch("scenes.discard", { sceneSetId });
      t.note("a «Смелая» category below «Смелая» is refused for free, whatever the command: nothing is composed, priced or started");
      const below = { avatarId: w.avatarId, count: 10, categories: ["nightwear"], level: "flirty" };
      await t.call("scenes.estimateCompose", below);
      await t.call("scenes.compose", { ...below, acceptedWorstMicros: NOTHING });
      await t.call("runs.estimate", { ...below, count: 5 });
      await t.call("runs.start", { ...below, count: 5, acceptedWorstMicros: NOTHING });
      const draft = { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["nightwear"], library: false, generate: true, sceneReview: false, stickers: false, planSeed: 4_242 };
      await t.call("autopilot.estimate", { draft });
      await t.call("autopilot.start", { draft, acceptedWorstMicros: NOTHING });
      // No preview of a «Смелая» launch is told here: its price is S5.9d's (option B), and an appended story must not move when that lands.
    },
  },
];
