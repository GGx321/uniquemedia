import { expect, test } from "bun:test";
import type { EventMessage } from "../../shared/engine";
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

test("refuses a stale proposal as stale and changes nothing", async () => {
  const { client } = makeMock({ preset: "demo" });
  const { avatarId, text, age } = await demoAvatar(client);

  const reply = await client.request("avatars.editDescriptor", { avatarId, text: editedFor(age), expectedText: `${text} (older)` });

  expect(reply).toMatchObject({ ok: false, error: { code: "VALIDATION", descriptorReason: "stale" } });
  expect((await demoAvatar(client)).text).toBe(text);
});

