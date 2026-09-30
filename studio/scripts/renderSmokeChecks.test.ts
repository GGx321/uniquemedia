import { describe, expect, test } from "bun:test";
import type { Probed } from "../engine/render/ffmpeg.testkit";
import type { Mp4Facts } from "./mp4Facts";
import { renderedFileProblems, type RenderedFileEvidence } from "./renderSmokeChecks";

// What the packaged E2E asks of every file the packaged app renders (invariants 14 and 20), as a pure function of what ffprobe
// and the box reader found, so each rule can be shown to fire here, on synthetic evidence, and not only to pass on a real file.

const EXPECTED = { frames: 120, durationMs: 4_000 };

/** The evidence with its readonly fields writable, so a test can change one thing in it. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] extends readonly (infer U)[] ? Mutable<U>[] : T[K] extends object ? Mutable<T[K]> : T[K] };
type Evidence = Mutable<RenderedFileEvidence>;

function good(): Evidence {
  const probe: Mutable<Probed> = {
    streams: [
      {
        codec_type: "video", codec_name: "h264", profile: "High", width: 1080, height: 1920, pix_fmt: "yuv420p", r_frame_rate: "30/1", avg_frame_rate: "30/1",
        color_range: "tv", color_space: "bt709", color_transfer: "bt709", color_primaries: "bt709", nb_read_frames: "120", duration: "4.000000",
        tags: { language: "und", handler_name: "VideoHandler", vendor_id: "[0][0][0][0]", encoder: "Lavc61.3.100 libx264" },
      },
      { codec_type: "audio", codec_name: "aac", profile: "LC", sample_rate: "48000", channels: 2, duration: "3.990000", tags: { language: "und", handler_name: "SoundHandler" } },
    ],
    format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "4.000000", tags: { major_brand: "isom", minor_version: "512", compatible_brands: "isomiso2avc1mp41", encoder: "Lavf61.1.100" } },
  };
  const facts: Mutable<Mp4Facts> = {
    brands: { major: "isom", minor: 512, compatible: ["isom", "iso2", "avc1", "mp41"] },
    times: { mvhd: [{ creation: 0, modification: 0 }], tkhd: [{ creation: 0, modification: 0 }, { creation: 0, modification: 0 }], mdhd: [{ creation: 0, modification: 0 }, { creation: 0, modification: 0 }] },
    tool: "Lavf61.1.100",
    compressor: "Lavc61.3.100 libx264",
  };
  return { probe, facts };
}

/** `good()` with one change made by `edit`. */
function changed(edit: (evidence: Evidence) => void): string[] {
  const evidence = good();
  edit(evidence);
  return renderedFileProblems(EXPECTED, evidence);
}

const videoOf = (e: Evidence) => e.probe.streams[0] ?? (() => { throw new Error("no video"); })();
const audioOf = (e: Evidence) => e.probe.streams[1] ?? (() => { throw new Error("no audio"); })();

test("finds nothing wrong with a file that has exactly what the engine writes", () => {
  expect(renderedFileProblems(EXPECTED, good())).toEqual([]);
});

describe("exact length (invariant 20)", () => {
  test("refuses a file one frame short or long", () => {
    expect(changed((e) => { videoOf(e).nb_read_frames = "119"; })).toEqual(["the video holds 119 frames, expected 120"]);
    expect(changed((e) => { videoOf(e).nb_read_frames = "121"; })).toEqual(["the video holds 121 frames, expected 120"]);
  });

  test("allows a video stream 2 ms off its length, and refuses 3 ms", () => {
    expect(changed((e) => { videoOf(e).duration = "4.002000"; audioOf(e).duration = "3.992000"; })).toEqual([]);
    expect(changed((e) => { videoOf(e).duration = "4.003000"; audioOf(e).duration = "3.993000"; })).toEqual(["the video lasts 4003 ms, expected 4000 ms (±2)"]);
  });

  test("allows the audio from 1 ms over the video to 23 ms under it, the asymmetric tolerance, and refuses outside it", () => {
    expect(changed((e) => { audioOf(e).duration = "4.001000"; })).toEqual([]);
    expect(changed((e) => { audioOf(e).duration = "3.977000"; })).toEqual([]);
    expect(changed((e) => { audioOf(e).duration = "4.002000"; })).toEqual(["the audio is 2 ms longer than the video (at most 1 allowed)"]);
    expect(changed((e) => { audioOf(e).duration = "3.976000"; })).toEqual(["the audio is 24 ms shorter than the video (at most 23 allowed)"]);
  });
});

describe("format", () => {
  test("refuses a wrong size, frame rate, codec or pixel format, each by name", () => {
    expect(changed((e) => { videoOf(e).width = 720; })).toEqual(["the video is not H.264 High 1080x1920 yuv420p at 30/1 fps"]);
    expect(changed((e) => { videoOf(e).r_frame_rate = "25/1"; })).toEqual(["the video is not H.264 High 1080x1920 yuv420p at 30/1 fps"]);
    expect(changed((e) => { videoOf(e).codec_name = "hevc"; })).toEqual(["the video is not H.264 High 1080x1920 yuv420p at 30/1 fps"]);
  });

  test("refuses a missing colour tag", () => {
    expect(changed((e) => { delete videoOf(e).color_primaries; })).toEqual(["the video is not tagged BT.709 limited range in every field"]);
  });

  test("refuses audio that is not AAC-LC 48 kHz stereo", () => {
    expect(changed((e) => { audioOf(e).sample_rate = "44100"; })).toEqual(["the audio is not AAC-LC 48000 Hz stereo"]);
    expect(changed((e) => { audioOf(e).channels = 1; })).toEqual(["the audio is not AAC-LC 48000 Hz stereo"]);
  });

  test("refuses a third stream and a missing one", () => {
    expect(changed((e) => { e.probe.streams.push({ codec_type: "data" }); })).toEqual(["the file has 3 streams, expected a video and an audio stream"]);
    expect(changed((e) => { e.probe.streams.pop(); })).toEqual(["the file has 1 streams, expected a video and an audio stream"]);
  });
});

describe("the metadata allowlist (invariant 14)", () => {
  test("refuses any container tag outside the brands and the Lavf encoder, creation_time above all", () => {
    expect(changed((e) => { e.probe.format.tags = { ...e.probe.format.tags, creation_time: "2026-09-30T10:00:00.000000Z" }; })).toEqual(["the container carries tags outside the allowlist: creation_time"]);
    expect(changed((e) => { e.probe.format.tags = { ...e.probe.format.tags, title: "x" }; })).toEqual(["the container carries tags outside the allowlist: title"]);
  });

  test("refuses a container tag the engine always writes going missing", () => {
    expect(changed((e) => { delete e.probe.format.tags?.encoder; })).toEqual(["the container's tags are not exactly major_brand, minor_version, compatible_brands and encoder"]);
  });

  test("refuses a stream tag outside the allowlist, and a stream's own creation_time", () => {
    expect(changed((e) => { videoOf(e).tags = { ...videoOf(e).tags, creation_time: "2026-09-30T10:00:00Z" }; })).toEqual(["a stream carries tags outside the allowlist: creation_time"]);
  });

  test("allows a missing vendor_id (Windows' ffprobe 4.4 omits it) and refuses a vendor that is not zero", () => {
    expect(changed((e) => { delete videoOf(e).tags?.vendor_id; })).toEqual([]);
    expect(changed((e) => { videoOf(e).tags = { ...videoOf(e).tags, vendor_id: "appl" }; })).toEqual(["a stream's vendor_id is not zero"]);
  });

  test("refuses handler names that are not the engine's and an audio stream with an encoder tag", () => {
    expect(changed((e) => { videoOf(e).tags = { ...videoOf(e).tags, handler_name: "Core Media Video" }; })).toEqual(["the streams' handler names are not VideoHandler and SoundHandler"]);
    expect(changed((e) => { audioOf(e).tags = { ...audioOf(e).tags, encoder: "Lavc61.3.100 aac" }; })).toEqual(["the audio stream carries an encoder tag"]);
  });

  test("refuses a creation or modification time that is not zero, in mvhd, a tkhd or an mdhd", () => {
    expect(changed((e) => { e.facts.times.mvhd[0] = { creation: 3_700_000_000, modification: 0 }; })).toEqual(["a creation or modification time is not zero: mvhd"]);
    expect(changed((e) => { e.facts.times.tkhd[1] = { creation: 0, modification: 5 }; })).toEqual(["a creation or modification time is not zero: tkhd"]);
    expect(changed((e) => { e.facts.times.mdhd[0] = { creation: 1, modification: 1 }; })).toEqual(["a creation or modification time is not zero: mdhd"]);
  });

  test("refuses a file whose times were not found at all, rather than reading no times as all-zero", () => {
    expect(changed((e) => { e.facts.times.mvhd.length = 0; })).toEqual(["the file has no mvhd time to check"]);
    expect(changed((e) => { e.facts.times.tkhd.length = 0; })).toEqual(["the file has no tkhd time to check"]);
  });

  test("refuses a tool string or a compressor name that is not the engine's", () => {
    expect(changed((e) => { e.facts.tool = "HandBrake 1.7"; })).toEqual(["the ©too string is not Lavf<version>: HandBrake 1.7"]);
    expect(changed((e) => { e.facts.compressor = "x264 core 164"; })).toEqual(["the compressor name is not Lavc<version> libx264: x264 core 164"]);
    expect(changed((e) => { e.facts.tool = null; })).toEqual(["the file has no ©too string"]);
  });

  test("refuses brands outside isom, iso2, avc1 and mp41 and a major brand that is not isom", () => {
    expect(changed((e) => { e.facts.brands.compatible = ["isom", "qt  "]; })).toEqual(["the ftyp brands are outside the allowlist: qt  "]);
    expect(changed((e) => { e.facts.brands.major = "mp42"; })).toEqual(["the ftyp major brand is mp42, expected isom"]);
  });
});

test("reports every problem a file has, not only the first", () => {
  const problems = changed((e) => {
    videoOf(e).nb_read_frames = "100";
    e.facts.times.mvhd[0] = { creation: 1, modification: 1 };
  });

  expect(problems).toHaveLength(2);
});
