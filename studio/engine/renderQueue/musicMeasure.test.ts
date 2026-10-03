import { afterEach, describe, expect, test } from "bun:test";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { configureFfmpegEnv } from "../../node/ffmpegEnv";
import { fakeSpawner } from "../../node/fakeFfmpeg.testkit";
import { FfmpegError, FfmpegTimeoutError } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { buildMusicMeasure } from "../render/musicChain";
import { RenderGraphError } from "../render/types";
import { measureTruePeak } from "./musicMeasure";
useNativeGlobals();

// The runner of the true-peak pass (3c.5): it starts ffmpeg with the builder's argv, keeps the tail of stderr, reads the peak
// from ebur128's summary, and stops on a time bound or a cancel. A scripted child plays ffmpeg.

const job = buildMusicMeasure({ path: "/userdata/music/tracks/42.m4a", startMs: 0, durationMs: 6_000 });
const summary = (peak: string): string => `[Parsed_ebur128_4 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -13.6 LUFS\n\n  True peak:\n    Peak:        ${peak} dBFS\n`;

afterEach(() => configureFfmpegEnv(undefined));

describe("measureTruePeak", () => {
  test("answers the true peak from the summary on stderr", async () => {
    const { spawner } = fakeSpawner(({ child }) => {
      child.complain(summary("3.0"));
      child.exit(0);
    });
    expect(await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner })).toBe(3.0);
  });

  test("answers minus infinity for a silent segment", async () => {
    const { spawner } = fakeSpawner(({ child }) => {
      child.complain(summary("-inf"));
      child.exit(0);
    });
    expect(await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner })).toBe(Number.NEGATIVE_INFINITY);
  });

  test("runs the bundled ffmpeg with exactly the builder's argv and no stdin", async () => {
    const { spawner, calls } = fakeSpawner(({ child }) => {
      child.complain(summary("-5.7"));
      child.exit(0);
    });
    await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe(ffmpegPath());
    expect(calls[0]?.args).toEqual(job.argv);
    expect(calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
  });

  test("hands the child the engine's allowlisted environment, never the parent's", async () => {
    configureFfmpegEnv({ PATH: "/usr/bin" });
    const { spawner, calls } = fakeSpawner(({ child }) => {
      child.complain(summary("-5.7"));
      child.exit(0);
    });
    await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner });
    expect(Object.keys(calls[0]?.options.env ?? {})).toEqual(["PATH"]);
  });

  test("still finds the summary after a long stretch of other output", async () => {
    const { spawner } = fakeSpawner(({ child }) => {
      for (let i = 0; i < 200; i++) child.complain(`${"x".repeat(1000)}\n`);
      child.complain(summary("-1.6"));
      child.exit(0);
    });
    expect(await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner })).toBe(-1.6);
  });

  test("rejects with an FfmpegError carrying the exit code when ffmpeg fails", async () => {
    const { spawner } = fakeSpawner(({ child }) => {
      child.complain("track.m4a: Invalid data found when processing input\n");
      child.exit(1);
    });
    const error = await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error instanceof FfmpegError && error.exitCode).toBe(1);
  });

  test("rejects as BAD_AUDIO when ffmpeg exits 0 with no true peak in its summary", async () => {
    const { spawner } = fakeSpawner(({ child }) => {
      child.complain("Summary:\n  Integrated loudness:\n    I: -13.6 LUFS\n");
      child.exit(0);
    });
    const error = await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 5_000, spawner }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderGraphError);
    expect(error instanceof RenderGraphError && error.code).toBe("BAD_AUDIO");
  });

  test("kills ffmpeg and rejects with an FfmpegTimeoutError when it does not answer in time", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined);
    const error = await measureTruePeak(job, { signal: new AbortController().signal, timeoutMs: 20, spawner }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });

  test("kills ffmpeg and rejects with the signal's own reason on a cancel", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined);
    const controller = new AbortController();
    const reason = new Error("cancelled by the owner");
    const pending = measureTruePeak(job, { signal: controller.signal, timeoutMs: 5_000, spawner }).catch((e: unknown) => e);
    setTimeout(() => controller.abort(reason), 10);
    expect(await pending).toBe(reason);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });

  test("does not start ffmpeg for a signal that is already aborted", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined);
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    expect(await measureTruePeak(job, { signal: controller.signal, timeoutMs: 5_000, spawner }).catch((e: unknown) => e)).toBe(reason);
    expect(calls).toHaveLength(0);
  });

  test("rejects when ffmpeg cannot be started", async () => {
    const error = await measureTruePeak(job, {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
      spawner: () => {
        throw new Error("spawn ENOENT /Users/alex/secret/ffmpeg");
      },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error instanceof Error && error.message).not.toContain("secret");
  });
});
