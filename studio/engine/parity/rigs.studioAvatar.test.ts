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

// 5a.4 (S5.BA7): the other options the «Смелая»-everywhere stories ask for seed the same world in both rigs.
describe("the parity world of the «Смелая»-everywhere stories", () => {
  test.each(["mock", "real"] as const)("%s: boldCustom lists the water category and preBoldSet holds Mia's unwritten set", async (which) => {
    const options = { launch: true, boldCustom: true, preBoldSet: true } as const;
    const rig = which === "mock" ? mockRig(options) : await realRig(dir(), options);
    try {
      const listed = await rig.send("categories.list", {});
      const categories: unknown[] = listed.ok && Array.isArray(listed.result.categories) ? listed.result.categories : [];
      expect(categories.some((c) => typeof c === "object" && c !== null && "categoryId" in c && c.categoryId === "cat-parity-0003")).toBe(true);
      const got = await rig.send("scenes.get", { avatarId: rig.world.avatarId });
      const set = got.ok ? got.result.sceneSet : null;
      const scenes: unknown[] = typeof set === "object" && set !== null && "scenes" in set && Array.isArray(set.scenes) ? set.scenes : [];
      const routed = scenes.filter((s) => typeof s === "object" && s !== null && "route" in s && s.route === "seedream").length;
      expect({ scenes: scenes.length, routed, written: scenes.filter((s) => typeof s === "object" && s !== null && "text" in s && s.text !== null).length }).toEqual({ scenes: 8, routed: 4, written: 0 });
    } finally {
      await rig.stop();
    }
  });

  test.each(["mock", "real"] as const)("%s: clips.boldHome seeds Lia a «Дом» frame on the Seedream route", async (which) => {
    const clips = which === "mock" ? mockRig({ clips: { boldHome: true } }) : await realRig(dir(), { clips: { boldHome: true } });
    try {
      const boldHome = clips.world.clipWorld?.boldHome;
      if (boldHome === undefined) throw new Error("no routed «Дом» frame");
      const photos = await clips.send("photos.list", { avatarId: clips.world.clipWorld?.avatarId });
      const listed: unknown[] = photos.ok && Array.isArray(photos.result.photos) ? photos.result.photos : [];
      const photo = listed.find((p) => typeof p === "object" && p !== null && "photoId" in p && p.photoId === boldHome);
      expect(typeof photo === "object" && photo !== null && "route" in photo && "category" in photo ? { route: photo.route, category: photo.category } : null).toEqual({ route: "seedream", category: "home" });
    } finally {
      await clips.stop();
    }
  });
});
