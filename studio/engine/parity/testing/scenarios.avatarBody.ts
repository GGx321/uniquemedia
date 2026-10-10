import type { Scenario } from "./scenarios";
import type { Answer } from "./transcript";

// Stage 5, S5.2a (APPENDED; the golden is append-only): `avatars.setBody` and `avatars.dismissBodyProposal`, the owner's free body traits and the «Не нужно» of an import's body proposal,
// told against both engines. Played here: the write (a body REPLACES the old one; `{}` clears it), the contract's refusals, the composite (the description and the body phrase together
// may not pass 600 characters, from either side), an archived avatar, the stored proposal cleared by a body and by a dismiss, and a body set while an autopilot launch holds the avatar.
// The refusals that need a job to hold the avatar (a rewrite, a candidates batch, an archive, a delete), a draft, a schema-version-1 record and the race inside the library's lock are held by
// the engine's and the mock's own tests (engine.body, mockEngine.body): the rig scripts no chat, the mock runs those jobs to their end at once and keeps no record version.
//
// The world's stored text is each rig's own (it is not written): the stories read it from `avatars.list`.

type Telling = Parameters<Scenario["run"]>[0];

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

/** The descriptor `avatars.list` answered for an avatar (its text and age), read, not written. */
function storedDescriptor(listed: Answer, avatarId: string): { text: string; age: number } {
  if (!listed.ok || !Array.isArray(listed.result.avatars)) throw new Error("avatars.list did not answer the grid");
  for (const entry of listed.result.avatars) {
    const avatar = record(entry);
    const descriptor = record(avatar?.descriptor);
    if (avatar?.avatarId === avatarId && typeof descriptor?.text === "string" && typeof descriptor.age === "number") return { text: descriptor.text, age: descriptor.age };
  }
  throw new Error(`the grid does not list ${avatarId}`);
}

async function stored(t: Telling, avatarId: string): Promise<{ text: string; age: number }> {
  return storedDescriptor(await t.call("avatars.list", {}), avatarId);
}

const BODY = { height: "tall", bust: "full", figure: "hourglass", legLength: "long", legShape: "slim", bottomSize: "medium", bottomShape: "wide", bodyMarks: ["mole-back", "tattoo-ankle"] };
/** The phrase `bodyPhrase` renders for `{ height: "tall", bust: "full", legLength: "long", legShape: "slim" }`: 36 characters. */
const SHORT_BODY = { height: "tall", bust: "full", legLength: "long", legShape: "slim" };
const SHORT_PHRASE_CHARS = "tall, a full bust and long slim legs".length;

/** A text of exactly `length` characters that states `age`. */
function textOf(age: number, length: number): string {
  return `${age}-year-old woman, `.padEnd(length, "x");
}

export const AVATAR_BODY_SCENARIOS: readonly Scenario[] = [
  {
    name: "setBody: the body is stored beside the description, a new body replaces the old one, an empty one clears it, and the phrase never enters the description",
    async run(t, w) {
      const first = await stored(t, w.avatarId);
      t.note("a full body: the marks are listed in the fixed order, whatever order they were sent in");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: BODY });
      t.note("a new body REPLACES the old one: every key left out goes back to «не задано»");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { bust: "small" } });
      t.note("an empty list of marks is not a body: the summary then carries no body at all");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { bodyMarks: [] } });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { height: "average" } });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: {} });
      t.note("the description is exactly what it was");
      const after = await stored(t, w.avatarId);
      t.note(`the description text is unchanged: ${String(after.text === first.text)}`);
    },
  },
  {
    name: "setBody: an unknown avatar is NOT_FOUND, a body the contract refuses is VALIDATION, and an archived avatar can be given a body and stays archived",
    async run(t, w) {
      await t.call("avatars.setBody", { avatarId: "avatar-nobody-1", body: { height: "tall" } });
      t.note("three marks, a repeated mark, a value off the list, an unknown key, the build word, and no body at all");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] } });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { bodyMarks: ["mole-back", "mole-back"] } });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { height: "giant" } });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { weight: "light" } });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { build: "slim" } });
      await t.call("avatars.setBody", { avatarId: w.avatarId });
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { height: "tall" }, apply: true });
      t.note("none of it changed an avatar");
      await t.call("avatars.list", {});
      t.note("an archived avatar takes a body and stays archived");
      await t.call("avatars.setBody", { avatarId: w.archivedAvatarId, body: SHORT_BODY });
      await t.call("avatars.list", {});
    },
  },
  {
    name: "setBody: the description and the body phrase together may not pass 600 characters, whichever is written second",
    async run(t, w) {
      const { text, age } = await stored(t, w.avatarId);
      const limit = 600 - 2 - SHORT_PHRASE_CHARS;
      t.note("a body on a short description");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: SHORT_BODY });
      t.note("one character too many for a description that has a body is refused with its own reason; exactly 600 together is taken");
      let current = text;
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: textOf(age, limit + 1), expectedText: current });
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: textOf(age, limit), expectedText: current });
      current = (await stored(t, w.avatarId)).text;
      t.note("the old limit of 600 is for a description with no body: clearing the body lets a long description be written");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: {} });
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: textOf(age, 600), expectedText: current });
      t.note("and now no body fits beside it");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: SHORT_BODY });
      t.note("clearing a body is always allowed");
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: {} });
      await t.call("avatars.list", {});
    },
  },
  {
    name: "dismissBodyProposal: «Не нужно» clears the stored proposal and keeps everything else; a second one answers the avatar as it is",
    rig: { bodyProposal: true },
    async run(t, w) {
      t.note("the avatar holds the body a photo import read; none of it is a trait yet");
      await t.call("avatars.list", {});
      await t.call("avatars.dismissBodyProposal", { avatarId: w.avatarId });
      t.note("dismissing again is harmless");
      await t.call("avatars.dismissBodyProposal", { avatarId: w.avatarId });
      await t.call("avatars.list", {});
      t.note("an unknown avatar, and a payload the contract refuses");
      await t.call("avatars.dismissBodyProposal", { avatarId: "avatar-nobody-1" });
      await t.call("avatars.dismissBodyProposal", { avatarId: w.avatarId, keep: true });
    },
  },
  {
    name: "setBody: the first body the owner saves takes the stored proposal with it («Сохранить тело»)",
    rig: { bodyProposal: true },
    async run(t, w) {
      await t.call("avatars.list", {});
      await t.call("avatars.setBody", { avatarId: w.avatarId, body: { bust: "full", height: "average" } });
      await t.call("avatars.list", {});
    },
  },
  {
    name: "setBody: a body is allowed while an autopilot launch holds the avatar, and the launch goes on",
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
      const launchId = started.ok ? record(started.result.launch)?.launchId : undefined;
      if (typeof launchId !== "string") throw new Error("the launch did not start");
      await t.untilLaunch(launchId, "a request in flight", (l) => Number(record(l.inFlight)?.requests) > 0);
      t.note("the launch's writer is out and the launch holds the avatar: a body is not refused");
      await t.callLaunch("avatars.setBody", { avatarId: w.avatarId, body: SHORT_BODY });
      const after = await t.callLaunch("autopilot.get", { launchId }, { brief: true });
      t.note(`the launch is still ${String(record(after.ok ? after.result.launch : null)?.status)}`);
      await control.launch.quit();
    },
  },
];
