import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { buildMp4, type Mp4Spec } from "./testing/mp4VideoBuilder";
import { bytesSource, probeVideo, type VideoProbe } from "./videoProbe";
useNativeGlobals();

// 3f.6: a file the walker takes no video from says how many SOUND tracks it has, so the one drop zone can route an audio-only MP4 or MOV (Android recorders write
// them under the `isom` brand) to the audio importer. The count is the walker's own reading of every `hdlr` (the same one that refuses a hidden handler), never ffmpeg's.

const probe = (spec: Mp4Spec): Promise<VideoProbe> => probeVideo(bytesSource(buildMp4(spec)));

async function refused(spec: Mp4Spec): Promise<Extract<VideoProbe, { ok: false }>> {
  const result = await probe(spec);
  if (result.ok) throw new Error("expected the file to be refused");
  return result;
}

describe("a file with no video track", () => {
  test("says no-video-track and counts its sound tracks: one", async () => {
    expect(await refused({ tracks: [{ handler: "soun" }] })).toEqual({ ok: false, reason: "no-video-track", audioTracks: 1 });
  });

  test("counts two sound tracks as two", async () => {
    expect(await refused({ tracks: [{ handler: "soun" }, { handler: "soun" }] })).toMatchObject({ reason: "no-video-track", audioTracks: 2 });
  });

  test("counts none for a file with no track at all, and for tracks that are not sound", async () => {
    expect(await refused({ tracks: [] })).toMatchObject({ reason: "no-video-track", audioTracks: 0 });
    expect(await refused({ tracks: [{ handler: "meta" }, { handler: "text" }] })).toMatchObject({ reason: "no-video-track", audioTracks: 0 });
  });

  test("counts the sound tracks among others that are not sound", async () => {
    expect(await refused({ tracks: [{ handler: "meta" }, { handler: "soun" }, { handler: "text" }] })).toMatchObject({ audioTracks: 1 });
  });
});

describe("a refusal for any other reason", () => {
  test("carries no count: the file was not judged to be one with no video", async () => {
    const result = await refused({ tracks: [{ handler: "vide" }, { handler: "vide" }] });
    expect(result.reason).toBe("several-video-tracks");
    expect(result).not.toHaveProperty("audioTracks");
  });

  test("a file that is no MP4 at all carries none either", async () => {
    const result = await probeVideo(bytesSource(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9])));
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty("audioTracks");
  });
});

describe("a file with a video track", () => {
  test("is read as before, with its sound tracks counted as before", async () => {
    const result = await probe({ tracks: [{ handler: "vide" }, { handler: "soun" }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.info.audioTracks).toBe(1);
  });
});
