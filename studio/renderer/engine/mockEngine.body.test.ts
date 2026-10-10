import { expect, test } from "bun:test";
import { bodyPhrase, type AvatarBody, type AvatarSummary, type EventMessage } from "../../shared/engine";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// `avatars.setBody` and `avatars.dismissBodyProposal` in the mock (Stage 5, S5.2a): they answer what the engine answers, refusal for refusal — the parity rig plays the same stories
// against both. The claims, the composite and the engine's own write path are held by engine.body.test.ts.

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

const BODY: AvatarBody = { height: "tall", bust: "full", legLength: "long", legShape: "slim" };
const PHRASE = "tall, a full bust and long slim legs";
const PROPOSAL = { values: { bust: "full" }, seen: { bust: "photo", height: "not-visible" }, at: "2026-10-10T10:00:00.000Z" } as const;

async function demoAvatar(client: ReturnType<typeof makeMock>["client"]): Promise<AvatarSummary> {
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const first = avatars[0];
  if (first === undefined) throw new Error("the demo preset has no avatar");
  return first;
}

/** A valid descriptor text of exactly `length` characters for an avatar of `age`. */
const textOf = (age: number, length: number): string => `${age}-year-old woman, `.padEnd(length, "x");

test("setBody stores the body, answers the avatar with it, lists it, announces it once and spends nothing", async () => {
  const { client, events } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  const before = await unwrap(client.request("money.status", {}));

  const result = await unwrap(client.request("avatars.setBody", { avatarId, body: BODY }));

  expect(result.avatar).toMatchObject({ avatarId, body: BODY });
  expect((await demoAvatar(client)).body).toEqual(BODY);
  expect(events.filter((e) => e.type === "avatar.changed")).toMatchObject([{ payload: { avatar: { avatarId, body: BODY } } }]);
  expect(await unwrap(client.request("money.status", {}))).toEqual(before);
});

test("setBody never writes the phrase into the descriptor text", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, descriptor } = await demoAvatar(client);

  const result = await unwrap(client.request("avatars.setBody", { avatarId, body: BODY }));

  expect(result.avatar.descriptor).toEqual(descriptor);
});

test("setBody replaces the whole body: a key left out is cleared, and an empty body leaves the key off the summary", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  await unwrap(client.request("avatars.setBody", { avatarId, body: { ...BODY, bodyMarks: ["mole-back"] } }));

  expect((await unwrap(client.request("avatars.setBody", { avatarId, body: { bust: "small" } }))).avatar.body).toEqual({ bust: "small" });
  const cleared = await unwrap(client.request("avatars.setBody", { avatarId, body: { bodyMarks: [] } }));

  expect("body" in cleared.avatar).toBe(false);
});

test("setBody clears a stored body proposal in the same step", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const avatar = await demoAvatar(client);
  engine.addAvatarSilently({ ...avatar, avatarId: "avatar-proposed-0001", bodyProposal: PROPOSAL });

  const result = await unwrap(client.request("avatars.setBody", { avatarId: "avatar-proposed-0001", body: { bust: "full" } }));

  expect("bodyProposal" in result.avatar).toBe(false);
});

test("setBody answers NOT_FOUND for an unknown avatar and VALIDATION for a draft", async () => {
  const { client } = makeMock({ preset: "demo" });
  const draft = await unwrap(client.request("avatars.createDraft", { traits: (await import("../lib/traits")).DEFAULT_TRAITS, acceptedWorstMicros: 10_000_000 }));

  expect(await client.request("avatars.setBody", { avatarId: "avatar-nobody-1", body: BODY })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  expect(await client.request("avatars.setBody", { avatarId: draft.draft.avatarId, body: BODY })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("setBody answers LIBRARY_UNAVAILABLE with no library open, before it looks at the avatar", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  engine.setLibraryAvailable(false);

  expect(await client.request("avatars.setBody", { avatarId, body: BODY })).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
});

test("setBody answers IN_FLIGHT while one of the non-run jobs holds the avatar, and is allowed during a photo run or a launch", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  engine.setAvatarEditing(avatarId, true);

  expect(await client.request("avatars.setBody", { avatarId, body: BODY })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  expect((await demoAvatar(client)).body).toBeUndefined();

  engine.setAvatarEditing(avatarId, false);
  engine.setAvatarBusy(avatarId, true);
  expect((await unwrap(client.request("avatars.setBody", { avatarId, body: BODY }))).avatar.body).toEqual(BODY);
});

test("setBody refuses a composite of 601 with the reason too-long-with-body, and stores 600", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const base = await demoAvatar(client);
  const limit = 600 - 2 - PHRASE.length;
  engine.addAvatarSilently({ ...base, avatarId: "avatar-fits-0001", descriptor: { age: base.descriptor.age, text: textOf(base.descriptor.age, limit) } });
  engine.addAvatarSilently({ ...base, avatarId: "avatar-over-0001", descriptor: { age: base.descriptor.age, text: textOf(base.descriptor.age, limit + 1) } });

  expect(await client.request("avatars.setBody", { avatarId: "avatar-over-0001", body: BODY })).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason: "too-long-with-body" } });
  expect((await unwrap(client.request("avatars.setBody", { avatarId: "avatar-fits-0001", body: BODY }))).avatar.body).toEqual(BODY);
});

test("setBody judges the whole contract as the engine does: a stored text that fails the rules refuses the body as «invalid»", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const base = await demoAvatar(client);
  engine.addAvatarSilently({ ...base, avatarId: "avatar-stale-0001", descriptor: { age: base.descriptor.age, text: `${base.descriptor.age}-year-old petite woman, hazel eyes.` } });

  expect(await client.request("avatars.setBody", { avatarId: "avatar-stale-0001", body: BODY })).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason: "invalid" } });
});

test("setBody refuses a body the contract refuses (three marks, a value off the list)", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);

  expect(await client.request("avatars.setBody", { avatarId, body: { bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] } } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
  expect(await client.request("avatars.setBody", { avatarId, body: { height: "giant" } } as never)).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("editDescriptor counts the stored body phrase: text + «; » + phrase over 600 is too-long-with-body, exactly 600 is stored", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, descriptor } = await demoAvatar(client);
  await unwrap(client.request("avatars.setBody", { avatarId, body: BODY }));
  const limit = 600 - 2 - PHRASE.length;

  expect(await client.request("avatars.editDescriptor", { avatarId, text: textOf(descriptor.age, limit + 1), expectedText: descriptor.text })).toMatchObject({
    ok: false,
    error: { code: "VALIDATION", descriptorReason: "too-long-with-body" },
  });
  const stored = await unwrap(client.request("avatars.editDescriptor", { avatarId, text: textOf(descriptor.age, limit), expectedText: descriptor.text }));
  expect(stored.avatar.descriptor.text).toHaveLength(limit);
});

test("dismissBodyProposal clears the proposal, keeps the body, and announces the avatar", async () => {
  const { client, engine, events } = makeMock({ preset: "demo" });
  const avatar = await demoAvatar(client);
  engine.addAvatarSilently({ ...avatar, avatarId: "avatar-proposed-0001", body: { height: "average" }, bodyProposal: PROPOSAL });

  const result = await unwrap(client.request("avatars.dismissBodyProposal", { avatarId: "avatar-proposed-0001" }));

  expect("bodyProposal" in result.avatar).toBe(false);
  expect(result.avatar.body).toEqual({ height: "average" });
  expect(events.filter((e) => e.type === "avatar.changed")).toHaveLength(1);
});

test("dismissBodyProposal on an avatar with none answers it as it is and announces nothing", async () => {
  const { client, events } = makeMock({ preset: "demo" });
  const avatar = await demoAvatar(client);

  const result = await unwrap(client.request("avatars.dismissBodyProposal", { avatarId: avatar.avatarId }));

  expect(result.avatar).toEqual(avatar);
  expect(events.filter((e) => e.type === "avatar.changed")).toHaveLength(0);
});

test("dismissBodyProposal: NOT_FOUND for an unknown avatar, IN_FLIGHT while a job holds it, LIBRARY_UNAVAILABLE without a library", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);

  expect(await client.request("avatars.dismissBodyProposal", { avatarId: "avatar-nobody-1" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  engine.setAvatarEditing(avatarId, true);
  expect(await client.request("avatars.dismissBodyProposal", { avatarId })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  engine.setAvatarEditing(avatarId, false);
  engine.setLibraryAvailable(false);
  expect(await client.request("avatars.dismissBodyProposal", { avatarId })).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
});

test("a draft created with body traits becomes an avatar that carries that body when picked", async () => {
  const { client, scheduler } = makeMock({ preset: "empty" });
  const { DEFAULT_TRAITS } = await import("../lib/traits");
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: { ...DEFAULT_TRAITS, ...BODY }, acceptedWorstMicros: 10_000_000 }));
  expect(draft.traits).toMatchObject(BODY);
  expect(draft.descriptor.text).not.toContain("tall");
  await unwrap(client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: 10_000_000 }));
  scheduler.runAll();
  const listed = await unwrap(client.request("engine.snapshot", {}));
  const candidate = listed.drafts.find((d) => d.avatarId === draft.avatarId)?.candidates[0];
  if (candidate === undefined) throw new Error("no candidate was made");

  const picked = await unwrap(client.request("avatars.pick", { avatarId: draft.avatarId, photoId: candidate.photoId, name: "Mia" }));

  expect(picked.avatar.body).toEqual(BODY);
  expect(bodyPhrase(picked.avatar.body ?? {})).toBe(PHRASE);
});

// ---------- the import's body proposal (S5.2b) ----------

async function pickedImport(client: ReturnType<typeof makeMock>["client"]): Promise<{ stagingId: string; worst: number }> {
  const staged = await unwrap(client.request("avatars.pickImportPhoto", {}));
  if (!staged.picked) throw new Error("expected a picked photo");
  const worst = (await unwrap(client.request("avatars.estimateImport", { stagingId: staged.stagingId }))).worstMicros;
  return { stagingId: staged.stagingId, worst };
}

test("an import with no scripted body saves an avatar with no proposal, as a photo that shows no body does", async () => {
  const { client } = makeMock();
  const { stagingId, worst } = await pickedImport(client);

  const { avatar } = await unwrap(client.request("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: worst }));

  expect(avatar.bodyProposal).toBeUndefined();
  expect(avatar.body).toBeUndefined();
});

test("a body scripted for the next import comes back as the avatar's proposal, never as its body, and is listed until it is dismissed", async () => {
  const { engine, client } = makeMock();
  engine.queueImportBodyProposal(PROPOSAL);
  const { stagingId, worst } = await pickedImport(client);

  const { avatar } = await unwrap(client.request("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: worst }));

  expect(avatar.bodyProposal).toEqual(PROPOSAL);
  expect(avatar.body).toBeUndefined();
  const listed = (await unwrap(client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatar.avatarId);
  expect(listed?.bodyProposal).toEqual(PROPOSAL);
  await unwrap(client.request("avatars.dismissBodyProposal", { avatarId: avatar.avatarId }));
  expect((await unwrap(client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatar.avatarId)?.bodyProposal).toBeUndefined();
});

test("a scripted body serves one import only: the next one has no proposal", async () => {
  const { engine, client } = makeMock();
  engine.queueImportBodyProposal(PROPOSAL);
  const first = await pickedImport(client);
  await unwrap(client.request("avatars.importAvatar", { stagingId: first.stagingId, name: "Zoe", acceptedWorstMicros: first.worst }));
  const second = await pickedImport(client);

  const { avatar } = await unwrap(client.request("avatars.importAvatar", { stagingId: second.stagingId, name: "Eva", acceptedWorstMicros: second.worst }));

  expect(avatar.bodyProposal).toBeUndefined();
});

// S5.2b review L10.
test("a failed import consumes the scripted body too: the next import does not get it", async () => {
  const { engine, client } = makeMock();
  engine.queueImportBodyProposal(PROPOSAL);
  engine.failNextImportAfterConsuming({ code: "INTERNAL", detail: "x" });
  const failing = await pickedImport(client);
  await client.request("avatars.importAvatar", { stagingId: failing.stagingId, name: "Zoe", acceptedWorstMicros: failing.worst });
  const next = await pickedImport(client);

  const { avatar } = await unwrap(client.request("avatars.importAvatar", { stagingId: next.stagingId, name: "Eva", acceptedWorstMicros: next.worst }));

  expect(avatar.bodyProposal).toBeUndefined();
});

test("a scripted body with no values is refused: an empty proposal is never stored", () => {
  const { engine } = makeMock();
  expect(() => engine.queueImportBodyProposal({ values: {}, seen: {}, at: "2026-10-10T10:00:00.000Z" })).toThrow();
});
