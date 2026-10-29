import { describe, expect, test } from "bun:test";
import { type AvatarSummary } from "../../shared/engine";
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



describe("the mock's avatars carry their origin", () => {
  test("an avatar picked from the wizard's candidates is made in Studio, in the answer, the event and the list", async () => {
    const m = makeMock({ preset: "empty" });
    const avatar = await picked(m);
    expect(avatar.origin).toBe("studio");
    const listed = (await unwrap(m.client.request("avatars.list", {}))).avatars.find((a) => a.avatarId === avatar.avatarId);
    expect(listed?.origin).toBe("studio");
    expect(m.events.filter((e) => e.type === "avatar.changed").map((e) => (e.payload as { avatar: AvatarSummary }).avatar.origin)).toContain("studio");
  });

});
