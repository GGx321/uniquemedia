import { expect, test } from "bun:test";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA } from "./mockEngine.testkit";
import { ManualScheduler } from "./scheduler";

// Stage 5, 5b.1, S5.V1: the clip commands are in the contract; the mock answers them INTERNAL «not built yet» until S5.V7 gives them their real behaviour. That is a compile-only
// stub, and this file is its test: removing a command's case from the mock's switch is a type error (the switch has no default), so the stub can never silently go missing.

const AVATAR = MIA.avatarId;
const ref = { avatarId: AVATAR, clipId: "clip-0000001" };

function makeClient() {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), avatars: [MIA] });
  return mockEngineClient(engine);
}

test("clips.options is not built yet", async () => {
  const reply = await makeClient().request("clips.options", { avatarId: AVATAR, photoId: "photo-0001" });
  expect(reply).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "clips.options is not built yet" } });
});

test("clips.create is not built yet, and spends nothing", async () => {
  const client = makeClient();
  const reply = await client.request("clips.create", { avatarId: AVATAR, photoId: "photo-0001", motionId: "scene", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 });
  expect(reply).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "clips.create is not built yet" } });
  const money = await client.request("money.status", {});
  expect(money.ok && money.result.ledger === "open" ? money.result.spentMicros : -1).toBe(0);
});

test("clips.list is not built yet", async () => {
  expect(await makeClient().request("clips.list", { avatarId: AVATAR })).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: "clips.list is not built yet" } });
});

test("clips.get, markSeen, delete, retryDownload, export and reveal are not built yet either", async () => {
  const client = makeClient();
  for (const type of ["clips.get", "clips.markSeen", "clips.delete", "clips.retryDownload", "clips.export", "clips.reveal"] as const) {
    expect(await client.request(type, ref)).toMatchObject({ ok: false, error: { code: "INTERNAL", detail: `${type} is not built yet` } });
  }
});
