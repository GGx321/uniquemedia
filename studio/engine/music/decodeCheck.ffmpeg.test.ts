import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { FfmpegChild, FfmpegSpawner } from "../../node/runFfmpeg";
import { configureFfmpegEnv } from "../../node/ffmpegEnv";
import { decodeAudio, DecodeError, PEAK_STEP_MS } from "./decodeCheck";
import { musicTracks } from "./fixtures";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Invariant 31, acceptance, second gate: the file is decoded by ffmpeg under a time bound and an output bound, from a
// file on disk (never the network), with the mov demuxer forced and only the file protocol allowed, and what came out
// must be about as long as the list claimed. The same decode yields the waveform `music.peaks` serves.

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

  test("bytes that are not media at all fail in ffmpeg, not by hanging", async () => {
    const path = await tempFile(Uint8Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) & 0xff));
    expect((await failureOf(decodeAudio({ path, expectedMs: 8_000, signal: signal() }))).kind).toBe("exit");
  });

  test("an MP3 renamed .m4a is not decoded: the mov demuxer is forced, so the extension and the content cannot pick another one", async () => {
    const path = await tempFile(new TextEncoder().encode("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000".padEnd(2048, "ÿ")));
    expect((await failureOf(decodeAudio({ path, expectedMs: 8_000, signal: signal() }))).kind).toBe("exit");
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
    const error = await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), timeoutMs: 60, spawner }));
    expect(error.kind).toBe("timeout");
    expect(killed()).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("a caller's abort kills it", async () => {
    const controller = new AbortController();
    const { spawner, killed } = fakeSpawner({ exit: "never" });
    const run = decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: controller.signal, timeoutMs: 5000, spawner });
    setTimeout(() => controller.abort(), 20);
    expect((await failureOf(run)).kind).toBe("aborted");
    expect(killed()).toBe(true);
  });

  test("an already aborted signal starts nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    let spawned = false;
    const { spawner } = fakeSpawner({ onSpawn: () => void (spawned = true) });
    expect((await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: controller.signal, spawner }))).kind).toBe("aborted");
    expect(spawned).toBe(false);
  });

  test("output beyond the bound for the claimed length kills ffmpeg: a file cannot make it write without limit", async () => {
    const { spawner, killed } = fakeSpawner({ stdout: [pcm(60), pcm(60), pcm(60)], exit: "never" });
    const error = await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), timeoutMs: 5000, spawner }));
    expect(error.kind).toBe("too-long");
    expect(killed()).toBe(true);
  });

  test("a non-zero exit is `exit` even when it printed audio first", async () => {
    const { spawner } = fakeSpawner({ stdout: [pcm(8)], exit: 1 });
    expect((await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("exit");
  });

  test("a clean exit with no audio is `no-audio`", async () => {
    const { spawner } = fakeSpawner({ stdout: [], exit: 0 });
    expect((await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("no-audio");
  });

  test("a spawn that fails is `spawn`", async () => {
    const spawner: FfmpegSpawner = () => {
      throw new Error("ENOENT");
    };
    expect((await failureOf(decodeAudio({ path: "/tmp/x.m4a", expectedMs: 8_000, signal: signal(), spawner }))).kind).toBe("spawn");
  });
});

describe("how ffmpeg is started", () => {
  const seen = async (path = "/tmp/track.m4a"): Promise<{ args: readonly string[]; env: Record<string, string> | undefined }> => {
    let got: { args: readonly string[]; env: Record<string, string> | undefined } | null = null;
    const { spawner } = fakeSpawner({ stdout: [pcm(8)], onSpawn: (args, env) => void (got = { args, env }) });
    await decodeAudio({ path, expectedMs: 8_000, signal: signal(), spawner });
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
