import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "./envelope";
import { AvatarSummary } from "./state";

// 5a.4 (S5.BA1, plan s5a4 I5.74, I5.80): `AvatarSummary.origin` is an OPTIONAL additive field, "studio" | "imported". The protocol stays at 5. An avatar listed without it
// serialises byte for byte as before; the engine fills it in a later task (BA5), and an absent origin is read as imported (fail-closed).

const summary = {
  avatarId: "avatar-0001",
  name: "Nini",
  descriptor: { age: 25, text: "25-year-old woman, hazel eyes" },
  masterPhotoId: "photo-0010",
  createdAt: "2026-10-11T10:00:00.000Z",
  status: "active",
  photoCount: 0,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

describe("AvatarSummary.origin", () => {
  test.each(["studio", "imported"])("%s is kept as written", (origin) => {
    expect(AvatarSummary.parse({ ...summary, origin }).origin).toBe(origin);
  });

  test("an avatar listed without an origin parses and gains none", () => {
    const parsed = AvatarSummary.parse(summary);
    expect("origin" in parsed).toBe(false);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(summary));
  });

  test.each(["", "created", "Studio", null, 1])("an origin of %p is refused", (origin) => {
    expect(AvatarSummary.safeParse({ ...summary, origin }).success).toBe(false);
  });

  test("the protocol stays at 5: the field is additive", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});
