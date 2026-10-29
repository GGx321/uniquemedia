import { describe, expect, test } from "bun:test";
import type { AvatarSummary, RunRequest, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// S5.7a: «Подача» (`level`) and the optional `poses` on the mock, as the engine takes them: the old shapes still answer, `poses` is echoed on a set only when it
// was sent, `level` only when it is flirty, and a flirty level draws the mix (S5.7b).

const MIA: AvatarSummary = {
  avatarId: "avatar-mia-0001",
  name: "Mia",
  descriptor: mockDescriptor(DEFAULT_TRAITS),
  masterPhotoId: "photo-mia-0001",
  createdAt: "2026-09-24T09:00:00.000Z",
  status: "active",
  photoCount: 1,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

const WORST = 10_000_000;

function makeMock() {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), avatars: [MIA] });
  return mockEngineClient(engine);
}
type Client = ReturnType<typeof makeMock>;

async function composedSet(over: Record<string, unknown>): Promise<SceneSetView> {
  const client: Client = makeMock();
  const made = await client.request("scenes.compose", { avatarId: MIA.avatarId, count: 12, categories: ["home", "glam"], acceptedWorstMicros: WORST, ...over } as never);
  if (!made.ok) throw new Error(`compose refused: ${made.error.code}`);
  const got = await client.request("scenes.get", { avatarId: MIA.avatarId });
  if (!got.ok || got.result.sceneSet === null) throw new Error("no set");
  return got.result.sceneSet;
}

describe("a set composed on the mock", () => {

  test("shows its level when it was composed flirty", async () => {
    expect((await composedSet({ level: "flirty" })).level).toBe("flirty");
  });

  // 5a.3 (S5.9a): «Смелая» over the five ordinary built-ins draws the «Кокетливая» mix, and the set shows the level it was asked at.
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4 #1): «Смелая» is every category's, so the set draws the bold mix on the route (the counts are S5.BA7's, over the whole request); the «Кокетливая» mix is
  // told on a flirty set, kept.

  // S5.7R carry-over (I5.27): the engine's slot stores a capture only when it says more than the stored shot, and the view echoes only that; the mock does the same.

});

describe("the other commands that take the new shapes", () => {
  const request = (over: Record<string, unknown> = {}): RunRequest => ({ avatarId: MIA.avatarId, count: 6, categories: ["home"], ...over });

  test("runs.estimate prices a flirty request exactly as an ordinary one", async () => {
    const client = makeMock();
    const ordinary = await client.request("runs.estimate", request() as never);
    const flirty = await client.request("runs.estimate", request({ level: "flirty" }) as never);
    expect(ordinary.ok && flirty.ok && flirty.result.estimate.worstMicros === ordinary.result.estimate.worstMicros).toBe(true);
  });


});
