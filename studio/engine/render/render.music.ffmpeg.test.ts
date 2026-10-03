import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { totalFrames } from "../../shared/montage";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { musicTracks } from "../music/fixtures";
import { trackForbiddenStrings } from "../music/trackTags";
import { makeTaggedTrack, TAG_ARTIST, TAG_HANDLER, TAG_TITLE, tagForms } from "../music/testing/taggedTrack";
import { measureTruePeak } from "../renderQueue/musicMeasure";
import { verifyAndHashMp4 } from "../verify";
import { runBinary, probeJson, probeVideo, type Probed, type ProbedStream } from "./ffmpeg.testkit";
import { sampleEntryVendors, walkBoxes } from "./mp4Boxes.testkit";
import { buildMusicMeasure, musicGainDb, parseTruePeak } from "./musicChain";
import { buildPass1 } from "./pass1";
import { buildPass2 } from "./pass2";
import { makeSolid, makeWorkDir, readBytes, removeDir, runPass1, runPass2 } from "./render.testkit";
import { runFfmpegOk } from "./ffmpeg.testkit";
useNativeGlobals();

// REAL ffmpeg, pass 2 with music (3c.5): the three peak fixtures of invariant 21 (hot, threshold, quiet) and the 48 kHz one are
// measured on their clip segment, attenuated by the rule, rendered, and the FINISHED file is measured again. Exact A/V length
// (invariant 20), 48 kHz stereo, and the metadata allowlist with a track that carries title and artist tags in UTF-8 and UTF-16
// (invariant 14, searched by the production verifier and by a byte search). SLOW: about 20 s.

const CLIPS: Clip[] = [0, 1, 2].map((i) => ({ clipId: `c${i}`, durationMs: 2000, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "flat" }, focus: null }, motion: "static" }));
const MONTAGE_MS = 6000;
const FRAMES = 180;

interface Pick {
  readonly name: string;
  readonly path: string;
  readonly startMs: number;
  /** The whole excerpt's true peak, pinned by the fixtures (the segment is within 0.2 dB of it for these starts). */
  readonly pinnedPeak: number;
  readonly expectedGain: number;
}

// The 6 s segment sits inside the 8 s excerpts at 2 s, and fills the 6.02 s one from 0.
const PICKS: readonly Pick[] = [
  { name: "hot", path: musicTracks.hot.file, startMs: 2000, pinnedPeak: musicTracks.hot.truePeakDbtp, expectedGain: -4.5 },
  { name: "threshold", path: musicTracks.threshold.file, startMs: 2000, pinnedPeak: musicTracks.threshold.truePeakDbtp, expectedGain: 0 },
  { name: "quiet", path: musicTracks.quiet.file, startMs: 2000, pinnedPeak: musicTracks.quiet.truePeakDbtp, expectedGain: 0 },
  { name: "he48k", path: musicTracks.he48k.file, startMs: 0, pinnedPeak: musicTracks.he48k.truePeakDbtp, expectedGain: 0 },
];

interface Rendered {
  readonly pick: Pick;
  readonly segmentPeak: number;
  readonly gain: number;
  readonly output: string;
  readonly probe: Probed;
  readonly outputPeak: number;
  readonly bytes: Uint8Array;
}

let dir: string;
const rendered = new Map<string, Rendered>();
let tagged: Rendered;
let taggedSource: Uint8Array;
let leaky: { output: string; bytes: Uint8Array };
let unguardedOut: { output: string; bytes: Uint8Array };
let padded: Rendered;

const signal = new AbortController().signal;

/** Measures the segment, applies the rule, builds and runs pass 2 over the shared intermediates, and measures the finished file. */
async function renderWith(pick: Pick, outName: string, mutate: (argv: readonly string[]) => string[] = (a) => [...a]): Promise<Rendered> {
  const segmentPeak = await measureTruePeak(buildMusicMeasure({ path: pick.path, startMs: pick.startMs, durationMs: MONTAGE_MS }), { signal, timeoutMs: 30_000 });
  const gain = musicGainDb(segmentPeak);
  const output = join(dir, outName);
  const job = buildPass2({ clips: CLIPS, clipDir: dir, output, overlays: [], audio: { kind: "music", path: pick.path, startMs: pick.startMs, gainDb: gain } });
  await runPass2({ ...job, argv: mutate(job.argv) });
  const outputPeak = parseTruePeak((await runBinary(ffmpegPath(), ["-hide_banner", "-nostdin", "-nostats", "-i", output, "-map", "0:a:0", "-af", "ebur128=peak=true:framelog=quiet", "-vn", "-f", "null", "-"])).stderr);
  return { pick, segmentPeak, gain, output, probe: await probeVideo(output), outputPeak, bytes: readBytes(output) };
}

beforeAll(async () => {
  dir = makeWorkDir("music");
  const flat = join(dir, "flat.jpg");
  await makeSolid(flat, "0x808080", 720, 1280, "jpeg");
  await runPass1(buildPass1({ seed: 1, clips: CLIPS, resolvePhoto: () => ({ path: flat, width: 720, height: 1280 }), clipDir: dir }));
  for (const pick of PICKS) rendered.set(pick.name, await renderWith(pick, `${pick.name}.mp4`));

  const taggedPath = await makeTaggedTrack(dir, musicTracks.hot.file);
  taggedSource = readBytes(taggedPath);
  const taggedPick: Pick = { name: "tagged", path: taggedPath, startMs: 2000, pinnedPeak: musicTracks.hot.truePeakDbtp, expectedGain: -4.5 };
  tagged = await renderWith(taggedPick, "tagged.mp4");
  // Controls: the search below must be able to see a leak. (1) The track's handler name forced into the output stream, on every
  // platform. (2) The same render with the stream-metadata guard taken out: whether ffmpeg then copies the track's stream
  // metadata depends on its build (macOS 6.0 does, the Linux canary's does not), so what is checked is only the implication.
  const forced = await renderWith(taggedPick, "tagged-forced.mp4", (argv) => [...argv.slice(0, -1), "-metadata:s:a:0", `handler_name=${TAG_HANDLER}`, argv.at(-1) ?? ""]);
  leaky = { output: forced.output, bytes: forced.bytes };
  const unguarded = await renderWith(taggedPick, "tagged-unguarded.mp4", (argv) => argv.filter((_, i) => !(argv[i] === "-map_metadata:s:a:0" || argv[i - 1] === "-map_metadata:s:a:0")));
  unguardedOut = { output: unguarded.output, bytes: unguarded.bytes };
  // A track that ends 3 s before the montage does (the builder's floor: silence is padded in, the length stays exact).
  padded = await renderWith({ name: "padded", path: musicTracks.he48k.file, startMs: 3000, pinnedPeak: -5.5, expectedGain: 0 }, "padded.mp4");
}, 240_000);

afterAll(() => removeDir(dir));

const videoOf = (r: Rendered): ProbedStream => {
  const v = r.probe.streams.find((s) => s.codec_type === "video");
  if (!v) throw new Error("no video stream");
  return v;
};
const audioOf = (r: Rendered): ProbedStream => {
  const a = r.probe.streams.find((s) => s.codec_type === "audio");
  if (!a) throw new Error("no audio stream");
  return a;
};
const got = (name: string): Rendered => {
  const r = rendered.get(name);
  if (!r) throw new Error(`no render ${name}`);
  return r;
};

describe("invariant 21 on real ffmpeg: audio peak safety, with the three fixtures", () => {
  test.each(PICKS.map((p) => [p.name] as const))("%s: the segment's true peak is the one the fixture pins, within 0.2 dB", (name) => {
    const r = got(name);
    expect(Math.abs(r.segmentPeak - r.pick.pinnedPeak)).toBeLessThanOrEqual(0.2);
  });

  test.each(PICKS.map((p) => [p.name] as const))("%s: the gain is min(0, -1.5 - TP) and never positive", (name) => {
    const r = got(name);
    expect(r.gain).toBe(r.pick.expectedGain);
    expect(r.gain).toBe(musicGainDb(r.segmentPeak));
    expect(r.gain).toBeLessThanOrEqual(0);
  });

  test("hot: needs -4.5 dB, the +3.0 dBTP of the hottest cached track", () => {
    expect(got("hot").segmentPeak).toBeCloseTo(3.0, 1);
    expect(got("hot").gain).toBe(-4.5);
  });

  test("threshold: -1.6 dBTP is already under the target, so it is not touched", () => {
    expect(got("threshold").gain).toBe(0);
  });

  test("quiet: is not raised", () => {
    expect(got("quiet").gain).toBe(0);
  });

  test.each(PICKS.map((p) => [p.name] as const))("%s: the finished file's true peak is at most -1.5 dBTP within the AAC re-encode's 0.1 dB, and always under -1 dBTP", (name) => {
    const r = got(name);
    expect(r.outputPeak).toBeLessThanOrEqual(-1.4);
    expect(r.outputPeak).toBeLessThanOrEqual(-1);
  });

  test("hot: lands under the target and not far under it (the music keeps its own level)", () => {
    // Re-encoding HE-AAC as AAC-LC at 192 kbit/s lowers a loud peak by about half a dB, so the finished file sits at or under -1.5.
    expect(got("hot").outputPeak).toBeGreaterThanOrEqual(-2.5);
    expect(got("hot").outputPeak).toBeLessThanOrEqual(-1.4);
  });

  test.each([["threshold"], ["quiet"], ["he48k"]] as const)("%s: a track that needs no attenuation is not raised, and loses at most the re-encode's half dB", (name) => {
    const r = got(name);
    expect(r.outputPeak - r.segmentPeak).toBeLessThanOrEqual(0.1);
    expect(r.outputPeak - r.segmentPeak).toBeGreaterThanOrEqual(-0.6);
  });
});

describe("invariant 20 on real ffmpeg: exact A/V length, 48 kHz stereo", () => {
  test.each(PICKS.map((p) => [p.name] as const))("%s: the audio is AAC at 48 kHz in stereo", (name) => {
    const a = audioOf(got(name));
    expect({ codec: a.codec_name, rate: a.sample_rate, channels: a.channels }).toEqual({ codec: "aac", rate: "48000", channels: 2 });
  });

  test("the 44.1 kHz fixtures come out at 48 kHz, as do the 48 kHz one", () => {
    expect(musicTracks.hot.sampleRate).toBe(44100);
    expect(audioOf(got("hot")).sample_rate).toBe("48000");
    expect(audioOf(got("he48k")).sample_rate).toBe("48000");
  });

  test.each(PICKS.map((p) => [p.name] as const))("%s: the video is exactly the clips' frames", (name) => {
    expect(totalFrames(CLIPS)).toBe(FRAMES);
    expect(Number(videoOf(got(name)).nb_read_frames)).toBe(FRAMES);
  });

  test.each([...PICKS.map((p) => [p.name] as const), ["padded"] as const])("%s: the audio is at most the video's length and at least one AAC frame (21.3 ms) short of it, no more", (name) => {
    const r = name === "padded" ? padded : got(name);
    const gap = Number(videoOf(r).duration) - Number(audioOf(r).duration);
    expect(gap).toBeGreaterThanOrEqual(-0.0005);
    expect(gap).toBeLessThanOrEqual(0.0213);
  });

  test("a track that ends before the montage does is padded with silence to the exact length, never left short", () => {
    expect(Number(audioOf(padded).duration)).toBeGreaterThan(5.97);
    expect(Number(videoOf(padded).duration)).toBeCloseTo(6, 3);
  });

  test.each(PICKS.map((p) => [p.name] as const))("%s: the production verifier accepts the file for %d frames", async (name) => {
    expect((await verifyAndHashMp4(got(name).output, { frames: FRAMES })).result).toEqual({ ok: true });
  });

  test("keeps no fade: a loud track is as loud 0.1 s in as 0.1 s before its end", async () => {
    // A fade-in or fade-out would bring the edge towards silence; volumedetect reports the loudest sample of a window.
    const loudest = async (from: number, to: number): Promise<number> => {
      const r = await runBinary(ffmpegPath(), ["-hide_banner", "-nostdin", "-i", got("hot").output, "-map", "0:a:0", "-af", `atrim=start=${from}:end=${to},volumedetect`, "-vn", "-f", "null", "-"]);
      const match = /max_volume:\s*(-?\d+(?:\.\d+)?) dB/.exec(r.stderr);
      if (match?.[1] === undefined) throw new Error("volumedetect printed no max_volume");
      return Number(match[1]);
    };
    expect(await loudest(0.05, 0.25)).toBeGreaterThan(-12);
    expect(await loudest(5.75, 5.95)).toBeGreaterThan(-12);
  });
});

describe("invariant 14 on real ffmpeg: a track that carries title and artist tags", () => {
  const tagTexts = [TAG_TITLE, TAG_ARTIST, TAG_HANDLER];
  // What the render itself hands the verifier for this track: built from the file's own bytes, not from a list written here.
  const forbidden = (): string[] => trackForbiddenStrings(taggedSource, []);

  test("the source file really holds the tags: UTF-8 in its ilst, and UTF-16 in its ID3v2 frames (so the search below is not vacuous)", () => {
    const has = (bytes: Uint8Array, needle: Uint8Array): boolean => Buffer.from(bytes).includes(Buffer.from(needle));
    for (const text of [TAG_TITLE, TAG_ARTIST]) {
      const forms = tagForms(text);
      expect(has(taggedSource, forms[0]?.bytes ?? new Uint8Array())).toBe(true);
      expect(has(taggedSource, forms[1]?.bytes ?? new Uint8Array())).toBe(true);
    }
    expect(has(taggedSource, Uint8Array.from(Buffer.from(TAG_HANDLER)))).toBe(true);
  });

  test.each(tagTexts.flatMap((text) => tagForms(text).map((form) => [form.label, form.bytes] as const)))("the output holds none of %s", (_label, bytes) => {
    expect(Buffer.from(tagged.bytes).includes(Buffer.from(bytes))).toBe(false);
  });

  test("the forbidden list the render builds from the track's own bytes holds its title, its artist and its handler name", () => {
    expect(forbidden()).toEqual(expect.arrayContaining(tagTexts));
  });

  test("the full tag set of the output, read by ffprobe, is the allowlist exactly: nothing of the track's, nothing added", async () => {
    const probed = await probeJson(tagged.output, ["-show_entries", "format_tags:stream_tags"]);
    // The container: the brand tags and the Lavf encoder, as for a silent video.
    expect(Object.keys(probed.format.tags ?? {}).sort()).toEqual(["compatible_brands", "encoder", "major_brand", "minor_version"]);
    expect(probed.format.tags?.encoder).toMatch(/^Lavf\d+\.\d+\.\d+$/);
    // The streams: a handler name that is the engine's own, an undefined language, a zero vendor id or none, and the x264 signature on the video only.
    const [video, audio] = probed.streams;
    expect(video?.tags?.handler_name).toBe("VideoHandler");
    expect(audio?.tags?.handler_name).toBe("SoundHandler");
    expect(video?.tags?.encoder).toMatch(/^Lavc\d+\.\d+\.\d+ libx264$/);
    expect(audio?.tags?.encoder).toBeUndefined();
    const allowedKeys = new Set(["language", "handler_name", "vendor_id", "encoder"]);
    for (const stream of probed.streams) {
      expect(Object.keys(stream.tags ?? {}).filter((key) => !allowedKeys.has(key))).toEqual([]);
      expect(stream.tags?.language).toBe("und");
      expect([undefined, "[0][0][0][0]"]).toContain(stream.tags?.vendor_id);
    }
    // And every value in the whole tag set is one of the allowlist's, none of it a string of the track's.
    const everyValue = [...Object.values(probed.format.tags ?? {}), ...probed.streams.flatMap((s) => Object.values(s.tags ?? {}))];
    for (const text of forbidden()) expect(everyValue.some((value) => value.includes(text))).toBe(false);
  });

  test("the box walker agrees: the sample entries' vendor fields are zero", () => {
    expect(sampleEntryVendors(tagged.bytes, walkBoxes(tagged.bytes))).toEqual(["\\0\\0\\0\\0", "\\0\\0\\0\\0"]);
  });

  test("the production verifier, given the tags as forbiddenStrings (it searches UTF-8 and both UTF-16 orders), finds nothing", async () => {
    const { result } = await verifyAndHashMp4(tagged.output, { frames: FRAMES, forbiddenStrings: forbidden() });
    expect(result).toEqual({ ok: true });
  });

  test("the audio stream carries the engine's own handler name, not the track's", () => {
    expect(audioOf(tagged).tags?.["handler_name"]).toBe("SoundHandler");
  });

  test("the file's tags reach no stream and no container tag", async () => {
    const probe = await probeVideo(tagged.output);
    expect(probe.format.tags ?? {}).not.toHaveProperty("title");
    expect(probe.format.tags ?? {}).not.toHaveProperty("artist");
    for (const stream of probe.streams) expect(JSON.stringify(stream.tags ?? {})).not.toContain("Core Media");
  });

  test("control: a handler name forced into the output stream IS found by the byte search, and the verifier refuses the file", async () => {
    expect(Buffer.from(leaky.bytes).includes(Buffer.from(TAG_HANDLER))).toBe(true);
    const { result } = await verifyAndHashMp4(leaky.output, { frames: FRAMES, forbiddenStrings: forbidden() });
    expect(result.ok).toBe(false);
  });

  test("without the stream-metadata guard, whatever ffmpeg copies from the track, the verifier refuses the file exactly when its text got through", async () => {
    const leaked = Buffer.from(unguardedOut.bytes).includes(Buffer.from(TAG_HANDLER));
    const { result } = await verifyAndHashMp4(unguardedOut.output, { frames: FRAMES, forbiddenStrings: forbidden() });
    expect(result.ok).toBe(!leaked);
  });
});

describe("the decode and the measurement agree with what the render does", () => {
  test("the input is read with a forced AAC decoder and the mov demuxer: a track that is not an MP4 produces no audio", async () => {
    const notMp4 = join(dir, "not-mp4.m4a");
    await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:a", "pcm_s16le", "-f", "wav", notMp4]);
    const outcome = await measureTruePeak(buildMusicMeasure({ path: notMp4, startMs: 0, durationMs: 1000 }), { signal, timeoutMs: 30_000 }).catch((e: unknown) => e);
    expect(outcome).toBeInstanceOf(Error);
  });
});
