import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { useNativeGlobals } from "../../../../testing/nativeGlobals";
import { openFileSource } from "../../../media/video/fileSource";
import { probeVideo } from "../../../media/video/videoProbe";
import { lumaGrid, rampIndexOf } from "../mezzanineKit";
import { RAMP } from "./index";
useNativeGlobals();

// The mezzanine fixture is committed bytes, pinned by size and sha256, and it is what `generate.ts` says: a stored own video whose frame `i` reads back as `i`.

describe("the ramp mezzanine", () => {
  test("is the pinned size and sha256, and small enough to commit", async () => {
    const bytes = await readFile(RAMP.file);
    expect({ bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual({ bytes: RAMP.bytes, sha256: RAMP.sha256 });
    expect((await stat(RAMP.file)).size).toBeLessThanOrEqual(16 * 1024);
  });

  test("is a stored own video the importer's own walker reads: H.264, upright, 96 x 192, 90 frames, constant 30 fps, no audio", async () => {
    const opened = await openFileSource(RAMP.file);
    try {
      const probe = await probeVideo(opened.source);
      if (!probe.ok) throw new Error(`the fixture was refused: ${probe.reason}`);
      const { video } = probe.info;
      expect([video.fourcc, video.dynamicRange, video.width, video.height, video.samples, video.rotation, video.variableFrameRate, probe.info.audioTracks]).toEqual(["avc1", "sdr", RAMP.width, RAMP.height, RAMP.frames, 0, false, 0]);
    } finally {
      await opened.close();
    }
  });

  test("frame i reads back as i, for all 90 frames (the property every trim test stands on)", () => {
    const frames = lumaGrid(RAMP.file, 2, 2);
    expect(frames).toHaveLength(RAMP.frames);
    expect(frames.map((frame) => rampIndexOf(frame[0] ?? 0))).toEqual(Array.from({ length: RAMP.frames }, (_, i) => i));
  });
});
