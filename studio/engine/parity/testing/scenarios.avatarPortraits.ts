import type { Scenario } from "./scenarios";
import type { PortraitAvatars } from "./rigs";
import type { Answer } from "./transcript";

// Stage 5, S5.3c (APPENDED; the golden is append-only): the reference portrait of an IMPORTED avatar, told against both engines. A rig with `portraits` seeds three imported avatars
// (Nini with no portrait, Ava with three pending, Lena with eleven) and runs a batch by the mock's outcome table: three portraits (0.76, 0.72, 0.61), one not hers (0.48), one the model
// refuses. The price is written as facts (each engine's own figures are not compared); the batch, the list it leaves, the pick and the discard are compared line for line.
// A batch's money and the refusals that need a key, a ledger, a face gate or a source with no face are held by the engines' own tests (engine.portraits, engine.portraits.generate,
// mockEngine.portraits); see `INTENTIONAL_DIFFERENCES`.

type Telling = Parameters<Scenario["run"]>[0];
type World = Parameters<Scenario["run"]>[1];

function portraitsOf(world: World): PortraitAvatars {
  if (world.portraitAvatars === undefined) throw new Error("the rig has no portrait avatars: the story needs `rig: { portraits: true }`");
  return world.portraitAvatars;
}

/** The ids of the pending portraits an `avatars.portraits` answer lists, best first. */
function pendingOf(answer: Answer): string[] {
  if (!answer.ok) throw new Error(`the story expected ok, got ${answer.error.code}`);
  const candidates = answer.result.candidates;
  if (!Array.isArray(candidates)) throw new Error("expected a list of candidates");
  return candidates.map((c: unknown) => {
    const photoId = typeof c === "object" && c !== null ? Object.fromEntries(Object.entries(c)).photoId : undefined;
    if (typeof photoId !== "string") throw new Error("expected a candidate with a photo id");
    return photoId;
  });
}

function sourceOf(answer: Answer): string {
  if (!answer.ok) throw new Error(`the story expected ok, got ${answer.error.code}`);
  const source = answer.result.sourcePhotoId;
  if (typeof source !== "string") throw new Error("expected a source photo");
  return source;
}

function must(photoId: string | undefined): string {
  if (photoId === undefined) throw new Error("the story expected one more portrait");
  return photoId;
}

async function draw(t: Telling, avatarId: string): Promise<void> {
  await t.call("avatars.generatePortraits", { avatarId, acceptedWorstMicros: 10_000_000 });
  t.note("the batch runs to its end: five slots, three portraits, one not hers, one refused");
  await t.settle();
}

export const AVATAR_PORTRAIT_SCENARIOS: readonly Scenario[] = [
  // P1
  {
    name: "portraits: the batch is priced for any avatar with the age check off and on, and a payload the contract refuses is VALIDATION",
    rig: { portraits: true },
    async run(t) {
      t.note("the age check is off: five images with a reference, a flat price");
      await t.call("settings.setImageAgeCheck", { imageAgeCheck: "off" });
      await t.call("avatars.estimatePortraits", {});
      t.note("the age check is on: five age checks join the worst case");
      await t.call("settings.setImageAgeCheck", { imageAgeCheck: "on" });
      await t.call("avatars.estimatePortraits", {});
      t.note("a payload with a stray field");
      await t.call("avatars.estimatePortraits", { avatarId: "avatar-nobody-1" });
    },
  },
  // P2
  {
    name: "portraits: the refusals that come before any spend are free, in the engine's order",
    rig: { portraits: true },
    async run(t, w) {
      const { imported, crowded, pending } = portraitsOf(w);
      t.note("an avatar the library does not have, and a retired one");
      await t.call("avatars.generatePortraits", { avatarId: "avatar-nobody-1", acceptedWorstMicros: 10_000_000 });
      await t.call("avatars.generatePortraits", { avatarId: w.archivedAvatarId, acceptedWorstMicros: 10_000_000 });
      t.note("an avatar that was not imported has no photo to draw from");
      await t.call("avatars.generatePortraits", { avatarId: w.avatarId, acceptedWorstMicros: 10_000_000 });
      t.note("eleven pending portraits: a batch of five would pass the limit of fifteen");
      await t.call("avatars.generatePortraits", { avatarId: crowded, acceptedWorstMicros: 10_000_000 });
      t.note("a worst case below the price: the owner must see the price again");
      await t.call("avatars.generatePortraits", { avatarId: imported, acceptedWorstMicros: 1 });
      t.note("a payload without the accepted worst case, and one with a stray field");
      await t.call("avatars.generatePortraits", { avatarId: imported });
      await t.call("avatars.generatePortraits", { avatarId: imported, acceptedWorstMicros: 10_000_000, count: 9 });
      t.note("the pick and the discard: a retired avatar is not found, an avatar that was not imported has no portraits to pick");
      await t.call("avatars.pickPortrait", { avatarId: w.archivedAvatarId, photoId: w.photoIds[0] });
      await t.call("avatars.pickPortrait", { avatarId: w.avatarId, photoId: w.photoIds[0] });
      await t.call("avatars.discardPortraits", { avatarId: w.archivedAvatarId });
      t.note("none of it changed the portraits");
      await t.call("avatars.portraits", { avatarId: pending });
    },
  },
  {
    name: "portraits: a batch is refused while an autopilot launch holds the avatar, and so are the pick and the discard",
    rig: { launch: true },
    async run(t, w, control) {
      control.launch.hangWriter();
      const started = await t.callLaunch("autopilot.start", {
        draft: {
          avatarIds: [w.avatarId],
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
      const launch = started.ok && typeof started.result.launch === "object" && started.result.launch !== null ? Object.fromEntries(Object.entries(started.result.launch)) : {};
      if (typeof launch.launchId !== "string") throw new Error("the launch did not start");
      const launchId = launch.launchId;
      await t.untilLaunch(launchId, "a request in flight", (l) => {
        const inFlight = typeof l.inFlight === "object" && l.inFlight !== null ? Object.fromEntries(Object.entries(l.inFlight)) : {};
        return Number(inFlight.requests) > 0;
      });
      t.note("the launch's writer is out and the launch holds the avatar: the claim comes before anything else is looked at");
      await t.callLaunch("avatars.generatePortraits", { avatarId: w.avatarId, acceptedWorstMicros: 10_000_000 });
      await t.callLaunch("avatars.pickPortrait", { avatarId: w.avatarId, photoId: w.photoIds[0] });
      await t.callLaunch("avatars.discardPortraits", { avatarId: w.avatarId });
      await control.launch.quit();
    },
  },
  // P3
  {
    name: "portraits: a batch is drawn and ranked, the list shows what passed best first, and the pick makes a portrait the master while the imported photo stays",
    rig: { portraits: true },
    async run(t, w) {
      const { imported } = portraitsOf(w);
      t.note("an imported avatar: its master is the imported photo, nothing is pending");
      const before = await t.call("avatars.portraits", { avatarId: imported });
      await draw(t, imported);
      t.note("three portraits passed, best first; the one that was not hers and the refused one are not here");
      const after = await t.call("avatars.portraits", { avatarId: imported });
      const [best, second] = pendingOf(after);
      t.note("the owner picks the second best: the master moves, avatar.changed follows, the other portraits go, the imported photo is kept");
      await t.call("avatars.pickPortrait", { avatarId: imported, photoId: must(second) });
      const picked = await t.call("avatars.portraits", { avatarId: imported });
      if (sourceOf(picked) !== sourceOf(before) || pendingOf(picked).length !== 0 || best === undefined) throw new Error("the pick did not leave the imported photo and an empty list");
    },
  },
  // P4
  {
    name: "portraits: the pick is idempotent, the imported photo can be made the master again, a photo that is no candidate is refused, and the discard removes what is pending",
    rig: { portraits: true },
    async run(t, w) {
      const { pending } = portraitsOf(w);
      t.note("an avatar with three pending portraits: best first, the master is the imported photo");
      const listed = await t.call("avatars.portraits", { avatarId: pending });
      const [best, , third] = pendingOf(listed);
      const source = sourceOf(listed);
      t.note("the current master is answered as it is: nothing changes, nothing is announced");
      await t.call("avatars.pickPortrait", { avatarId: pending, photoId: source });
      t.note("a photo that is not a candidate of this avatar");
      await t.call("avatars.pickPortrait", { avatarId: pending, photoId: w.otherPhotoIds[0] });
      t.note("the best portrait becomes the master; the other two go");
      await t.call("avatars.pickPortrait", { avatarId: pending, photoId: must(best) });
      await t.call("avatars.portraits", { avatarId: pending });
      t.note("the owner goes back to the imported photo: the portrait it replaces is removed");
      await t.call("avatars.pickPortrait", { avatarId: pending, photoId: source });
      await t.call("avatars.portraits", { avatarId: pending });
      t.note("a portrait that was removed is no candidate any more");
      await t.call("avatars.pickPortrait", { avatarId: pending, photoId: must(third) });
    },
  },
  {
    name: "portraits: the discard removes every pending portrait and says how many, keeps the master, and has nothing left to remove the second time",
    rig: { portraits: true },
    async run(t, w) {
      const { pending, imported } = portraitsOf(w);
      await t.call("avatars.portraits", { avatarId: pending });
      t.note("three pending portraits go");
      await t.call("avatars.discardPortraits", { avatarId: pending });
      await t.call("avatars.portraits", { avatarId: pending });
      t.note("nothing is left to remove");
      await t.call("avatars.discardPortraits", { avatarId: pending });
      t.note("an imported avatar with none, and an avatar that was not imported, have none to remove");
      await t.call("avatars.discardPortraits", { avatarId: imported });
      await t.call("avatars.discardPortraits", { avatarId: w.avatarId });
      t.note("the grid still lists the avatars as it did");
      await t.call("avatars.list", {});
    },
  },
];
