import { begin, ENOUGH, holds, isDone, proceed, record, review } from "./scenarios.autopilotRun";
import type { Scenario } from "./scenarios";
import type { Answer } from "./transcript";

// Stage 5, S5.6e (APPENDED; the golden is append-only, plan s5a2 §5.7): what the code template changed in a scene set's money and timing, told against both engines. A built-in category
// («Дом») is composed by the template with no writer request since S5.6c1, so a launch on it spends nothing until its first photo, a «Другая сцена» costs nothing, and a refusal OpenRouter
// gives the next paid request lands on the first PHOTO. The stories that are about the compose WRITER (a fault or a hang there) plan from `cat-llm-only-fixture` instead (the dated list, in
// scenarios.autopilotRun.ts and the avatar scenarios); here the writer is still needed only where the template cannot write: a place no bank has.

const NOTHING = 0;

/** The scenes of the avatar's set as a story reads them, and the revision the set is at (each engine counts its own; the transcript writes `<seen>`). */
async function readSet(t: Parameters<Scenario["run"]>[0], avatarId: string): Promise<{ sceneSetId: string; revision: number }> {
  const answer = await t.callLaunch("scenes.get", { avatarId });
  const set = answer.ok ? record(answer.result.sceneSet) : null;
  if (set === null || typeof set.sceneSetId !== "string" || typeof set.revision !== "number") throw new Error("the avatar has no scene set to read");
  return { sceneSetId: set.sceneSetId, revision: set.revision };
}

/** Lets the avatar's scene set finish its job (a write is a job; the real engine ends it in its own time, the mock on its clock), without writing what it takes. */
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

export const TEMPLATE_SCENE_SCENARIOS: readonly Scenario[] = [
  {
    name: "template launch (running): OpenRouter's 402 and 401 meet the first PHOTO, not a compose that sends no request; «Продолжить» clears the one and a new key the other",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("a launch on «Дом» composes by the template (no request), so the 402 the fake OpenRouter gives the next paid request is met by the first photo");
      control.launch.fault("credits");
      const paid = await begin(t, w);
      await t.untilLaunch(paid.launch, "the credits hold", holds("credits"));
      await t.callLaunch("autopilot.get", { launchId: paid.launch });
      await t.callLaunch("autopilot.resume", { launchId: paid.launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      await t.untilLaunch(paid.launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: paid.launch });
      t.note("the same for the 401 (another avatar: the first launch's composed set is its owner's open set now)");
      control.launch.fault("key");
      const key = await begin(t, w, { avatarIds: [w.otherAvatarId] });
      await t.untilLaunch(key.launch, "the key hold", holds("key"));
      await t.callLaunch("autopilot.get", { launchId: key.launch });
      await t.callLaunch("autopilot.resume", { launchId: key.launch, acceptedRemainingMicros: ENOUGH });
      await control.launch.newKey();
      await t.callLaunch("autopilot.resume", { launchId: key.launch, acceptedRemainingMicros: ENOUGH }, { brief: true });
      await t.untilLaunch(key.launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: key.launch });
    },
  },
  {
    name: "template launch (running): a compose and a run on «Дом» write every scene at once with nothing spent, wait for the review, and draw to done",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const { launch } = await begin(t, w, { sceneReview: true });
      const row = await review(t, launch);
      t.note("the scenes wait for the owner: composed by the template, so every scene is written and the launch has spent nothing");
      await t.callLaunch("autopilot.get", { launchId: launch });
      await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      t.note("the owner continues: the draw starts and the launch is paid for its photos only");
      await proceed(t, launch, row, {}, true);
      await t.untilLaunch(launch, "done", isDone);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "template scenes: «Другая сцена» on a scene the template writes costs nothing, with a redraw or without one, and the set stays written",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const { launch } = await begin(t, w, { sceneReview: true });
      await review(t, launch);
      t.note("«Стоп» gives the composed set back to the owner");
      await t.callLaunch("autopilot.stop", { launchId: launch });
      for (const redraw of [false, true]) {
        const set = await readSet(t, w.avatarId);
        t.note(`the owner accepts a worst case of nothing for ${redraw ? "a redraw" : "«Другая сцена»"} of scene 2: the code template writes the new scene, so it is not refused`);
        const sent = { sceneSetId: set.sceneSetId, revision: set.revision, target: { kind: "rewrite", sceneIds: [2], redraw }, acceptedWorstMicros: NOTHING };
        await t.callLaunch("scenes.write", sent, { written: { ...sent, revision: "<seen>" } });
        await untilSetReady(t, w.avatarId);
      }
      await t.callLaunch("scenes.get", { avatarId: w.avatarId });
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "template launch (running): a frame whose face is hidden is marked, not retried — the launch ends done with a photo for every slot, the hidden ones kept at their low likeness",
    rig: { launch: true, faceMarks: true },
    async run(t, w, control) {
      await control.musicTracks();
      const listed = async (): Promise<{ photoId: string; faceCos: number | null }[]> => {
        const answers: Answer[] = [];
        await t.quiet(async () => {
          answers.push(await t.callLaunch("photos.list", { avatarId: w.avatarId }));
        });
        const answer = answers[0];
        const photos = answer?.ok === true && Array.isArray(answer.result.photos) ? answer.result.photos : [];
        return photos.flatMap((photo) => {
          const p = record(photo);
          if (p === null || typeof p.photoId !== "string") return [];
          return [{ photoId: p.photoId, faceCos: typeof record(p.qa)?.faceCos === "number" ? Number(record(p.qa)?.faceCos) : null }];
        });
      };
      const before = new Set((await listed()).map((p) => p.photoId));
      t.note("10 photos of «Дом» (two slides videos): the deck deals the captures in cycles of twelve, and four of every twelve hold the phone over her face");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "done", isDone);
      const drawn = (await listed()).filter((p) => !before.has(p.photoId));
      const marked = drawn.filter((p) => p.faceCos !== null && p.faceCos < 0.55).length;
      // Which slots are dealt a hidden face is each engine's own (the engine's deck is shuffled within a cycle, the mock's runs in order), so the story is bound to what is the contract's: the launch drew
      // one photo for every slot with its likeness stored, and some are marked below the threshold (at most the four a cycle holds) while the launch still ends done. A frame the gate sent back for another
      // paid attempt would not have passed at that likeness, so a marked photo that is there is one that was not retried.
      t.note(`the launch drew ${drawn.length} photos, each with its likeness stored: ${String(drawn.every((p) => p.faceCos !== null))}`);
      t.note(`some frames are marked below the 0.55 threshold, and not all of them, at most the four a cycle holds: ${String(marked > 0 && marked < drawn.length && marked <= 4)}`);
      await t.callLaunch("autopilot.get", { launchId: launch });
    },
  },
  {
    name: "template launch (running): paused and stopped after its photos were paid for, the launch reads that it spent something, though its compose cost nothing",
    rig: { launch: true },
    async run(t, w) {
      t.note("no track is stored: the photos are bought and drawn, and the videos wait for music while the launch runs");
      const { launch } = await begin(t, w);
      await t.untilLaunch(launch, "the videos wait for music", (l) => Number(l.waitingMusic) === 2);
      t.note("paused with nothing in flight: it reads spent, the photos having been paid for");
      await t.callLaunch("autopilot.pause", { launchId: launch });
      await t.callLaunch("autopilot.get", { launchId: launch });
      t.note("stopped from the pause: still spent");
      await t.callLaunch("autopilot.stop", { launchId: launch });
      await t.callLaunch("autopilot.get", { launchId: launch });
      await t.callLaunch("autopilot.list", {});
    },
  },
  {
    name: "scene sets, old pool: a set whose places no bank has still waits for the writer — «Дописать» and a rewrite of its scene are priced, so a worst case of nothing is refused",
    rig: { sceneSets: true },
    async run(t, w) {
      t.note("a set a closed Studio left: «a sunny kitchen» and its sisters are not places of the banks, so the code template cannot write them");
      await t.call("scenes.get", { avatarId: w.avatarId });
      const nothing = { sceneSetId: "set-parity-0001", revision: 1, acceptedWorstMicros: NOTHING };
      t.note("«Дописать» asks the model for the two waiting scenes: it is priced, and nothing is not enough");
      await t.call("scenes.write", { ...nothing, target: { kind: "unwritten" } });
      t.note("a rewrite without a redraw of such a scene is the model's too");
      await t.call("scenes.write", { ...nothing, target: { kind: "rewrite", sceneIds: [2], redraw: false } });
      await t.call("scenes.get", { avatarId: w.avatarId });
    },
  },
];
