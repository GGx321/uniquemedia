import type { Scenario } from "./scenarios";
import type { Answer } from "./transcript";

// Stage 5, S5.0a (APPENDED; the golden is append-only): `avatars.editDescriptor`, the owner's own free edit of a saved avatar's descriptor, told against both engines. Played here: the
// edit and its fold, the announcement, the stale proposal, one refusal per rule (the closed `descriptorReason`), the refusals before the text (an unknown avatar, a payload the contract
// refuses), an archived avatar, and the two claims that are the point of the task: an edit is allowed while an autopilot launch holds the avatar. The refusals that need a job to hold the
// avatar (a rewrite, a candidates batch, an archive, a delete) and a draft are held by the engine's and the mock's own tests (engine.editDescriptor, mockEngine.editDescriptor): the rig
// scripts no chat, and the mock runs those jobs to their end at once.
//
// The world's stored text is each rig's own (it is not written): the stories read it from `avatars.list` and send it back as `expectedText`, so what the transcript holds is the
// owner's text, what the engine made of it, and the reason a refusal gave.

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

export const AVATAR_EDIT_SCENARIOS: readonly Scenario[] = [
  {
    name: "editDescriptor: the owner's text is stored folded and announced, and the next edit must name the text it was made against",
    async run(t, w) {
      const first = await stored(t, w.avatarId);
      t.note("typography is folded: the en dashes and the curly quotes come back plain");
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: `${first.age}–year–old woman with a “warm” smile, green eyes`, expectedText: first.text });
      const second = await stored(t, w.avatarId);
      t.note("the first text is no longer what is stored: a proposal made against it is stale, and nothing changes");
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: `${first.age}-year-old woman, blue eyes`, expectedText: first.text });
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: `${first.age}-year-old woman, blue eyes`, expectedText: second.text });
      t.note("the avatar's other fields are untouched");
      await stored(t, w.avatarId);
    },
  },
  {
    name: "editDescriptor: every rule has its own reason, the stale check comes first, and a youth word is named",
    async run(t, w) {
      const { text, age } = await stored(t, w.avatarId);
      const edit = (candidate: string, expectedText = text) => t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: candidate, expectedText });
      t.note("blank, invisible characters, and over 600 characters");
      await edit("   ");
      await edit(`${age}-year-old woman\u0007`);
      await edit(`${age}-year-old woman ${"x".repeat(600)}`);
      t.note("the age anchor must be there, with the avatar's own age");
      await edit("European woman, hazel eyes");
      await edit(`${age + 1}-year-old European woman`);
      t.note("script, foreign digits, another age, an age bound, a stray number");
      await edit(`${age}-year-old \u0436\u0435\u043D\u0449\u0438\u043D\u0430, hazel eyes`);
      await edit(`${age}-year-old woman with \u0663 freckles`);
      await edit(`${age}-year-old woman who looks 19 years old`);
      await edit(`${age}-year-old woman, under 21`);
      await edit(`${age}-year-old woman with 3 moles`);
      t.note("a youth word is named");
      await edit(`${age}-year-old petite woman, hazel eyes`);
      t.note("a stale proposal is told so before the text is read");
      await edit("", "an older stored text");
      t.note("none of it changed the stored text");
      await t.call("avatars.list", {});
    },
  },
  {
    name: "editDescriptor: an unknown avatar is NOT_FOUND, a payload the contract refuses is VALIDATION, and an archived avatar can be edited and stays archived",
    async run(t, w) {
      const archived = await stored(t, w.archivedAvatarId);
      await t.call("avatars.editDescriptor", { avatarId: "avatar-nobody-1", text: "25-year-old woman, green eyes", expectedText: "x" });
      await t.call("avatars.editDescriptor", { avatarId: w.avatarId, text: "x".repeat(4_001), expectedText: "x" });
      await t.call("avatars.editDescriptor", { avatarId: w.archivedAvatarId, text: `${archived.age}-year-old woman, green eyes`, expectedText: archived.text });
      await t.call("avatars.list", {});
    },
  },
  {
    name: "editDescriptor: an edit is allowed while an autopilot launch holds the avatar, and the launch goes on",
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
      const listed = await t.callLaunch("avatars.list", {});
      const { text, age } = storedDescriptor(listed, w.avatarId);
      t.note("the launch's writer is out and the launch holds the avatar: an edit of the description is not refused");
      await t.callLaunch("avatars.editDescriptor", { avatarId: w.avatarId, text: `${age}-year-old woman, green eyes`, expectedText: text });
      const after = await t.callLaunch("autopilot.get", { launchId }, { brief: true });
      t.note(`the launch is still ${String(record(after.ok ? after.result.launch : null)?.status)}`);
      await control.launch.quit();
    },
  },
];
