import type { Scenario } from "./scenarios";

// Stage 5, S5.0c (APPENDED; the golden is append-only): the descriptor-vs-master check, `avatars.estimateCheckDescriptor` (free) and `avatars.checkDescriptor` (paid, never writes),
// told against both engines. The rig scripts no chat, so only the FREE commands and the free refusals of the paid one are played: the price (as facts, each engine's own figures
// are not compared), the refusals that come before any spend (an unknown avatar, a worst case below the price, a payload the contract refuses) and the claim a running autopilot
// launch holds on the avatar. A check that runs (the verdict, the money flow, `descriptorCheck` of an import, never writing) is held by the engine's own tests
// (engine.checkDescriptor, engine.avatarsImport) and the mock's (mockEngine.checkDescriptor).

type Telling = Parameters<Scenario["run"]>[0];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

async function launchAvatar(t: Telling, avatarId: string, control: Parameters<Scenario["run"]>[2]): Promise<string> {
  control.launch.hangWriter();
  const started = await t.callLaunch("autopilot.start", {
    draft: {
      avatarIds: [avatarId],
      videosPerAvatar: 2,
      mix: { single: 0, collage: 0, slides: 100 },
      categories: ["home"],
      poses: { profile: false, back: false },
      library: false,
      generate: true,
      sceneReview: true,
      stickers: false,
      planSeed: 4_242,
    },
    acceptedWorstMicros: 10_000_000,
  });
  const launchId = started.ok ? record(started.result.launch)?.launchId : undefined;
  if (typeof launchId !== "string") throw new Error("the launch did not start");
  await t.untilLaunch(launchId, "a request in flight", (l) => Number(record(l.inFlight)?.requests) > 0);
  return launchId;
}

export const AVATAR_CHECK_SCENARIOS: readonly Scenario[] = [
  {
    name: "checkDescriptor: the check is priced for a saved avatar, an archived one and not for an unknown one, and a payload the contract refuses is VALIDATION",
    async run(t, w) {
      t.note("a price for a saved avatar and for an archived one, written as facts");
      await t.call("avatars.estimateCheckDescriptor", { avatarId: w.avatarId });
      await t.call("avatars.estimateCheckDescriptor", { avatarId: w.archivedAvatarId });
      t.note("an avatar the library does not have");
      await t.call("avatars.estimateCheckDescriptor", { avatarId: "avatar-nobody-1" });
      t.note("a payload with a stray field");
      await t.call("avatars.estimateCheckDescriptor", { avatarId: w.avatarId, acceptedWorstMicros: 1 });
    },
  },
  {
    name: "checkDescriptor: the refusals that come before any spend are free, in the engine's order",
    async run(t, w) {
      t.note("an avatar the library does not have");
      await t.call("avatars.checkDescriptor", { avatarId: "avatar-nobody-1", acceptedWorstMicros: 10_000_000 });
      t.note("a worst case below the check's price: the owner must see the price again");
      await t.call("avatars.checkDescriptor", { avatarId: w.avatarId, acceptedWorstMicros: 1 });
      await t.call("avatars.checkDescriptor", { avatarId: w.archivedAvatarId, acceptedWorstMicros: 1 });
      t.note("a payload without the accepted worst case, and one with a stray field");
      await t.call("avatars.checkDescriptor", { avatarId: w.avatarId });
      await t.call("avatars.checkDescriptor", { avatarId: w.avatarId, acceptedWorstMicros: 10_000_000, apply: true });
      t.note("none of it changed the avatars");
      await t.call("avatars.list", {});
    },
  },
  {
    name: "checkDescriptor: a check is refused while an autopilot launch holds the avatar, and the launch goes on",
    rig: { launch: true },
    async run(t, w, control) {
      const launchId = await launchAvatar(t, w.avatarId, control);
      t.note("the launch's writer is out and the launch holds the avatar: a check of its description is refused");
      await t.callLaunch("avatars.checkDescriptor", { avatarId: w.avatarId, acceptedWorstMicros: 10_000_000 });
      t.note("another avatar is not held");
      await t.callLaunch("avatars.checkDescriptor", { avatarId: w.otherAvatarId, acceptedWorstMicros: 1 });
      const after = await t.callLaunch("autopilot.get", { launchId }, { brief: true });
      t.note(`the launch is still ${String(record(after.ok ? after.result.launch : null)?.status)}`);
      await control.launch.quit();
    },
  },
  // Stage 5, S5.2b (APPENDED): the body proposal a photo import leaves on the avatar. The import itself needs the OS picker and a vision answer, which the rig does not script; its
  // reader, its storage in the avatar's own write and the mock's proposal are held by engine.avatarsImport, importDescribe and mockEngine.body. Played here: what the proposal does NOT do.
  {
    name: "importBodyProposal: a check of an avatar that holds the import's body proposal is priced and refused like any other, and leaves the proposal alone",
    rig: { bodyProposal: true },
    async run(t, w) {
      t.note("the avatar holds the body a photo import read");
      await t.call("avatars.list", {});
      await t.call("avatars.estimateCheckDescriptor", { avatarId: w.avatarId });
      t.note("a worst case below the check's price is refused before any spend");
      await t.call("avatars.checkDescriptor", { avatarId: w.avatarId, acceptedWorstMicros: 1 });
      t.note("nothing was spent or written: the proposal is still there, and still not a trait");
      await t.call("avatars.list", {});
    },
  },
  {
    name: "importBodyProposal: saving the proposal's own values («Сохранить тело») makes them the body and takes the proposal away",
    rig: { bodyProposal: true },
    async run(t, w) {
      await t.call("avatars.list", {});
      t.note("the owner saves exactly what the photo showed");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { bust: "full" } });
      t.note("the proposal is gone, so a dismiss has nothing left to clear");
      await t.call("avatars.dismissBodyProposal", { avatarId: w.avatarId });
      await t.call("avatars.list", {});
    },
  },
];
