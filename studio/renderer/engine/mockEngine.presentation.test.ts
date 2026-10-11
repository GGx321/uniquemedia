import { describe, expect, test } from "bun:test";
import type { AvatarSummary, LaunchDraftInput, RunRequest, SceneSetView } from "../../shared/engine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { MockEngine, mockDescriptor, mockEngineClient } from "./mockEngine";
import { ManualScheduler } from "./scheduler";

// S5.7a: «Подача» (`level`) and the optional `poses` on the mock, as the engine takes them: the old shapes still answer, `poses` is echoed on a set only when it
// was sent, `level` only when it is flirty, and until S5.7b draws the mix `level` changes no scene.

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

const POSES = { profile: false, back: true };
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
  test("echoes the poses of an old request, as before", async () => {
    expect((await composedSet({ poses: POSES })).poses).toEqual(POSES);
  });

  test("echoes no poses when the request sent none", async () => {
    expect("poses" in (await composedSet({}))).toBe(false);
  });

  test("shows its level when it was composed flirty", async () => {
    expect((await composedSet({ level: "flirty" })).level).toBe("flirty");
  });

  test("shows no level when it was composed ordinary, asked or not", async () => {
    expect("level" in (await composedSet({}))).toBe(false);
    expect("level" in (await composedSet({ level: "ordinary" }))).toBe(false);
  });

  test("draws the very scenes an ordinary request draws, whatever the level (S5.7b implements the mix)", async () => {
    const ordinary = await composedSet({});
    const flirty = await composedSet({ level: "flirty" });
    expect(flirty.scenes).toEqual(ordinary.scenes);
  });

  test("shows each scene's capture, the way the engine does", async () => {
    const set = await composedSet({});
    expect(set.scenes.every((scene) => scene.capture !== undefined)).toBe(true);
  });
});

describe("the other commands that take the new shapes", () => {
  const request = (over: Record<string, unknown> = {}): RunRequest => ({ avatarId: MIA.avatarId, count: 6, categories: ["home"], ...over });

  test.each([
    ["the old poses", { poses: POSES }],
    ["no poses", {}],
    ["a flirty level", { level: "flirty" }],
  ])("runs.estimate answers a request with %s", async (_name, over) => {
    const reply = await makeMock().request("runs.estimate", request(over) as never);
    expect(reply.ok).toBe(true);
  });

  test("runs.estimate prices a flirty request exactly as an ordinary one", async () => {
    const client = makeMock();
    const ordinary = await client.request("runs.estimate", request() as never);
    const flirty = await client.request("runs.estimate", request({ level: "flirty" }) as never);
    expect(ordinary.ok && flirty.ok && flirty.result.estimate.worstMicros === ordinary.result.estimate.worstMicros).toBe(true);
  });

  const drafts: [string, Partial<LaunchDraftInput>][] = [
    ["with its poses", { poses: { profile: false, back: false } }],
    ["without poses", {}],
    ["flirty", { level: "flirty" }],
  ];
  test.each(drafts)("autopilot.estimate previews a draft %s", async (_name, over) => {
    const draft: LaunchDraftInput = {
      avatarIds: [MIA.avatarId],
      videosPerAvatar: 2,
      mix: { single: 100, collage: 0, slides: 0 },
      categories: ["home"],
      library: false,
      generate: true,
      sceneReview: false,
      stickers: false,
      ...over,
    };
    const reply = await makeMock().request("autopilot.estimate", { draft });
    expect(reply.ok).toBe(true);
  });
});
