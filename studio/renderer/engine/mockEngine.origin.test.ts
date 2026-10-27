import { describe, expect, test } from "bun:test";
import { impliedNudityOf, type AvatarSummary } from "../../shared/engine";
import { bankPlaceOf } from "../../shared/scenes/bankLookup";
import { BANK_OF } from "./mockBankScenes";
import { makeMock, unwrap, type Mock } from "./mockEngine.testkit";
import { DEFAULT_TRAITS } from "../lib/traits";

// 5a.4 (S5.BA7, plan s5a4 §5.11 «the origin flag (its avatars carry `origin`)», I5.74, I5.80): the mock's avatars say where they came from, as the engine's summaries do (`avatarCounts`
// always fills it from `studioCreated`): an avatar picked from the wizard's candidates is made in Studio, one made from an imported photo is imported. The plan and the coverage read it
// through `impliedNudityOf`, so a Studio-created avatar can draw an implied cover at «Смелая» and an imported one never does.

async function picked(m: Mock): Promise<AvatarSummary> {
  const { draft } = await unwrap(m.client.request("avatars.createDraft", { traits: DEFAULT_TRAITS, acceptedWorstMicros: 10_000_000 }));
  await unwrap(m.client.request("avatars.generateCandidates", { avatarId: draft.avatarId, acceptedWorstMicros: 10_000_000 }));
  m.scheduler.runAll();
  const snapshot = await unwrap(m.client.request("engine.snapshot", {}));
  const candidate = snapshot.drafts.find((d) => d.avatarId === draft.avatarId)?.candidates[0];
  if (candidate === undefined) throw new Error("no candidate was made");
  return (await unwrap(m.client.request("avatars.pick", { avatarId: draft.avatarId, photoId: candidate.photoId, name: "Ava" }))).avatar;
}

async function imported(m: Mock): Promise<AvatarSummary> {
  const staged = await unwrap(m.client.request("avatars.pickImportPhoto", {}));
  if (!staged.picked) throw new Error("expected a photo");
  const price = await unwrap(m.client.request("avatars.estimateImport", { stagingId: staged.stagingId }));
  return (await unwrap(m.client.request("avatars.importAvatar", { stagingId: staged.stagingId, name: "Bea", acceptedWorstMicros: price.worstMicros }))).avatar;
}

/** How many scenes of a 100-scene «Смелая» «Дом» set of the avatar draw an implied cover. */
async function impliedOf(m: Mock, avatarId: string): Promise<number> {
  await unwrap(m.client.request("scenes.compose", { avatarId, count: 100, categories: ["home"], level: "bold", acceptedWorstMicros: 100_000_000 }));
  m.scheduler.runAll();
  const set = (await unwrap(m.client.request("scenes.get", { avatarId }))).sceneSet;
  return (set?.scenes ?? []).filter((scene) => {
    const hit = bankPlaceOf({ category: BANK_OF.home, route: scene.route, location: scene.place?.location, activity: scene.place?.activity });
    return hit?.moment?.tier === "implied" || hit?.bank.outfits.find((o) => o.text === scene.place?.outfit)?.tier === "implied";
  }).length;
}

describe("the mock's avatars carry their origin", () => {
  test("an avatar picked from the wizard's candidates is made in Studio, in the answer, the event and the list", async () => {
    const m = makeMock({ preset: "empty" });
    const avatar = await picked(m);
    expect(avatar.origin).toBe("studio");
    const listed = (await unwrap(m.client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatar.avatarId);
    expect(listed?.origin).toBe("studio");
    expect(m.events.filter((e) => e.type === "avatar.changed").map((e) => (e.payload as { avatar: AvatarSummary }).avatar.origin)).toContain("studio");
  });

  test("an avatar made from an imported photo is imported", async () => {
    const m = makeMock({ avatars: [], portraits: [] });
    const avatar = await imported(m);
    expect(avatar.origin).toBe("imported");
    expect(impliedNudityOf(avatar)).toBe(false);
  });

  test("a Studio-created avatar draws implied covers at «Смелая», an imported one never does", async () => {
    const m = makeMock({ preset: "empty" });
    const studio = await picked(m);
    const bea = await imported(m);
    expect(await impliedOf(m, studio.avatarId)).toBeGreaterThan(0);
    expect(await impliedOf(m, bea.avatarId)).toBe(0);
  });
});
