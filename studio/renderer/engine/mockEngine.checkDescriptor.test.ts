import { expect, test } from "bun:test";
import { IMPORT_FALLBACK_PRICE, type DescriptorCheck, type EventMessage } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// `avatars.estimateCheckDescriptor` and `avatars.checkDescriptor` in the mock (Stage 5, S5.0c): it answers what the engine answers, refusal for refusal — the parity rig plays the
// same stories against both. The mock cannot look at a photo, so a check says «everything agrees» unless a test scripts the next one (`setNextDescriptorCheck`).

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

/** What one check costs at most: two attempts, at the figures the engine's tests pin at the fallback table. */
const CHECK_WORST = 2 * IMPORT_FALLBACK_PRICE.check.worstMicros;

/** What the ledger has spent so far, in micro-dollars. */
async function spentSoFar(client: ReturnType<typeof makeMock>["client"]): Promise<number> {
  const money = await unwrap(client.request("money.status", {}));
  if (money.ledger !== "open") throw new Error("the mock's ledger is not open");
  return money.spentMicros;
}

/** The demo preset's first saved avatar and its stored descriptor text. */
async function demoAvatar(client: ReturnType<typeof makeMock>["client"]): Promise<{ avatarId: string; text: string; age: number }> {
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const first = avatars[0];
  if (first === undefined) throw new Error("the demo preset has no avatar");
  return { avatarId: first.avatarId, text: first.descriptor.text, age: first.descriptor.age };
}

function hairMismatch(checkedText: string, proposal: string | null): DescriptorCheck {
  return {
    matches: false,
    aspects: { hair: { state: "mismatch", descriptor: "волнистые блонд", photo: "прямые платиновые" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
    proposal,
    checkedText,
  };
}

async function pickedImport(client: ReturnType<typeof makeMock>["client"]): Promise<{ stagingId: string; worst: number }> {
  const staged = await unwrap(client.request("avatars.pickImportPhoto", {}));
  if (!staged.picked) throw new Error("expected a picked photo");
  const worst = (await unwrap(client.request("avatars.estimateImport", { stagingId: staged.stagingId }))).worstMicros;
  return { stagingId: staged.stagingId, worst };
}

test("estimateCheckDescriptor prices up to two attempts of the check", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);

  expect(await unwrap(client.request("avatars.estimateCheckDescriptor", { avatarId }))).toMatchObject({
    expectedMicros: IMPORT_FALLBACK_PRICE.check.expectedMicros,
    worstMicros: CHECK_WORST,
  });
});

test("estimateCheckDescriptor prices a draft too", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 10_000_000 }));

  expect((await client.request("avatars.estimateCheckDescriptor", { avatarId: draft.avatarId })).ok).toBe(true);
});

test("estimateCheckDescriptor answers NOT_FOUND for an unknown avatar", async () => {
  const { client } = makeMock({ preset: "demo" });

  expect(await client.request("avatars.estimateCheckDescriptor", { avatarId: "avatar-nobody" })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("estimateCheckDescriptor is free: it spends nothing", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  const before = await unwrap(client.request("money.status", {}));

  await unwrap(client.request("avatars.estimateCheckDescriptor", { avatarId }));

  expect(await unwrap(client.request("money.status", {}))).toEqual(before);
});

test("checkDescriptor says everything agrees with the descriptor it judged", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text } = await demoAvatar(client);

  const { check } = await unwrap(client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST }));

  expect(check).toEqual({ matches: true, aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } }, proposal: null, checkedText: text });
});

test("checkDescriptor spends the check's expected price", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  const before = await spentSoFar(client);

  await unwrap(client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST }));

  expect((await spentSoFar(client)) - before).toBe(IMPORT_FALLBACK_PRICE.check.expectedMicros);
});

test("checkDescriptor never writes: a scripted proposal changes neither the stored text nor the list, and announces no avatar", async () => {
  const { client, engine, events } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);
  const listed = await unwrap(client.request("avatars.list", {}));
  engine.setNextDescriptorCheck(hairMismatch(text, `${age}-year-old woman, long straight platinum hair`));

  const { check } = await unwrap(client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST }));

  expect(check.proposal).toBe(`${age}-year-old woman, long straight platinum hair`);
  expect(await unwrap(client.request("avatars.list", {}))).toEqual(listed);
  expect(events.filter((e) => e.type === "avatar.changed")).toHaveLength(0);
});

test("a scripted check is used once: the next one is the default again", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId, text } = await demoAvatar(client);
  engine.setNextDescriptorCheck(hairMismatch(text, null));

  expect((await unwrap(client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST }))).check.matches).toBe(false);
  expect((await unwrap(client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST }))).check.matches).toBe(true);
});

test("a scripted refusal answers its error and spends nothing", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  const before = await unwrap(client.request("money.status", {}));
  engine.setNextDescriptorCheck({ code: "MODERATION_REFUSED" });

  expect(await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "MODERATION_REFUSED" } });
  expect(await unwrap(client.request("money.status", {}))).toEqual(before);
});

test("a proposal is applied by the owner: editDescriptor with the check's checkedText accepts it", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);
  const proposal = `${age}-year-old woman, long straight platinum hair`;
  engine.setNextDescriptorCheck(hairMismatch(text, proposal));
  const { check } = await unwrap(client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST }));

  const edited = await unwrap(client.request("avatars.editDescriptor", { avatarId, text: check.proposal ?? "", expectedText: check.checkedText }));

  expect(edited.avatar.descriptor.text).toBe(proposal);
});

test("PRICE_CHANGED when the accepted worst case is one below the check's, and nothing is spent", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);

  const before = await spentSoFar(client);

  expect(await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST - 1 })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
  expect(await spentSoFar(client)).toBe(before);
});

test("setCheckPrice changes the check's price, so a check accepted lower gets PRICE_CHANGED", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  engine.setCheckPrice({ expectedMicros: 4_000, worstMicros: 40_000 });

  expect(await unwrap(client.request("avatars.estimateCheckDescriptor", { avatarId }))).toMatchObject({ worstMicros: 40_000 });
  expect(await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "PRICE_CHANGED" } });
});

test("AUTH_INVALID without a key, before the avatar is even looked up", async () => {
  const { client } = makeMock({ preset: "demo" });
  await unwrap(client.request("settings.clearApiKey", {}));

  expect(await client.request("avatars.checkDescriptor", { avatarId: "avatar-nobody", acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
});

test("NOT_FOUND for an unknown avatar", async () => {
  const { client } = makeMock({ preset: "demo" });

  expect(await client.request("avatars.checkDescriptor", { avatarId: "avatar-nobody", acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
});

test("VALIDATION for a draft: there is no master to compare with", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { draft } = await unwrap(client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 10_000_000 }));

  expect(await client.request("avatars.checkDescriptor", { avatarId: draft.avatarId, acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
});

test("IN_FLIGHT while a job, a command or a photo run holds the avatar, and a refusal spends nothing", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);

  engine.setAvatarEditing(avatarId, true);
  expect(await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  engine.setAvatarEditing(avatarId, false);
  engine.setAvatarBusy(avatarId, true);
  expect(await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  engine.setAvatarBusy(avatarId, false);

  expect((await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST })).ok).toBe(true);
});

test("LIBRARY_UNAVAILABLE when no library is open", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const { avatarId } = await demoAvatar(client);
  engine.setLibraryAvailable(false);

  expect(await client.request("avatars.checkDescriptor", { avatarId, acceptedWorstMicros: CHECK_WORST })).toMatchObject({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } });
});

// ---------- the import's own check ----------

test("importAvatar carries the check of the avatar it saved: everything agrees with the descriptor it stored", async () => {
  const { client } = makeMock();
  const { stagingId, worst } = await pickedImport(client);

  const { avatar, descriptorCheck } = await unwrap(client.request("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: worst }));

  expect(descriptorCheck).toEqual({
    matches: true,
    aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
    proposal: null,
    checkedText: avatar.descriptor.text,
  });
});

test("importAvatar's price includes the check: the old describe-only worst case is PRICE_CHANGED", async () => {
  const { client } = makeMock();
  const { stagingId } = await pickedImport(client);

  expect(await client.request("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: 2 * IMPORT_FALLBACK_PRICE.describe.worstMicros })).toMatchObject({
    ok: false,
    error: { code: "PRICE_CHANGED" },
  });
});

test("a scripted check refusal gives descriptorCheck null; the avatar is saved and listed", async () => {
  const { client, engine } = makeMock();
  const { stagingId, worst } = await pickedImport(client);
  engine.setNextDescriptorCheck({ code: "MODERATION_REFUSED" });

  const { avatar, descriptorCheck } = await unwrap(client.request("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: worst }));

  expect(descriptorCheck).toBeNull();
  expect((await unwrap(client.request("avatars.list", {}))).avatars.map((a) => a.avatarId)).toContain(avatar.avatarId);
});

test("a scripted check mismatch comes back with the import, and the saved descriptor is untouched", async () => {
  const { client, engine } = makeMock();
  const { stagingId, worst } = await pickedImport(client);
  engine.setNextDescriptorCheck(hairMismatch("the descriptor the mock wrote", null));

  const { avatar, descriptorCheck } = await unwrap(client.request("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: worst }));

  expect(descriptorCheck?.matches).toBe(false);
  expect((await unwrap(client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatar.avatarId)?.descriptor.text).toBe(avatar.descriptor.text);
});
