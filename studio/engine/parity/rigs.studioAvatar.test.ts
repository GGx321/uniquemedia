import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useEngineDir } from "../testing/engineHarness";
import { mockRig, realRig, type ParityRig } from "./testing/rigs";
useNativeGlobals();

// 5a.4 (S5.BA7, plan s5a4 §5.11 story 7, §8 BA7, r2.1 N2, I5.74): the parity world's origins. Mia's master is seeded with `SAMPLE_SOURCE`, which has no wizard slot, so both engines read
// her as imported (the fail-closed side); the `studioAvatar` rig option seeds a second avatar whose master is a wizard candidate, which both read as made in Studio.

const dir = useEngineDir("studio-parity-origin-");

async function originsOf(rig: ParityRig): Promise<Record<string, string | undefined>> {
  const answer = await rig.send("avatars.list", {});
  if (!answer.ok) throw new Error(`avatars.list was refused: ${answer.error.code}`);
  const avatars: unknown[] = Array.isArray(answer.result.avatars) ? answer.result.avatars : [];
  const origins: Record<string, string | undefined> = {};
  for (const avatar of avatars) {
    if (typeof avatar !== "object" || avatar === null || !("avatarId" in avatar) || typeof avatar.avatarId !== "string") continue;
    origins[avatar.avatarId] = "origin" in avatar && typeof avatar.origin === "string" ? avatar.origin : undefined;
  }
  return origins;
}

/** What the engine's `impliedNudityOf` reads of an origin: only «studio» is Studio-created; anything else, an absent one included, is the imported side. */
const side = (origin: string | undefined): "studio" | "imported" => (origin === "studio" ? "studio" : "imported");

describe("the parity world's origins (studioAvatar)", () => {
  test.each(["mock", "real"] as const)("%s: Mia reads as imported and the studioAvatar avatar as made in Studio", async (which) => {
    const rig = which === "mock" ? mockRig({ studioAvatar: true }) : await realRig(dir(), { studioAvatar: true });
    try {
      const studioAvatarId = rig.world.studioAvatarId;
      if (studioAvatarId === undefined) throw new Error("the rig seeded no Studio-created avatar");
      const origins = await originsOf(rig);
      expect({ mia: side(origins[rig.world.avatarId]), studio: side(origins[studioAvatarId]) }).toEqual({ mia: "imported", studio: "studio" });
    } finally {
      await rig.stop();
    }
  });

  test.each(["mock", "real"] as const)("%s: without the option no such avatar is seeded", async (which) => {
    const rig = which === "mock" ? mockRig() : await realRig(dir());
    try {
      expect(rig.world.studioAvatarId).toBeUndefined();
      expect(Object.values(await originsOf(rig)).map(side)).not.toContain("studio");
    } finally {
      await rig.stop();
    }
  });
});
