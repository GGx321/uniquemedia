import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FfmpegChild, FfmpegSpawner } from "../../node/runFfmpeg";
import { configureFfmpegEnv } from "../../node/ffmpegEnv";
import { decodeAudio, DecodeError, inspectStreams, PEAK_STEP_MS, streamTypesOf } from "./decodeCheck";
import { box, concat, fullBox, u32 } from "./testing/m4aBuilder";
import { musicTracks } from "./fixtures";
import { probeMp4Audio } from "./mp4aProbe";
import { spawnSync } from "node:child_process";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Invariant 31, acceptance, second gate: the file is decoded by ffmpeg under a time bound and an output bound, from a
// file on disk (never the network), with the mov demuxer forced and only the file protocol allowed, and what came out
// must be about as long as the list claimed. The same decode yields the waveform `music.peaks` serves.

/** The stream inspection of a file that is not there: one audio stream, for the tests that script ffmpeg's decode. */
const oneAudio = async (): Promise<readonly string[]> => ["Audio"];

let dir = "";
afterEach(async () => {
  configureFfmpegEnv(undefined);
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  dir = "";
});

async function tempFile(bytes: Uint8Array, name = "track.m4a"): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "studio-decode-"));
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

async function failureOf(run: Promise<unknown>): Promise<DecodeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof DecodeError) return error;
    throw error;
  }
  throw new Error("expected the decode to fail");
}

const signal = () => new AbortController().signal;

describe("a real HE-AAC excerpt", () => {
  test.each(Object.entries(musicTracks))("%s decodes to its own length, with a waveform of one value per 50 ms", async (_name, fixture) => {
    const path = await tempFile(new Uint8Array(await readFile(fixture.file)));
    const result = await decodeAudio({ path, expectedMs: fixture.durationMs, signal: signal() });
    expect(Math.abs(result.decodedMs - fixture.durationMs)).toBeLessThanOrEqual(100);
    expect(PEAK_STEP_MS).toBe(50);
    expect(Math.abs(result.peaks.length - Math.ceil(result.decodedMs / PEAK_STEP_MS))).toBeLessThanOrEqual(1);
    expect(result.peaks.every((peak) => Number.isInteger(peak) && peak >= 0 && peak <= 1000)).toBe(true);
  });

  test("the hot track's waveform peaks above the quiet one's: the envelope follows the audio", async () => {
    const [hot, quiet] = await Promise.all(
      [musicTracks.hot, musicTracks.quiet].map(async (fixture) => {
        const path = await tempFile(new Uint8Array(await readFile(fixture.file)), `${fixture.trackId}.m4a`);
        return (await decodeAudio({ path, expectedMs: fixture.durationMs, signal: signal() })).peaks;
      }),
    );
    expect(Math.max(...(hot ?? []))).toBeGreaterThan(Math.max(...(quiet ?? [])));
  });
});

describe("audio that is not what the list claimed", () => {
  test("a track claimed to be a minute long that is eight seconds", async () => {
    const path = await tempFile(new Uint8Array(await readFile(musicTracks.hot.file)));
    const error = await failureOf(decodeAudio({ path, expectedMs: 60_000, signal: signal() }));
    expect(error.kind).toBe("duration-mismatch");
  });

  test("a track claimed to be two seconds that is eight", async () => {
    const path = await tempFile(new Uint8Array(await readFile(musicTracks.hot.file)));
    expect((await failureOf(decodeAudio({ path, expectedMs: 2_000, signal: signal() }))).kind).toBe("duration-mismatch");
  });

  test("a length within the tolerance passes: a claim of 5% off", async () => {
    const path = await tempFile(new Uint8Array(await readFile(musicTracks.hot.file)));
    const result = await decodeAudio({ path, expectedMs: Math.round(musicTracks.hot.durationMs * 1.04), signal: signal() });
    expect(result.decodedMs).toBeGreaterThan(7000);
  });

  test("bytes that are not media at all are refused as no audio stream, not by hanging", async () => {
    const path = await tempFile(Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff));
    expect((await failureOf(decodeAudio({ path, expectedMs: 8_000, signal: signal() }))).kind).toBe("extra-stream");
  });

  test("an MP3 renamed .m4a is not decoded: the mov demuxer is forced, so the extension and the content cannot pick another one", async () => {
    const path = await tempFile(new TextEncoder().encode("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000".padEnd(2048, "ÿ")));
    expect((await failureOf(decodeAudio({ path, expectedMs: 8_000, signal: signal() }))).kind).toBe("extra-stream");
  });

  // Re-review 6: not only the arguments. A real MP3 muxed into an mp4 (the mov muxer stores it under an `mp4a` entry with
  // objectTypeIndication 0x6b) is what `-c:a aac` refuses: ffmpeg exits with no samples instead of decoding it.
  test("a real MP3 inside an mp4a entry is not decoded: the walker refuses it, and the AAC-only decoder exits with no output on its own", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-decode-"));
    const path = join(dir, "mp3.m4a");
    const made = spawnSync(ffmpegPath(), ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:a", "libmp3lame", "-f", "mp4", path]);
    expect(made.status).toBe(0);
    const probe = probeMp4Audio(new Uint8Array(await readFile(path)));
    expect(probe.ok).toBe(false);
    expect((await failureOf(decodeAudio({ path, expectedMs: 2_000, signal: signal() }))).kind).toBe("exit");
  });

  test("a truncated file does not pass for the whole track", async () => {
    const whole = new Uint8Array(await readFile(musicTracks.hot.file));
    const path = await tempFile(whole.subarray(0, Math.floor(whole.byteLength / 3)));
    const kind = (await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }))).kind;
    expect(["exit", "duration-mismatch", "no-audio"]).toContain(kind);
  });

  test("a failure names the kind and never the path", async () => {
    const path = await tempFile(Uint8Array.from({ length: 512 }, () => 1), "secret-name.m4a");
    const error = await failureOf(decodeAudio({ path, expectedMs: 8_000, signal: signal() }));
    expect(error.message).not.toContain("secret-name");
    expect(error.message).not.toContain(dir);
  });
});

/** A scripted ffmpeg: what it prints, and whether it ever exits. */
function fakeSpawner(script: { stdout?: Uint8Array[]; exit?: number | "never"; onSpawn?: (args: readonly string[], env: Record<string, string> | undefined) => void }): { spawner: FfmpegSpawner; killed: () => boolean } {
  let killed = false;
  const spawner: FfmpegSpawner = (_command, args, options) => {
    script.onSpawn?.(args, options.env);
    const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.kill = () => {
      killed = true;
      queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return true;
    };
    queueMicrotask(() => {
      for (const part of script.stdout ?? []) child.stdout.write(part);
      if (script.exit === "never") return;
      child.stdout.end();
      child.exitCode = script.exit ?? 0;
      child.emit("close", script.exit ?? 0, null);
    });
    return child;
  };
  return { spawner, killed: () => killed };
}

const pcm = (seconds: number): Uint8Array => new Uint8Array(Math.round(seconds * 4000 * 2));

describe("the run is bounded", () => {
  test("a run that never ends is killed at the time bound", async () => {
    const { spawner, killed } = fakeSpawner({ exit: "never" });
    const started = Date.now();
    const error = await failureOf(decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), timeoutMs: 60, spawner }));
    expect(error.kind).toBe("timeout");
    expect(killed()).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a caller's abort kills it", async () => {
    const controller = new AbortController();
    const { spawner, killed } = fakeSpawner({ exit: "never" });
    const run = decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: controller.signal, timeoutMs: 5000, spawner });
    setTimeout(() => controller.abort(), 20);
    expect((await failureOf(run)).kind).toBe("aborted");
    expect(killed()).toBe(true);
  });

  test("an already aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const { spawner } = fakeSpawner({ onSpawn: () => void (spawned = true) });
    expect((await failureOf(decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: controller.signal, spawner }))).kind).toBe("aborted");
    expect(spawned).toBe(false);
  });

  test("output beyond the bound for the claimed length kills ffmpeg: a file cannot make it write without limit", async () => {
    const { spawner, killed } = fakeSpawner({ stdout: [pcm(60), pcm(60), pcm(60)], exit: "never" });
    const error = await failureOf(decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), timeoutMs: 5000, spawner }));
    expect(error.kind).toBe("too-long");
    expect(killed()).toBe(true);
  });

  test("a non-zero exit is `exit` even when it printed audio first", async () => {
    const { spawner } = fakeSpawner({ stdout: [pcm(8)], exit: 1 });
    expect((await failureOf(decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("exit");
  });

  test("a clean exit with no audio is `no-audio`", async () => {
    const { spawner } = fakeSpawner({ stdout: [], exit: 0 });
    expect((await failureOf(decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("no-audio");
  });

  test("a spawn that fails is `spawn`", async () => {
    const spawner: FfmpegSpawner = () => {
      throw new Error("ENOENT");
    };
    expect((await failureOf(decodeAudio({ streams: oneAudio, path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("spawn");
  });
});

describe("how ffmpeg is started", () => {
  const seen = async (path = "/tmp/track.m4a"): Promise<{ args: readonly string[]; env: Record<string, string> | undefined }> => {
    let got: { args: readonly string[]; env: Record<string, string> | undefined } | null = null;
    const { spawner } = fakeSpawner({ stdout: [pcm(8)], onSpawn: (args, env) => void (got = { args, env }) });
    await decodeAudio({ streams: oneAudio, path, expectedMs: 8_000, signal: signal(), spawner });
    if (got === null) throw new Error("nothing was spawned");
    return got;
  };

  test("forces the mov demuxer and allows only the file protocol, so a data reference cannot open a URL or another file", async () => {
    const { args } = await seen();
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args[args.indexOf("-f") + 1]).toBe("mov");
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-f")).toBeLessThan(args.indexOf("-i"));
  });

  // Review 3c.4 F1/F2. `-c:a aac` (before -i) makes the decoder for the stream AAC and nothing else: a stream that is not
  // AAC (an MP3 the walker never looked at) exits with no output instead of being decoded. `-max_alloc` caps what one
  // allocation may take, so a container that claims a gigabyte fails at 64 MiB instead of costing the machine.
  test("forces the AAC decoder and caps allocations, both before the input", async () => {
    const { args } = await seen();
    expect(args.slice(args.indexOf("-c:a"), args.indexOf("-c:a") + 2)).toEqual(["-c:a", "aac"]);
    expect(args[args.indexOf("-max_alloc") + 1]).toBe("67108864");
    expect(args.indexOf("-c:a")).toBeLessThan(args.indexOf("-i"));
    expect(args.indexOf("-max_alloc")).toBeLessThan(args.indexOf("-i"));
  });

  test("reads no stdin, only the first audio stream, no video, no subtitles, no data", async () => {
    const { args } = await seen();
    expect(args).toContain("-nostdin");
    expect(args.slice(args.indexOf("-map"), args.indexOf("-map") + 2)).toEqual(["-map", "0:a:0"]);
    for (const flag of ["-vn", "-sn", "-dn"]) expect(args).toContain(flag);
  });

  test("bounds the decode by a length taken from the claim, not from the file", async () => {
    const { args } = await seen();
    const seconds = Number(args[args.indexOf("-t") + 1]);
    expect(seconds).toBeGreaterThan(8);
    expect(seconds).toBeLessThan(20);
  });

  test("writes raw mono samples to the pipe and nothing to disk", async () => {
    const { args } = await seen();
    expect(args.slice(-7)).toEqual(["-ac", "1", "-ar", "4000", "-f", "s16le", "pipe:1"]);
    expect(args).not.toContain("-y");
  });

  test("the path is the last input and cannot pass for an option", async () => {
    const { args } = await seen("/tmp/track.m4a");
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/track.m4a");
  });

  test("refuses a relative path, which could begin with a dash or resolve against another folder", async () => {
    const { spawner } = fakeSpawner({ stdout: [pcm(8)] });
    await expect(decodeAudio({ path: "-i", expectedMs: 8_000, signal: signal(), spawner })).rejects.toBeInstanceOf(TypeError);
    await expect(decodeAudio({ path: "track.m4a", expectedMs: 8_000, signal: signal(), spawner })).rejects.toBeInstanceOf(TypeError);
  });

  test("the child gets the engine's allowlisted environment, and never a secret", async () => {
    configureFfmpegEnv({ PATH: "/usr/bin", HOME: "/home/x", OPENROUTER_API_KEY: "sk-or-v1-secret", RAPIDAPI_KEY: "Zq7-vKt9" });
    const { env } = await seen();
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/x" });
  });
});

// Round 5: the guarantee that a file is ONE audio stream lives here, in the authoritative layer: the very ffmpeg the app
// renders with is asked what streams it sees. A byte rule in the walker can only ever name the layouts someone thought of;
// ffmpeg's own reading of the file cannot be walked around, whatever box or key spelling carries the picture.
function appendIntoMoov(bytes: Uint8Array, extra: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 0; at + 8 <= bytes.byteLength; ) {
    const size = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === "moov") {
      const out = concat(bytes.subarray(0, at + size), extra, bytes.subarray(at + size));
      new DataView(out.buffer).setUint32(at, size + extra.byteLength);
      return out;
    }
    if (size < 8) break;
    at += size;
  }
  throw new Error("no moov");
}

const JPEG = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9);

/** The reviewer's k0: artwork under `keys` and `mdta`, with no `covr` anywhere in the file. */
function mdtaArtwork(): Uint8Array {
  const key = new TextEncoder().encode("com.apple.quicktime.artwork");
  const keys = fullBox("keys", 0, concat(u32(1), u32(8 + key.length), new TextEncoder().encode("mdta"), key));
  const hdlr = fullBox("hdlr", 0, concat(u32(0), new TextEncoder().encode("mdta"), u32(0), u32(0), u32(0), Uint8Array.of(0)));
  const item = concat(u32(8 + 16 + JPEG.length), u32(1), box("data", concat(u32(13), u32(0), JPEG)));
  return box("udta", fullBox("meta", 0, concat(hdlr, keys, box("ilst", item))));
}

/** The classic cover: `udta/meta/ilst/covr`. */
function covrArtwork(): Uint8Array {
  const hdlr = fullBox("hdlr", 0, concat(u32(0), new TextEncoder().encode("mdir"), new TextEncoder().encode("appl"), u32(0), u32(0), Uint8Array.of(0)));
  return box("udta", fullBox("meta", 0, concat(hdlr, box("ilst", box("covr", box("data", concat(u32(13), u32(0), JPEG)))))));
}

describe("ffmpeg says the file is exactly one audio stream", () => {
  const hot = async (): Promise<Uint8Array> => new Uint8Array(await readFile(musicTracks.hot.file));

  test("the real HE-AAC files are one audio stream each, so the check passes what it must", async () => {
    for (const fixture of Object.values(musicTracks)) {
      const path = await tempFile(new Uint8Array(await readFile(fixture.file)));
      expect(await inspectStreams({ path, signal: signal() })).toEqual(["Audio"]);
    }
  });

  test("artwork under keys and mdta, with no covr bytes at all, is a second stream: the decode refuses it by itself", async () => {
    const bytes = appendIntoMoov(await hot(), mdtaArtwork());
    expect(Buffer.from(bytes).includes("covr")).toBe(false);
    const path = await tempFile(bytes);
    expect(await inspectStreams({ path, signal: signal() })).toEqual(["Audio", "Video"]);
    // decodeAudio is called directly: the walker is not in this path, so this layer is proven alone.
    expect((await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }))).kind).toBe("extra-stream");
  });

  test("classic covr artwork is refused by the decode on its own too, with the walker out of the way", async () => {
    const path = await tempFile(appendIntoMoov(await hot(), covrArtwork()));
    expect(await inspectStreams({ path, signal: signal() })).toContain("Video");
    expect((await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }))).kind).toBe("extra-stream");
  });

  test("the refusal says which kinds of stream it saw, in fixed words, and never a path or the file's own text", async () => {
    const path = await tempFile(appendIntoMoov(await hot(), mdtaArtwork()), "secret-name.m4a");
    const error = await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }));
    expect(error.message).toContain("Video");
    expect(error.message).not.toContain("secret-name");
    expect(error.message).not.toContain("artwork");
  });

  test("a file that is not a movie at all is not an audio stream either: nothing is parsed, so nothing passes", async () => {
    const path = await tempFile(Uint8Array.from({ length: 2048 }, (_, i) => (i * 7 + 3) & 0xff));
    expect(await inspectStreams({ path, signal: signal() })).toEqual([]);
    expect((await failureOf(decodeAudio({ path, expectedMs: 8_000, signal: signal() }))).kind).toBe("extra-stream");
  });
});

describe("reading the streams out of ffmpeg's own dump", () => {
  const dump = (...lines: string[]): string => `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'x.m4a':\n  Metadata:\n    title           : Stream #0:5: Video: not a stream line\n  Duration: 00:00:08.03, start: 0.000000, bitrate: 90 kb/s\n${lines.join("\n")}\nAt least one output file must be specified\n`;

  test("takes the kind of each `Stream #0:N` line: Audio, Video, Subtitle, Data, Attachment", () => {
    expect(
      streamTypesOf(
        dump(
          "  Stream #0:0[0x1](und): Audio: aac (HE-AAC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 64 kb/s (default)",
          "  Stream #0:1[0x2]: Video: mjpeg (Baseline), yuvj420p(pc), 1x1 (attached pic)",
          "  Stream #0:2[0x3](eng): Subtitle: mov_text (text / 0x74786574)",
          "  Stream #0:3[0x4](und): Data: none (tmcd / 0x64636D74)",
          "  Stream #0:4: Attachment: none",
        ),
      ),
    ).toEqual(["Audio", "Video", "Subtitle", "Data", "Attachment"]);
  });

  test("reads a line with no id, no language, or a bracketed id after the language", () => {
    expect(streamTypesOf(dump("  Stream #0:0: Audio: aac", "  Stream #0:1(und)[0x3]: Audio: aac"))).toEqual(["Audio", "Audio"]);
  });

  test("ignores text that merely looks like a stream line inside the metadata", () => {
    expect(streamTypesOf(dump("  Stream #0:0: Audio: aac"))).toEqual(["Audio"]);
  });

  test("a kind it does not know is kept as a word, so it can never pass for Audio", () => {
    expect(streamTypesOf(dump("  Stream #0:0: Weird: x"))).toEqual(["Weird"]);
  });

  // 3f.4 review H1: the track store and the render rely on this reading, and it is safe today only because they force `-f mov` (a three-letter language
  // from `mdhd`). An Ogg's language is the file's own text, printed verbatim: a grammar that accepts any parenthesis lets it forge a stream line.
  test("a language that closes the parenthesis and forges a second description makes the line no stream at all", () => {
    const forged = "  Stream #0:0(x): Video: png (attached pic): Audio: vorbis, 44100 Hz, mono, fltp, 48 kb/s";
    expect(streamTypesOf(dump(forged, "  Stream #0:1: Audio: vorbis, 44100 Hz, mono, fltp, 48 kb/s"))).toEqual(["Audio"]);
    expect(streamTypesOf(dump("  Stream #0:0(x): Audio: aac: Video: png"))).toEqual([]);
  });

  test("a language with a bracket, a colon or a space in it is no language", () => {
    for (const language of ["x): Video: png (attached pic", "a b", "a:b", "x)(y"]) expect(streamTypesOf(dump(`  Stream #0:0(${language}): Audio: aac`))).toEqual([]);
    for (const language of ["und", "eng", "en", "zh-Hans"]) expect(streamTypesOf(dump(`  Stream #0:0(${language}): Audio: aac`))).toEqual(["Audio"]);
  });

  test("a dump that carries a forged stream line cannot pass inspectStreams as one audio stream: the forged line leaves a gap in the numbering", async () => {
    const forged = ["  Stream #0:0(x): Video: png (attached pic): Audio: vorbis, 44100 Hz, mono", "  Stream #0:1: Audio: vorbis, 44100 Hz, mono"];
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write(`${forged.join("\n")}\n`);
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    };
    await expect(inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner })).rejects.toMatchObject({ kind: "bad-dump" });
  });

  test("nothing in the dump is no streams", () => {
    expect(streamTypesOf("")).toEqual([]);
    expect(streamTypesOf("garbage\nStream without the number\n")).toEqual([]);
  });
});

describe("how the streams are asked for", () => {
  const dumpOf = (...lines: string[]): FfmpegSpawner => {
    return () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write(`${lines.join("\n")}\nAt least one output file must be specified\n`);
        child.stdout.end();
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    };
  };

  test("one audio line passes; a second stream of any kind is refused as extra-stream", async () => {
    const audio = "  Stream #0:0[0x1](und): Audio: aac (HE-AAC), 44100 Hz, stereo";
    expect(await inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner: dumpOf(audio) })).toEqual(["Audio"]);
    for (const extra of ["Video: mjpeg (attached pic)", "Subtitle: mov_text", "Data: none", "Attachment: none", "Audio: aac"]) {
      const spawner = dumpOf(audio, `  Stream #0:1: ${extra}`);
      expect((await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("extra-stream");
    }
  });

  test("a lone stream that is not audio is refused too", async () => {
    const spawner = dumpOf("  Stream #0:0: Video: mjpeg (attached pic)");
    expect((await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("extra-stream");
  });

  test("runs the same ffmpeg with the same hardening: the mov demuxer, only the file protocol, a capped allocation, no stdin, no output", async () => {
    let args: readonly string[] = [];
    const spawner: FfmpegSpawner = (command, given, options) => {
      args = given;
      return dumpOf("  Stream #0:0: Audio: aac")(command, given, options);
    };
    await inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner });
    expect(args).toContain("-nostdin");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file");
    expect(args[args.indexOf("-f") + 1]).toBe("mov");
    expect(args[args.indexOf("-max_alloc") + 1]).toBe("67108864");
    expect(args.at(-2)).toBe("-i");
    expect(args.at(-1)).toBe("/tmp/x.m4a");
    expect(args.indexOf("-protocol_whitelist")).toBeLessThan(args.indexOf("-i"));
  });

  test("the child gets the engine's allowlisted environment, never a secret", async () => {
    configureFfmpegEnv({ PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-or-v1-secret" });
    let env: Record<string, string> | undefined;
    const spawner: FfmpegSpawner = (command, given, options) => {
      env = options.env;
      return dumpOf("  Stream #0:0: Audio: aac")(command, given, options);
    };
    await inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner });
    expect(env).toEqual({ PATH: "/usr/bin" });
  });

  test("a run that never ends is killed at the time bound", async () => {
    let killed = false;
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => {
        killed = true;
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      };
      return child;
    };
    await expect(inspectStreams({ path: "/tmp/x.m4a", signal: signal(), timeoutMs: 40, spawner })).rejects.toMatchObject({ kind: "timeout" });
    expect(killed).toBe(true);
  });

  test("an abort kills it", async () => {
    const controller = new AbortController();
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => {
        queueMicrotask(() => child.emit("close", null, "SIGKILL"));
        return true;
      };
      return child;
    };
    const run = inspectStreams({ path: "/tmp/x.m4a", signal: controller.signal, timeoutMs: 5000, spawner });
    setTimeout(() => controller.abort(), 20);
    await expect(run).rejects.toMatchObject({ kind: "aborted" });
  });

  test("a dump larger than the bound is cut, not buffered without limit", async () => {
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write("  Stream #0:0: Audio: aac\n");
        child.stderr.write("x".repeat(4 * 1024 * 1024));
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    };
    // Round 6: a cut dump is NOT a complete one. What lies past the cap is unknown, so the file is refused.
    await expect(inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner })).rejects.toMatchObject({ kind: "dump-too-large" });
  });

  test("a dump of exactly the cap is read whole", async () => {
    const line = "  Stream #0:0: Audio: aac\n";
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write(line);
        child.stderr.write("y".repeat(256 * 1024 - line.length));
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    };
    expect(await inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner })).toEqual(["Audio"]);
  });

  test.each([
    ["a stream numbered 1 with no stream 0", ["  Stream #0:1: Audio: aac"]],
    ["streams numbered 0 and 2", ["  Stream #0:0: Audio: aac", "  Stream #0:2: Video: mjpeg"]],
    ["a stream 0 listed twice", ["  Stream #0:0: Audio: aac", "  Stream #0:0: Audio: aac"]],
    ["indices out of order", ["  Stream #0:1: Audio: aac", "  Stream #0:0: Audio: aac"]],
  ])("a dump whose indices are not exactly 0..n-1 in order is refused as bad-dump: %s", async (_label, lines) => {
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write(`${lines.join("\n")}\n`);
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    };
    await expect(inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner })).rejects.toMatchObject({ kind: "bad-dump" });
  });

  test("consecutive indices from 0 are fine", async () => {
    const spawner: FfmpegSpawner = () => {
      const child = new EventEmitter() as EventEmitter & FfmpegChild & { exitCode: number | null; stdout: PassThrough; stderr: PassThrough };
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.kill = () => true;
      queueMicrotask(() => {
        child.stderr.write("  Stream #0:0: Audio: aac\n  Stream #0:1: Video: mjpeg\n");
        child.exitCode = 1;
        child.emit("close", 1, null);
      });
      return child;
    };
    expect(await inspectStreams({ path: "/tmp/x.m4a", signal: signal(), spawner })).toEqual(["Audio", "Video"]);
  });
});

// Round 6: the stream lines are read from ffmpeg's text, and ffmpeg prints a file's own strings into it. A file that makes the
// dump long hides a second stream past the cap, and a metadata key with a newline in it can print a stream line of its own.
// Both are the file writing the checker's input, so a dump that hit the cap, or whose indices do not add up, is a refusal.
describe("a file that writes ffmpeg's dump", () => {
  function childrenOf(b: Uint8Array, start: number, end: number): { type: string; at: number; end: number }[] {
    const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const out: { type: string; at: number; end: number }[] = [];
    for (let at = start; at + 8 <= end; ) {
      const size = view.getUint32(at);
      if (size < 8) break;
      out.push({ type: String.fromCharCode(...b.subarray(at + 4, at + 8)), at, end: at + size });
      at += size;
    }
    return out;
  }

  /** Replaces the box at `path` (types from the top) with `replacement`, growing every box above it. */
  function replaceIn(b: Uint8Array, path: string[], replacement: Uint8Array): Uint8Array {
    const chain: { type: string; at: number; end: number }[] = [];
    let parent = { at: -8, end: b.byteLength };
    for (const name of path) {
      const found = childrenOf(b, parent.at + 8, parent.end).find((c) => c.type === name);
      if (found === undefined) throw new Error(`no ${name}`);
      chain.push(found);
      parent = found;
    }
    const target = chain.at(-1);
    if (target === undefined) throw new Error("empty path");
    const grow = replacement.byteLength - (target.end - target.at);
    const out = concat(b.subarray(0, target.at), replacement, b.subarray(target.end));
    const view = new DataView(out.buffer);
    for (const box of chain.slice(0, -1)) view.setUint32(box.at, new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(box.at) + grow);
    return out;
  }

  const hot = async (): Promise<Uint8Array> => new Uint8Array(await readFile(musicTracks.hot.file));
  const lines = (count: number, width: number): string => Array.from({ length: count }, (_, i) => `p${String(i).padStart(6, "0")}-${"y".repeat(width)}`).join("\n");

  test("x1: a real attached picture pushed past the cap by a huge handler_name is refused, not parsed as if the dump were whole", async () => {
    const withPicture = appendIntoMoov(await hot(), mdtaArtwork());
    const name = new TextEncoder().encode(lines(1800, 230));
    const hdlr = fullBox("hdlr", 0, concat(u32(0), new TextEncoder().encode("soun"), new Uint8Array(12), name, Uint8Array.of(0)));
    const bytes = replaceIn(withPicture, ["moov", "trak", "mdia", "hdlr"], hdlr);
    expect(name.byteLength).toBeGreaterThan(256 * 1024);
    const path = await tempFile(bytes);
    // The walker alone sees nothing wrong with it, and decodeAudio is called directly so only the ffmpeg layer is in play.
    await expect(inspectStreams({ path, signal: signal() })).rejects.toMatchObject({ kind: "dump-too-large" });
    expect((await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }))).kind).toBe("dump-too-large");
  });

  test("x2: a metadata key that prints a fake `Stream #0:0: Audio` line, with global padding past the cap, is refused", async () => {
    const jpeg = JPEG;
    const keyEntry = (n: Uint8Array): Uint8Array => concat(u32(8 + n.length), new TextEncoder().encode("mdta"), n);
    const keys = fullBox("keys", 0, concat(u32(2), keyEntry(new TextEncoder().encode("com.apple.quicktime.artwork")), keyEntry(new TextEncoder().encode("z\nStream #0:0: Audio: injected"))));
    const hdlr = fullBox("hdlr", 0, concat(u32(0), new TextEncoder().encode("mdta"), u32(0), u32(0), u32(0), Uint8Array.of(0)));
    const art = concat(u32(8 + 16 + jpeg.length), u32(1), box("data", concat(u32(13), u32(0), jpeg)));
    const text = (value: string): Uint8Array => {
      const t = new TextEncoder().encode(value);
      return concat(u32(8 + 16 + t.length), u32(2), box("data", concat(u32(1), u32(0), t)));
    };
    const meta = fullBox("meta", 0, concat(hdlr, keys, box("ilst", concat(text(lines(1800, 200)), art))));
    const path = await tempFile(appendIntoMoov(await hot(), box("udta", meta)));
    await expect(inspectStreams({ path, signal: signal() })).rejects.toMatchObject({ kind: "dump-too-large" });
    expect((await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }))).kind).toBe("dump-too-large");
  });

  test("x3: the same fake line with no padding only ADDS a stream, so it is refused as a second one", async () => {
    const keyEntry = (n: Uint8Array): Uint8Array => concat(u32(8 + n.length), new TextEncoder().encode("mdta"), n);
    const keys = fullBox("keys", 0, concat(u32(2), keyEntry(new TextEncoder().encode("com.apple.quicktime.artwork")), keyEntry(new TextEncoder().encode("z\nStream #0:0: Audio: injected"))));
    const hdlr = fullBox("hdlr", 0, concat(u32(0), new TextEncoder().encode("mdta"), u32(0), u32(0), u32(0), Uint8Array.of(0)));
    const art = concat(u32(8 + 16 + JPEG.length), u32(1), box("data", concat(u32(13), u32(0), JPEG)));
    const short = new TextEncoder().encode("short");
    const item = concat(u32(8 + 16 + short.length), u32(2), box("data", concat(u32(1), u32(0), short)));
    const meta = fullBox("meta", 0, concat(hdlr, keys, box("ilst", concat(item, art))));
    const path = await tempFile(appendIntoMoov(await hot(), box("udta", meta)));
    const kind = (await failureOf(decodeAudio({ path, expectedMs: musicTracks.hot.durationMs, signal: signal() }))).kind;
    expect(["extra-stream", "bad-dump"]).toContain(kind);
  });

  test("the real files' dumps are far below the cap", async () => {
    for (const fixture of Object.values(musicTracks)) {
      const path = await tempFile(new Uint8Array(await readFile(fixture.file)));
      const made = spawnSync(ffmpegPath(), ["-nostdin", "-hide_banner", "-f", "mov", "-i", path]);
      expect(made.stderr.byteLength).toBeLessThan(8 * 1024);
    }
  });
});
