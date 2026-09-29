import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import { verifyAndHashMp4 } from "./verifyMp4";
import { FIXTURE_FRAMES, renderFixture, type Fixture } from "./verify.testkit";
useNativeGlobals();

// Task 3a.8b.1: the commit needs the file's sha256 for its record, and the
// hash must come from the SAME read as the verification (Commit row, step 2):
// a second read would leave a window in which the file could change between
// "verified" and "hashed".

let fx: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-hash");
}, 180_000);
afterAll(() => {
  if (fx) removeDir(fx.dir);
});

describe("verifyAndHashMp4", () => {
  test("returns the sha256 and the size of the very bytes it verified", async () => {
    const out = await verifyAndHashMp4(fx.path, { frames: FIXTURE_FRAMES });
    expect(out.result).toEqual({ ok: true });
    expect(out.sha256).toBe(createHash("sha256").update(readFileSync(fx.path)).digest("hex"));
    expect(out.bytes).toBe(fx.bytes.length);
  });

  test("a wrong frame count is refused, and the hash is still the file's", async () => {
    const out = await verifyAndHashMp4(fx.path, { frames: FIXTURE_FRAMES + 1 });
    expect(out.result.ok).toBe(false);
    expect(out.sha256).toBe(createHash("sha256").update(readFileSync(fx.path)).digest("hex"));
  });

  test("a file over the size cap is refused without being read, so there is no hash", async () => {
    const out = await verifyAndHashMp4(fx.path, { frames: FIXTURE_FRAMES }, { maxBytes: 1000 });
    expect(out.result.ok).toBe(false);
    expect(out.sha256).toBeNull();
  });
});
