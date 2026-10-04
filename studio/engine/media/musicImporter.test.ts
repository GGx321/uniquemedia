import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { FfmpegSpawner } from "../../node/runFfmpeg";
import { heavyTest } from "../../testing/bunTiers";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { judgeStoredDump, probeDump } from "./audioProbe";
import { FIXTURE_TAGS, fixtureBytes, musicFixtures, type MusicFixtureName } from "./fixtures/music";
import type { MediaImportOutcome } from "./imports";
import { flacClaiming, flacOfSeconds, hangingChild, isAlive, oneAacFrame, printingChild, recordingSpawner, wavOf } from "./musicFixtures.testkit";
import { createMusicImporter, MAX_TRACK_MS, type MusicImporterDeps } from "./musicImporter";
import { handoff, type Handoff } from "./photoFixtures.testkit";
import type { MediaFormat } from "./sniff";
useNativeGlobals();

// The own-music importer (Stage 3, 3f.4), against the bundled ffmpeg and the committed fixtures: every accepted format becomes AAC-LC 48 kHz stereo in
// an m4a with no tag and no picture; what it turns away and why; that the length is judged from the DECODED output and the decode is cut at the cap;
// that ffmpeg is pinned to what was judged; and that a cancel kills the child.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-music-importer-");
const signal = (): AbortSignal => new AbortController().signal;

const importerWith = (extra: MusicImporterDeps = {}): ReturnType<typeof createMusicImporter> => createMusicImporter(extra);

async function run(bytes: Uint8Array, format: MediaFormat, extra: MusicImporterDeps = {}): Promise<{ outcome: MediaImportOutcome; hand: Handoff }> {
  const hand = await handoff(tmp(), bytes, { format, kind: "audio" });
  return { outcome: await importerWith(extra)(hand.request), hand };
}

async function runFixture(name: MusicFixtureName, extra: MusicImporterDeps = {}): Promise<{ outcome: MediaImportOutcome; hand: Handoff }> {
  return run(fixtureBytes(name), musicFixtures[name].format, extra);
}

interface Accepted {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly durationMs: number;
  readonly waveform: readonly number[];
}

async function accepted(result: { outcome: MediaImportOutcome }): Promise<Accepted> {
  const { outcome } = result;
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  if (outcome.output === undefined) throw new Error("no output file");
  expect(outcome.output.format).toBe("m4a");
  expect(outcome.facts.durationMs).not.toBeNull();
  return { path: outcome.output.file.path, bytes: new Uint8Array(await readFile(outcome.output.file.path)), durationMs: outcome.facts.durationMs ?? -1, waveform: outcome.waveform ?? [] };
}

const reasonOf = (outcome: MediaImportOutcome): string => (outcome.ok ? "accepted" : outcome.reason);

/** What ffmpeg's own dump says of the stored file. */
async function dumpOf(path: string): Promise<string> {
  return probeDump({ path, demuxer: "mov", whitelist: "aac", signal: signal() });
}

describe("the formats the importer takes", () => {
  const FORMATS: MusicFixtureName[] = ["mp3", "m4a", "aac", "wav", "flac", "alac", "ogg", "opus", "isomMp4"];

  test.each(FORMATS)("%s becomes AAC-LC, 48 kHz, stereo, one stream, in an m4a", async (name) => {
    const stored = await accepted(await runFixture(name));
    expect(judgeStoredDump(await dumpOf(stored.path))).toMatchObject({ ok: true });
    // The brand says it is an M4A, so the boundary's own sniff reads the stored file as music.
    expect(Buffer.from(stored.bytes.subarray(4, 12)).toString("latin1")).toBe("ftypM4A ");
  });

  test.each(FORMATS)("%s keeps its length, as decoded, and gives one waveform value per 50 ms", async (name) => {
    const stored = await accepted(await runFixture(name));
    expect(Math.abs(stored.durationMs - musicFixtures[name].durationMs)).toBeLessThanOrEqual(80);
    expect(Math.abs(stored.waveform.length - Math.ceil(stored.durationMs / 50))).toBeLessThanOrEqual(1);
    expect(stored.waveform.every((value) => Number.isInteger(value) && value >= 0 && value <= 1000)).toBe(true);
    expect(Math.max(...stored.waveform)).toBeGreaterThan(50);
  });

  test("the facts it gives are a track's: a length and nothing of a picture", async () => {
    const { outcome } = await runFixture("mp3");
    if (!outcome.ok) throw new Error("refused");
    expect(outcome.facts).toMatchObject({ width: null, height: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null });
  });

  test("a mono source becomes stereo", async () => {
    expect(musicFixtures.wav.channels).toBe(1);
    expect(judgeStoredDump(await dumpOf((await accepted(await runFixture("wav"))).path))).toMatchObject({ ok: true });
  });

  test("a 5.1 source becomes stereo", async () => {
    expect(musicFixtures.surround.channels).toBe(6);
    const stored = await accepted(await runFixture("surround"));
    expect(judgeStoredDump(await dumpOf(stored.path))).toMatchObject({ ok: true });
  });

  test("a 24-bit WAV is taken", async () => {
    await accepted(await runFixture("wav24"));
  });

  test("a 44.1 kHz source becomes 48 kHz", async () => {
    expect(musicFixtures.mp3.sampleRate).toBe(44100);
    const dump = await dumpOf((await accepted(await runFixture("mp3"))).path);
    expect(dump).toContain("48000 Hz, stereo");
  });

  test("a 22.05 kHz and an 8 kHz source become 48 kHz too", async () => {
    for (const name of ["alac", "wav"] as const) expect(await dumpOf((await accepted(await runFixture(name))).path)).toContain("48000 Hz, stereo");
  });

  test("stores no more than the stored-file cap and at the bit rate it was asked for", async () => {
    const stored = await accepted(await runFixture("mp3"));
    // 256 kbit/s is 32 KB a second at most, and ten minutes of it is far under the 100 MB the library takes: a stored track is never larger than its source's cap.
    expect(stored.bytes.length).toBeLessThan(120 * 1024);
  });
});

describe("tags and pictures", () => {
  const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");
  const utf16 = (value: string): string => Buffer.from(value, "utf16le").toString("latin1");

  test.each(["taggedMp3", "taggedM4a"] as const)("%s: the title and the artist are not in the stored file, in UTF-8 or UTF-16", async (name) => {
    const stored = await accepted(await runFixture(name));
    const bytes = text(stored.bytes);
    for (const value of Object.values(FIXTURE_TAGS)) {
      expect(bytes).not.toContain(value);
      expect(bytes).not.toContain(utf16(value));
    }
  });

  test.each(["taggedMp3", "taggedM4a"] as const)("%s: the cover art is neither mapped nor decoded: the stored file holds one audio stream and no picture", async (name) => {
    const stored = await accepted(await runFixture(name));
    const dump = await dumpOf(stored.path);
    expect(judgeStoredDump(dump)).toMatchObject({ ok: true });
    expect(dump).not.toContain("Video:");
    expect(dump).not.toContain("attached pic");
  });

  test("the stored file carries no encoder string and no source handler name", async () => {
    const bytes = text((await accepted(await runFixture("taggedMp3"))).bytes);
    expect(bytes).not.toContain("Lavf");
    expect(bytes).not.toContain("Lavc");
    expect(bytes).not.toContain("lame");
  });
});

describe("what it turns away", () => {
  test("an M4A that holds a real video stream is not music: format", async () => {
    expect(reasonOf((await runFixture("m4aWithVideo")).outcome)).toBe("format");
  });

  test("a WAV in a codec the importer does not take is a codec", async () => {
    expect(reasonOf((await runFixture("adpcmWav")).outcome)).toBe("codec");
  });

  test("a container that is not audio at all (a picture) is a format, and no ffmpeg is started", async () => {
    const recorded = recordingSpawner();
    expect(reasonOf((await run(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), "jpeg", { spawner: recorded.spawner })).outcome)).toBe("format");
    expect(recorded.argvs).toHaveLength(0);
  });

  test.each<[string, MediaFormat, number[]]>([
    ["an Ogg head with nothing behind it", "ogg", [0x4f, 0x67, 0x67, 0x53]],
    ["a FLAC head with nothing behind it", "flac", [0x66, 0x4c, 0x61, 0x43]],
    ["an ID3 head with nothing behind it", "mp3", [0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]],
    ["a RIFF head with nothing behind it", "wav", [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]],
    ["an M4A head with nothing behind it", "m4a", [0, 0, 0, 0x14, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20, 0, 0, 0, 0]],
  ])("%s is a format", async (_label, format, head) => {
    const bytes = Uint8Array.from([...head, ...new Array<number>(4096).fill(0)]);
    expect(reasonOf((await run(bytes, format)).outcome)).toBe("format");
  });

  test("a WAV cut in half is the part that is there: ffmpeg states the length of what the file holds", async () => {
    const whole = fixtureBytes("wav");
    const stored = await accepted(await run(whole.subarray(0, Math.floor(whole.length / 2)), "wav"));
    expect(stored.durationMs).toBeGreaterThan(100);
    expect(stored.durationMs).toBeLessThan(musicFixtures.wav.durationMs);
  });

  test("a FLAC cut in half is a format", async () => {
    const whole = fixtureBytes("flac");
    expect(reasonOf((await run(whole.subarray(0, Math.floor(whole.length / 2)), "flac")).outcome)).toBe("format");
  });

  test("an M4A whose index went with the cut is a format", async () => {
    const whole = fixtureBytes("m4a");
    expect(reasonOf((await run(whole.subarray(0, Math.floor(whole.length / 2)), "m4a")).outcome)).toBe("format");
  });

  test("an Ogg cut in half is a format or the part that is there, never a hang or a crash", async () => {
    const whole = fixtureBytes("ogg");
    const { outcome } = await run(whole.subarray(0, Math.floor(whole.length / 2)), "ogg");
    expect(["format", "accepted"]).toContain(reasonOf(outcome));
  });

  test("an mp3 cut in half is the part that is there: its frames are all valid", async () => {
    const whole = fixtureBytes("mp3");
    const stored = await accepted(await run(whole.subarray(0, Math.floor(whole.length / 2)), "mp3"));
    expect(stored.durationMs).toBeGreaterThan(100);
    expect(stored.durationMs).toBeLessThan(musicFixtures.mp3.durationMs);
  });

  test("a FLAC under the name of an mp3: the demuxer is the container's, so it is a format", async () => {
    expect(reasonOf((await run(fixtureBytes("flac"), "mp3")).outcome)).toBe("format");
  });

  test("an mp3 under the name of a FLAC and of a WAV is a format", async () => {
    expect(reasonOf((await run(fixtureBytes("mp3"), "flac")).outcome)).toBe("format");
    expect(reasonOf((await run(fixtureBytes("mp3"), "wav")).outcome)).toBe("format");
  });

  test("a staged copy that is no longer the bytes the staging hashed is failed, and no ffmpeg is started", async () => {
    const recorded = recordingSpawner();
    const bytes = fixtureBytes("mp3");
    const hand = await handoff(tmp(), bytes, { format: "mp3", kind: "audio", sha256: "0".repeat(64) });
    expect(reasonOf(await importerWith({ spawner: recorded.spawner })(hand.request))).toBe("failed");
    expect(recorded.argvs).toHaveLength(0);
  });

  test("a staged copy of the wrong size is failed", async () => {
    const hand = await handoff(tmp(), fixtureBytes("mp3"), { format: "mp3", kind: "audio" });
    const lying = { ...hand.request, staged: { ...hand.request.staged, bytes: hand.request.staged.bytes + 1 } };
    expect(reasonOf(await importerWith()(lying))).toBe("failed");
  });

  test("a staged copy over the audio cap is too-large, whatever the boundary let through", async () => {
    const hand = await handoff(tmp(), fixtureBytes("mp3"), { format: "mp3", kind: "audio" });
    const huge = { ...hand.request, staged: { ...hand.request.staged, bytes: 100 * 1024 * 1024 + 1 } };
    expect(reasonOf(await importerWith()(huge))).toBe("too-large");
  });
});

describe("the length is judged from the decoded output, against the limit", () => {
  // A limit of 8 s stands in for the 10 minutes, so the boundary is tested in the blocking run; the heavy tests below play the real one. Both are a
  // whole number of AAC frames (8 s is 375 frames of 1024 samples at 48 kHz, 10 minutes is 28125): the stored file is a whole number of frames long,
  // so a track "of exactly the limit" is exactly that many frames, and one more frame is the shortest excess there is.
  const LIMIT = 8_000;
  const RATE = 8000;
  const limited = (): MusicImporterDeps => ({ maxDurationMs: LIMIT });

  test("the limit is ten minutes", () => {
    expect(MAX_TRACK_MS).toBe(600_000);
  });

  test("a track of exactly the limit is accepted", async () => {
    const stored = await accepted(await run(wavOf((LIMIT / 1000) * RATE, RATE), "wav", limited()));
    expect(stored.durationMs).toBeLessThanOrEqual(LIMIT);
    expect(stored.durationMs).toBeGreaterThan(LIMIT - 30);
  });

  test("a track one AAC frame over the limit is too-long", async () => {
    const samples = (LIMIT / 1000) * RATE + oneAacFrame(RATE);
    expect(reasonOf((await run(wavOf(samples, RATE), "wav", limited())).outcome)).toBe("too-long");
  });

  test("a track one AAC frame under the limit is accepted", async () => {
    const samples = (LIMIT / 1000) * RATE - oneAacFrame(RATE);
    const stored = await accepted(await run(wavOf(samples, RATE), "wav", limited()));
    expect(stored.durationMs).toBeLessThan(LIMIT);
  });

  test("a track far over the limit is too-long, and the decode was cut: ffmpeg is told to stop at the limit plus a margin", async () => {
    const recorded = recordingSpawner();
    const { outcome } = await run(wavOf(30 * RATE, RATE), "wav", { ...limited(), spawner: recorded.spawner });
    expect(reasonOf(outcome)).toBe("too-long");
    const encode = recorded.argvs.find((argv) => argv.includes("-c:a") && argv.includes("aac")) ?? [];
    expect(encode[encode.indexOf("-t") + 1]).toBe("10");
  });

  test("the work file of a track far over the limit holds the cut, not the 30 seconds", async () => {
    const { outcome, hand } = await run(wavOf(30 * RATE, RATE), "wav", limited());
    expect(reasonOf(outcome)).toBe("too-long");
    const [work] = hand.works;
    expect(work).toBeDefined();
    // 10 s at 256 kbit/s is at most 320 KB; 30 s of it would be 960 KB.
    expect((await stat(work?.path ?? "")).size).toBeLessThan(400 * 1024);
  });

  test("a header that claims a short length does not turn a long file into unbounded decode work: it is cut at the limit and refused as too-long", async () => {
    const long = await flacOfSeconds(tmp(), 30);
    const forged = flacClaiming(long, 2_400);
    const { outcome, hand } = await run(forged, "flac", limited());
    expect(reasonOf(outcome)).toBe("too-long");
    expect((await stat(hand.works[0]?.path ?? "")).size).toBeLessThan(400 * 1024);
  });

  test("a header that claims more than the file holds is a damaged file: format, for a container whose header is exact", async () => {
    const real = await flacOfSeconds(tmp(), 1);
    const forged = flacClaiming(real, 8000 * 1.9);
    expect(reasonOf((await run(forged, "flac", limited())).outcome)).toBe("format");
  });

  test("a file that decodes to nothing is a format, not a track of zero length", async () => {
    expect(reasonOf((await run(wavOf(0, RATE), "wav")).outcome)).toBe("format");
  });

  heavyTest("exactly 10:00: a ten minute track is accepted", async () => {
    const stored = await accepted(await run(wavOf(600 * RATE, RATE), "wav"));
    expect(stored.durationMs).toBeLessThanOrEqual(MAX_TRACK_MS);
    expect(stored.durationMs).toBeGreaterThan(MAX_TRACK_MS - 30);
  }, 240_000);

  heavyTest("10:00 and one frame: a track one frame over ten minutes is too-long", async () => {
    expect(reasonOf((await run(wavOf(600 * RATE + oneAacFrame(RATE), RATE), "wav")).outcome)).toBe("too-long");
  }, 240_000);
});

describe("ffmpeg is pinned to what was judged", () => {
  test("the probe and the decode force the demuxer, the decoder and the one audio stream; no picture, subtitle or data stream is mapped; the tags are dropped", async () => {
    const recorded = recordingSpawner();
    await accepted(await runFixture("taggedMp3", { spawner: recorded.spawner }));
    const probe = recorded.argvs[0] ?? [];
    expect(probe).toEqual(expect.arrayContaining(["-protocol_whitelist", "file", "-f", "mp3", "-nostdin"]));
    expect(probe[probe.indexOf("-codec_whitelist") + 1]?.split(",")).not.toContain("mjpeg");
    const decode = recorded.argvs.find((argv) => argv.includes("aac") && argv.includes("-map")) ?? [];
    const pair = (flag: string, value: string): void => expect(decode.slice(decode.indexOf(flag), decode.indexOf(flag) + 2)).toEqual([flag, value]);
    pair("-protocol_whitelist", "file");
    pair("-f", "mp3");
    pair("-codec_whitelist", "mp3float");
    pair("-map", "0:a:0");
    pair("-map_metadata", "-1");
    pair("-map_metadata:s:a:0", "-1");
    pair("-map_chapters", "-1");
    pair("-ar", "48000");
    pair("-ac", "2");
    pair("-b:a", "256k");
    pair("-profile:a", "aac_low");
    pair("-max_alloc", "67108864");
    expect(decode).toEqual(expect.arrayContaining(["-vn", "-sn", "-dn", "-nostdin"]));
    // `-c:a` appears twice: the pinned decoder before the input, the AAC encoder after it.
    const inputAt = decode.indexOf("-i");
    expect(decode.slice(0, inputAt)).toEqual(expect.arrayContaining(["-c:a", "mp3float"]));
    expect(decode.slice(inputAt)).toEqual(expect.arrayContaining(["-c:a", "aac"]));
  });

  test.each<[MusicFixtureName, string, string]>([
    ["m4a", "mov", "aac"],
    ["alac", "mov", "alac"],
    ["aac", "aac", "aac"],
    ["flac", "flac", "flac"],
    ["ogg", "ogg", "vorbis"],
    ["opus", "ogg", "opus"],
    ["wav", "wav", "pcm_s16le"],
  ])("%s is decoded by the %s demuxer with the %s decoder, from the sniffed container and the probe's codec", async (name, demuxer, decoder) => {
    const recorded = recordingSpawner();
    await accepted(await runFixture(name, { spawner: recorded.spawner }));
    const decode = recorded.argvs.find((argv) => argv.includes("-map")) ?? [];
    const before = decode.slice(0, decode.indexOf("-i"));
    expect(before.slice(before.indexOf("-f"), before.indexOf("-f") + 2)).toEqual(["-f", demuxer]);
    expect(before.slice(before.indexOf("-codec_whitelist"), before.indexOf("-codec_whitelist") + 2)).toEqual(["-codec_whitelist", decoder]);
    expect(before.slice(before.indexOf("-c:a"), before.indexOf("-c:a") + 2)).toEqual(["-c:a", decoder]);
  });

  test("a probe that names another codec than the file's cannot make ffmpeg decode it with that one: the pinned decoder fails and nothing is stored", async () => {
    const real = recordingSpawner();
    let calls = 0;
    const spawner: FfmpegSpawner = (command, args, options) => {
      // The probe is made to lie: it says the mp3's stream is FLAC. Every later call is the real ffmpeg.
      if (calls++ === 0) return printingChild(1, "  Duration: 00:00:00.60, bitrate: 1 kb/s\n  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16\n");
      return real.spawner(command, args, options);
    };
    const { outcome } = await run(fixtureBytes("mp3"), "mp3", { spawner });
    // The lie is not even on the mp3 row: nothing is decoded with another codec.
    expect(reasonOf(outcome)).toBe("codec");
    expect(real.argvs).toHaveLength(0);
  });

  test("a probe that lies within the container's row (aac, in a file that is an mov holding ALAC) fails the pinned decode, and nothing is stored", async () => {
    const real = recordingSpawner();
    let calls = 0;
    const spawner: FfmpegSpawner = (command, args, options) => {
      if (calls++ === 0) return printingChild(1, "  Duration: 00:00:00.40, bitrate: 1 kb/s\n  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 22050 Hz, stereo, fltp\n");
      return real.spawner(command, args, options);
    };
    const { outcome } = await run(fixtureBytes("alac"), "m4a", { spawner });
    expect(outcome.ok).toBe(false);
    expect(reasonOf(outcome)).not.toBe("accepted");
  });

  test("the importer's output is judged again by ffmpeg: a stored file that is not AAC-LC 48 kHz stereo is refused", async () => {
    const real = recordingSpawner();
    let calls = 0;
    const spawner: FfmpegSpawner = (command, args, options) => {
      calls++;
      // The third call is the check of the output: it is made to report 44.1 kHz.
      if (calls === 3) return printingChild(1, "  Duration: 00:00:00.60, bitrate: 1 kb/s\n  Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp\n");
      return real.spawner(command, args, options);
    };
    expect(reasonOf((await run(fixtureBytes("mp3"), "mp3", { spawner })).outcome)).toBe("failed");
  });
});

describe("a cancel and the clock", () => {
  test("a cancel during the encode kills ffmpeg, answers cancelled, and nothing is written after it", async () => {
    const recorded = recordingSpawner();
    // 150 s of audio: the encode takes seconds, so the cancel lands inside it.
    const hand = await handoff(tmp(), wavOf(150 * 8000), { format: "wav", kind: "audio" });
    const running = importerWith({ spawner: recorded.spawner })(hand.request);
    // The probe is the first child; the encode is the second.
    while (recorded.argvs.length < 2) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    for (const pid of recorded.pids) expect(isAlive(pid)).toBe(false);
    // The probe ended by itself; the encode did not: it was KILLED, not waited for (a run that was left to finish would have an exit code of 0).
    expect(recorded.exits[0]?.signal).toBeNull();
    expect(recorded.exits[1]?.signal).toBe("SIGKILL");
    const listing = async (): Promise<string> => {
      const names = (await readdir(tmp())).sort();
      return (await Promise.all(names.map(async (name) => `${name}:${(await stat(join(tmp(), name))).size}`))).join(",");
    };
    const after = await listing();
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(await listing()).toBe(after);
  });

  test("a cancel during the probe kills it and answers cancelled", async () => {
    const { child, killed } = hangingChild();
    let started: () => void = () => undefined;
    const spawned = new Promise<void>((resolve) => (started = resolve));
    const spawner: FfmpegSpawner = () => {
      started();
      return child;
    };
    const hand = await handoff(tmp(), fixtureBytes("mp3"), { format: "mp3", kind: "audio" });
    const running = importerWith({ spawner })(hand.request);
    await spawned;
    hand.controller.abort();
    expect(await running).toEqual({ ok: false, reason: "cancelled" });
    expect(killed()).toEqual(["SIGKILL"]);
  });

  test("a cancel before anything starts spawns nothing", async () => {
    const recorded = recordingSpawner();
    const hand = await handoff(tmp(), fixtureBytes("mp3"), { format: "mp3", kind: "audio" });
    hand.controller.abort();
    expect(await importerWith({ spawner: recorded.spawner })(hand.request)).toEqual({ ok: false, reason: "cancelled" });
    expect(recorded.argvs).toHaveLength(0);
  });

  test("a probe that never answers is killed at its limit and the track is failed", async () => {
    const { child, killed } = hangingChild();
    const { outcome } = await run(fixtureBytes("mp3"), "mp3", { spawner: () => child, probeTimeoutMs: 25 });
    expect(reasonOf(outcome)).toBe("failed");
    expect(killed()).toEqual(["SIGKILL"]);
  });

  test("an encode that never ends is killed at its limit and the track is failed", async () => {
    const real = recordingSpawner();
    const hung = hangingChild();
    let calls = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (calls++ === 1 ? hung.child : real.spawner(command, args, options));
    const { outcome } = await run(fixtureBytes("mp3"), "mp3", { spawner, encodeTimeoutMs: 25 });
    expect(reasonOf(outcome)).toBe("failed");
    expect(hung.killed()).toEqual(["SIGKILL"]);
  });

  test("the time an encode is given grows with the length the header states, and is never under the floor", async () => {
    const { encodeTimeoutFor } = await import("./musicImporter");
    expect(encodeTimeoutFor(null)).toBeGreaterThanOrEqual(30_000);
    expect(encodeTimeoutFor(1_000)).toBeGreaterThanOrEqual(30_000);
    expect(encodeTimeoutFor(600_000)).toBeGreaterThan(encodeTimeoutFor(60_000));
    // A header that states a huge length does not buy unbounded time: the ceiling is a few minutes.
    expect(encodeTimeoutFor(10 * 3600_000)).toBeLessThanOrEqual(10 * 60_000);
  });

  test("an ffmpeg that fails says nothing of what it printed: the reason only", async () => {
    const real = recordingSpawner();
    let calls = 0;
    const spawner: FfmpegSpawner = (command, args, options) => (calls++ === 1 ? printingChild(1, "Error opening /Users/secret/music/private.mp3: Invalid data found") : real.spawner(command, args, options));
    const { outcome } = await run(fixtureBytes("mp3"), "mp3", { spawner });
    expect(outcome).toEqual({ ok: false, reason: "format" });
    expect(JSON.stringify(outcome)).not.toContain("secret");
  });
});
