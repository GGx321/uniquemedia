import { expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// `avatars.editDescriptor` in the mock (Stage 5, S5.0a): it answers what the engine answers, refusal for refusal — the parity rig plays the same stories against both.

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

async function unwrap<T>(reply: Promise<{ ok: true; result: T } | { ok: false; error: { code: string } }>): Promise<T> {
  const r = await reply;
  if (!r.ok) throw new Error(`expected ok, got ${r.error.code}`);
  return r.result;
}

const EDITED = "25-year-old European woman, green eyes, long straight blonde hair, athletic build";

/** The demo preset's first saved avatar and its stored descriptor text. */
async function demoAvatar(client: ReturnType<typeof makeMock>["client"]): Promise<{ avatarId: string; text: string; age: number }> {
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const first = avatars[0];
  if (first === undefined) throw new Error("the demo preset has no avatar");
  return { avatarId: first.avatarId, text: first.descriptor.text, age: first.descriptor.age };
}

/** An edit text in the demo avatar's own age. */
function editedFor(age: number): string {
  return EDITED.replace("25-year-old", `${age}-year-old`);
}

test("stores the owner's text, answers the avatar with it and lists it", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);

  const result = await unwrap(client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: text }));

  expect(result.avatar).toMatchObject({ avatarId, descriptor: { age, text: editedFor(age) } });
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  expect(avatars.find((a) => a.avatarId === avatarId)?.descriptor.text).toBe(editedFor(age));
});

test("announces the avatar with avatar.changed and spends nothing", async () => {
  const { client, events } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);
  const before = await unwrap(client.request("money.status", {}));

  await unwrap(client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: text }));

  expect(events.filter((e) => e.type === "avatar.changed")).toMatchObject([{ payload: { avatar: { avatarId, descriptor: { text: editedFor(age) } } } }]);
  expect(await unwrap(client.request("money.status", {}))).toEqual(before);
});

test("folds typography in the stored text", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);

  const result = await unwrap(client.request("avatars.editDescriptor", { avatarId, text: `${age}–year–old woman with a “warm” smile`, expectedText: text }));

  expect(result.avatar.descriptor.text).toBe(`${age}-year-old woman with a "warm" smile`);
});

test("refuses a stale proposal as stale and changes nothing", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);

  const reply = await client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: `${text} (older)` });

  expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason: "stale" } });
  expect((await demoAvatar(client)).text).toBe(text);
});

test.each([
  ["empty", "   "],
  ["hidden-chars", "25-year-old woman\u200B"],
  ["too-long", `25-year-old woman ${"x".repeat(600)}`],
  ["no-anchor", "European woman, hazel eyes"],
  ["script", "25-year-old \u0436\u0435\u043D\u0449\u0438\u043D\u0430, hazel eyes"],
  ["non-ascii-digits", "25-year-old woman with \u0663 freckles"],
  ["other-age", "25-year-old woman who looks 19 years old"],
  ["under-21-bound", "25-year-old woman, under 21"],
  ["number", "25-year-old woman with 3 moles"],
] as const)("refuses a text that breaks the rule %s and changes nothing", async (descriptorReason, text) => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text: stored, age } = await demoAvatar(client);
  // The demo avatar's age is the anchor of these texts.
  expect(age).toBe(25);

  const reply = await client.request("avatars.editDescriptor", { avatarId, text, expectedText: stored });

  expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason } });
  expect((await demoAvatar(client)).text).toBe(stored);
});

test("refuses a youth word and names it", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text } = await demoAvatar(client);

  const reply = await client.request("avatars.editDescriptor", { avatarId, text: "25-year-old petite woman, hazel eyes", expectedText: text });

  expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason: "youth-word", descriptorWords: ["petite"] } });
});

test("the stale check comes before the text's own rules", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);

  const reply = await client.request("avatars.editDescriptor", { avatarId, text: "", expectedText: "something else" });

  expect(reply).toMatchObject({ ok: false, error: { descriptorReason: "stale" } });
});

test("answers NOT_FOUND for an unknown avatar", async () => {
  const { client } = makeMock({ preset: "demo" });

  expect(await client.request("avatars.editDescriptor", { avatarId: "avatar-nobody-0001", text: EDITED, expectedText: "x" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("answers VALIDATION for a draft", async () => {
  const { client } = makeMock();
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 10_000_000 }));

  expect(await client.request("avatars.editDescriptor", { avatarId: draft.avatarId, text: EDITED, expectedText: draft.descriptor.text })).toMatchObject({
    ok: false,
    error: { code: "VALIDATION" },
  });
});

test("answers NOT_FOUND for an unreadable entry: the mock holds no stored text for it", async () => {
  const { client, engine } = makeMock();
  engine.seedUnreadable({ avatarId: "avatar-broken-0001", name: "Mia", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" });

  expect(await client.request("avatars.editDescriptor", { avatarId: "avatar-broken-0001", text: EDITED, expectedText: "a young woman" })).toMatchObject({
    ok: false,
    error: { code: "NOT_FOUND" },
  });
});

test("answers LIBRARY_UNAVAILABLE with no library open, before it looks at the avatar", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);
  engine.setLibraryAvailable(false);

  expect(await client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: text })).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
});

test("answers IN_FLIGHT while one of the non-run jobs holds the avatar, and works again when it ends", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);
  engine.setAvatarEditing(avatarId, true);

  expect(await client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: text })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  expect((await demoAvatar(client)).text).toBe(text);

  engine.setAvatarEditing(avatarId, false);
  await unwrap(client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: text }));
});

test("is allowed while a photo run or a launch holds the avatar", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);
  engine.setAvatarBusy(avatarId, true);

  const result = await unwrap(client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: text }));

  expect(result.avatar.descriptor.text).toBe(editedFor(age));
});
