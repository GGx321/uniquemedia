import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { tempDirFor } from "../testing/tempDir";
import { freeBytesOf, isNoSpaceError } from "./freeBytes";
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

describe("isNoSpaceError", () => {
  const ffmpegSaid = (tail: string): Error => Object.assign(new Error("ffmpeg exited 1"), { stderrTail: tail });

  test.each(["ENOSPC", "EDQUOT"])("the disk's own code %s is a full disk", (code) => {
    expect(isNoSpaceError(Object.assign(new Error("x"), { code }))).toBe(true);
  });

  test.each(["av_interleaved_write_frame(): No space left on device", "Error writing trailer: Disc quota exceeded", "Disk quota exceeded"])("ffmpeg saying «%s» is a full disk", (tail) => {
    expect(isNoSpaceError(ffmpegSaid(tail))).toBe(true);
  });

  test("any other ffmpeg stderr, any other code, and a non-error are not", () => {
    expect(isNoSpaceError(ffmpegSaid("Invalid data found when processing input"))).toBe(false);
    expect(isNoSpaceError(Object.assign(new Error("x"), { code: "EIO" }))).toBe(false);
    expect(isNoSpaceError("No space left on device")).toBe(false);
  });
});
