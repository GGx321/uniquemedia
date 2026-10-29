import { expect, test } from "bun:test";
import { type AvatarBody, type AvatarSummary, type EventMessage } from "../../shared/engine";
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

async function demoAvatar(client: ReturnType<typeof makeMock>["client"]): Promise<AvatarSummary> {
  const { avatars } = await unwrap(client.request("avatars.list", {}));
  const first = avatars[0];
  if (first === undefined) throw new Error("the demo preset has no avatar");
  return first;
}

/** A valid descriptor text of exactly `length` characters for an avatar of `age`. */
const textOf = (age: number, length: number): string => `${age}-year-old woman, `.padEnd(length, "z");

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

test("setBody refuses a composite of 601 with the reason too-long-with-body, and stores 600", async () => {
  const { client, engine } = makeMock({ preset: "demo" });
  const base = await demoAvatar(client);
  const limit = 600 - 2 - PHRASE.length;
  engine.addAvatarSilently({ ...base, avatarId: "avatar-fits-0001", descriptor: { age: base.descriptor.age, text: textOf(base.descriptor.age, limit) } });
  engine.addAvatarSilently({ ...base, avatarId: "avatar-over-0001", descriptor: { age: base.descriptor.age, text: textOf(base.descriptor.age, limit + 1) } });

  expect(await client.request("avatars.setBody", { avatarId: "avatar-over-0001", body: BODY })).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason: "too-long-with-body" } });
  expect((await unwrap(client.request("avatars.setBody", { avatarId: "avatar-fits-0001", body: BODY }))).avatar.body).toEqual(BODY);
});

// ---------- the import's body proposal (S5.2b) ----------


// S5.2b review L10.

