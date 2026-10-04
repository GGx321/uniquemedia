import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { tempDirFor } from "../testing/tempDir";
import { freeBytesOf } from "./freeBytes";
useNativeGlobals();

// The one answer to «how much room does this volume have», for the render's folder (the layer pass and the own videos' copies), 3f.3b L-2.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-free-bytes-");

describe("freeBytesOf", () => {
  test("is a positive whole number of bytes for a folder that exists", async () => {
    const free = await freeBytesOf(tmp());
    expect(typeof free).toBe("number");
    expect(free).toBeGreaterThan(0);
  });

  test("is null, never a throw, for a folder that is not there", async () => {
    expect(await freeBytesOf(join(tmp(), "nothing-here"))).toBeNull();
  });
});
