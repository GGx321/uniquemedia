import { describe, expect, test } from "bun:test";
import type { AvatarSummary, LaunchDraftInput, RunRequest, SceneSetView } from "../../shared/engine";
import { captureOfShot } from "../../shared/scenes/captures";
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

  // 5a.3 (S5.9a): «Смелая» over the five ordinary built-ins draws the «Кокетливая» mix, and the set shows the level it was asked at.
  test("shows the bold level of a set composed bold, and draws the flirty mix over the five built-ins", async () => {
    const bold = await composedSet({ level: "bold" });
    const flirty = await composedSet({ level: "flirty" });
    expect(bold.level).toBe("bold");
    expect(bold.scenes.map((scene) => scene.level)).toEqual(flirty.scenes.map((scene) => scene.level));
    expect(bold.scenes.map((scene) => scene.capture)).toEqual(flirty.scenes.map((scene) => scene.capture));
    expect(bold.scenes.some((scene) => scene.level === "flirty")).toBe(true);
    expect(bold.scenes.some((scene) => scene.level === "bold" || scene.route !== undefined)).toBe(false);
  });

  test("shows no level when it was composed ordinary, asked or not", async () => {
    expect("level" in (await composedSet({}))).toBe(false);
    expect("level" in (await composedSet({ level: "ordinary" }))).toBe(false);
  });

  test("draws the mix a flirty level asks for and the same captures an ordinary request draws (the mix itself is in mockEngine.levelMix.test.ts)", async () => {
    const ordinary = await composedSet({});
    const flirty = await composedSet({ level: "flirty" });
    expect(flirty.scenes.some((scene) => scene.level === "flirty")).toBe(true);
    expect(ordinary.scenes.some((scene) => scene.level !== undefined)).toBe(false);
    expect(flirty.scenes.map((scene) => scene.capture)).toEqual(ordinary.scenes.map((scene) => scene.capture));
  });

  // S5.7R carry-over (I5.27): the engine's slot stores a capture only when it says more than the stored shot, and the view echoes only that; the mock does the same.
  test("shows a scene's capture the way the engine does: only when it says more than the scene's shot", async () => {
    const set = await composedSet({});
    expect(set.scenes.some((scene) => scene.capture !== undefined)).toBe(true);
    expect(set.scenes.some((scene) => scene.capture === undefined)).toBe(true);
    for (const scene of set.scenes) if (scene.capture !== undefined) expect(scene.capture).not.toBe(captureOfShot(scene.shot));
  });
});

describe("the other commands that take the new shapes", () => {
  const request = (over: Record<string, unknown> = {}): RunRequest => ({ avatarId: MIA.avatarId, count: 6, categories: ["home"], ...over });

  test.each([
    ["the old poses", { poses: POSES }],
    ["no poses", {}],
    ["a flirty level", { level: "flirty" }],
    ["a bold level", { level: "bold" }],
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
    ["bold", { level: "bold" }],
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
