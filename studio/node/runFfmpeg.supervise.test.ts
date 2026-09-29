import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FILTER_THREAD_ARGS as BUILDER_FILTER_THREAD_ARGS } from "../engine/render/profile";
import { configureFfmpegEnv } from "./ffmpegEnv";
import { fakeSpawner, outputOf, type FakeFfmpegChild } from "./fakeFfmpeg.testkit";
import { FfmpegError, FfmpegTimeoutError, FILTER_THREAD_ARGS, runFfmpeg, runFfmpegArgv } from "./runFfmpeg";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// runFfmpeg and runFfmpegArgv against a scripted child: the supervision (env,
// cwd, timeout, kill, progress in frames, error shapes) without a real ffmpeg.

const ARGV = ["-hide_banner", "-nostdin", "-y", "-i", "in.png", "-c:v", "libx264", "/out/clip.mkv"];
const OUT = "/out/clip.mkv";
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-supervise-"));
  dirs.push(dir);
  return dir;
}

function succeed(child: FakeFfmpegChild): void {
  child.report(30, true);
  child.exit(0);
}

describe("runFfmpegArgv: how the child is started", () => {
  test("passes the allowlisted environment only, never a secret", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: { PATH: "/usr/bin", OPENROUTER_API_KEY: "sk-secret", NODE_OPTIONS: "--inspect" } });

    expect(calls[0]?.options.env).toEqual({ PATH: "/usr/bin" });
  });

  test("uses the configured environment when none is given, through the allowlist", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));
    configureFfmpegEnv({ PATH: "/usr/bin", STUDIO_TEST_SECRET: "sk-secret" });
    try {
      await runFfmpegArgv({ argv: ARGV, output: OUT, spawner });
    } finally {
      configureFfmpegEnv(undefined);
    }

    expect(calls[0]?.options.env).toEqual({ PATH: "/usr/bin" });
  });

  test("passes no environment at all when none is given and none is configured: the child inherits its parent's (tests and tools only)", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner });

    expect(calls[0]?.options.env).toBeUndefined();
  });

  test("an environment given to the call wins over the configured one", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));
    configureFfmpegEnv({ PATH: "/configured" });
    try {
      await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: { PATH: "/given" } });
    } finally {
      configureFfmpegEnv(undefined);
    }

    expect(calls[0]?.options.env).toEqual({ PATH: "/given" });
  });

  test("starts the child in the given working directory", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, cwd: "/work/job-1" });

    expect(calls[0]?.options.cwd).toBe("/work/job-1");
  });

  test("puts the filter thread caps and the progress pipe in front of the output", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {} });

    const args = calls[0]?.args ?? [];
    expect(args.slice(0, 4)).toEqual([...FILTER_THREAD_ARGS]);
    expect(args.slice(-4)).toEqual(["-progress", "pipe:1", "-nostats", "/out/clip.mkv"]);
    expect(args.slice(4, -4)).toEqual(ARGV.slice(0, -1));
  });

  test("does not repeat filter thread caps the builder already put in", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));
    const argv = ["-hide_banner", "-nostdin", "-y", ...BUILDER_FILTER_THREAD_ARGS, "-i", "in.png", "/out/clip.mkv"];

    await runFfmpegArgv({ argv, output: OUT, spawner, env: {} });

    const args = calls[0]?.args ?? [];
    expect(args.filter((a) => a === "-filter_threads")).toHaveLength(1);
    expect(args.filter((a) => a === "-filter_complex_threads")).toHaveLength(1);
  });

  test("uses the same filter thread caps as the graph builder", () => {
    expect([...FILTER_THREAD_ARGS]).toEqual([...BUILDER_FILTER_THREAD_ARGS]);
  });

  test("refuses an empty argv", async () => {
    await expect(runFfmpegArgv({ argv: [], output: OUT, env: {} })).rejects.toThrow(TypeError);
  });
});

describe("runFfmpegArgv: progress in frames", () => {
  test("reports the frame count of each progress report, in order", async () => {
    const seen: number[] = [];
    const { spawner } = fakeSpawner((c) => {
      c.child.report(10);
      c.child.report(20);
      succeed(c.child);
    });

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, onFrames: (n) => seen.push(n) });

    expect(seen).toEqual([10, 20, 30]);
  });

  test("never reports a repeated or smaller count", async () => {
    const seen: number[] = [];
    const { spawner } = fakeSpawner((c) => {
      c.child.report(10);
      c.child.report(10);
      c.child.report(5);
      c.child.report(12);
      succeed(c.child);
    });

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, onFrames: (n) => seen.push(n) });

    expect(seen).toEqual([10, 12, 30]);
  });

  test("sees every report when ffmpeg flushes several in one write", async () => {
    const seen: number[] = [];
    const { spawner } = fakeSpawner((c) => {
      c.child.stdout.write("frame=4\nprogress=continue\nframe=9\nprogress=continue\nframe=1");
      c.child.stdout.write("5\nprogress=continue\n");
      succeed(c.child);
    });

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, onFrames: (n) => seen.push(n) });

    expect(seen).toEqual([4, 9, 15, 30]);
  });

  test("kills the child and rejects with the listener's own error when onFrames throws", async () => {
    const boom = new Error("listener broke");
    const { spawner, calls } = fakeSpawner((c) => c.child.report(3));

    await expect(
      runFfmpegArgv({
        argv: ARGV,
        output: OUT,
        spawner,
        env: {},
        onFrames: () => {
          throw boom;
        },
      }),
    ).rejects.toBe(boom);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });
});

describe("runFfmpegArgv: how it ends", () => {
  test("rejects with the exit code and only a short stderr tail when ffmpeg fails", async () => {
    const { spawner } = fakeSpawner((c) => {
      c.child.complain("x".repeat(50_000));
      c.child.complain("\nError: Invalid data found when processing input\n");
      c.child.exit(1);
    });

    const error = await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {} }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegError);
    if (!(error instanceof FfmpegError)) throw error;
    expect(error.exitCode).toBe(1);
    expect(error.stderrTail.length).toBeLessThanOrEqual(2000);
    expect(error.stderrTail).toContain("Invalid data found when processing input");
  });

  test("rejects with the spawn error when the binary cannot be started", async () => {
    const { spawner } = fakeSpawner((c) => {
      c.child.emit("error", Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
      c.child.exit(-2);
    });

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {} })).rejects.toThrow("ENOENT");
  });

  test("rejects when the spawner itself throws", async () => {
    const spawner = (): never => {
      throw new Error("EAGAIN: no more processes");
    };

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {} })).rejects.toThrow("EAGAIN");
  });

  test("rejects with the abort reason, after the child has really exited, and kills it", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled by the user");
    const { spawner, calls } = fakeSpawner((c) => c.child.report(5), false);

    const run = runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, signal: controller.signal });
    const outcome = run.then(
      () => "resolved",
      (e: unknown) => e,
    );
    await flush();
    controller.abort(reason);
    await flush();
    const child = calls[0]?.child;
    expect(child?.killedWith).toEqual(["SIGKILL"]);
    // The promise must not settle while the process may still be alive.
    expect(await Promise.race([outcome, flush().then(() => "pending")])).toBe("pending");
    child?.exit(null, "SIGKILL");

    expect(await outcome).toBe(reason);
  });

  test("does not start a child when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already stopped"));
    const { spawner, calls } = fakeSpawner(() => {});

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, signal: controller.signal })).rejects.toThrow("already stopped");
    expect(calls).toHaveLength(0);
  });

  test("resolves when the abort arrives after ffmpeg already exited 0", async () => {
    const controller = new AbortController();
    const { spawner } = fakeSpawner((c) => {
      succeed(c.child);
      controller.abort(new Error("too late"));
    });

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, signal: controller.signal })).resolves.toBeUndefined();
  });
});

describe("runFfmpegArgv: the timeout", () => {
  test("kills a child that runs too long and rejects with a timeout error that says how long", async () => {
    const { spawner, calls } = fakeSpawner((c) => c.child.complain("still encoding\n"));

    const error = await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, timeoutMs: 30 }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    if (!(error instanceof FfmpegTimeoutError)) throw error;
    expect(error).toBeInstanceOf(FfmpegError);
    expect(error.timeoutMs).toBe(30);
    expect(error.message).toContain("30 ms");
    expect(error.stderrTail).toContain("still encoding");
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
    expect(calls[0]?.child.closed).toBe(true);
  });

  test("does not fire once the child has finished in time", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));

    await runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, timeoutMs: 30 });
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(calls[0]?.child.killedWith).toEqual([]);
  });

  test("an abort that comes first wins over a timeout that would have come later", async () => {
    const controller = new AbortController();
    const reason = new Error("stop");
    const { spawner } = fakeSpawner((c) => c.child.report(1));

    const run = runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, timeoutMs: 40, signal: controller.signal });
    const outcome = run.catch((e: unknown) => e);
    await flush();
    controller.abort(reason);

    expect(await outcome).toBe(reason);
  });

  test("refuses a timeout that is not positive", async () => {
    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, env: {}, timeoutMs: 0 })).rejects.toThrow(TypeError);
  });
});

describe("runFfmpeg (temp file, then rename) gets the same supervision", () => {
  test("puts the filter thread caps first and passes env, cwd and frames through", async () => {
    const dir = tempDir();
    const seen: number[] = [];
    const { spawner, calls } = fakeSpawner((c) => {
      writeFileSync(outputOf(c.args), "video");
      c.child.report(15);
      succeed(c.child);
    });

    await runFfmpeg({
      inputs: [{ path: "in.png" }],
      args: ["-c:v", "libx264"],
      output: join(dir, "out.mp4"),
      durationSec: 1,
      spawner,
      env: { PATH: "/usr/bin", SECRET: "x" },
      cwd: dir,
      onFrames: (n) => seen.push(n),
    });

    const call = calls[0];
    expect(call?.args.slice(0, 3)).toEqual(["-hide_banner", "-nostdin", "-y"]);
    expect(call?.args.slice(3, 7)).toEqual([...FILTER_THREAD_ARGS]);
    expect(call?.options.env).toEqual({ PATH: "/usr/bin" });
    expect(call?.options.cwd).toBe(dir);
    expect(seen).toEqual([15, 30]);
    expect(existsSync(join(dir, "out.mp4"))).toBe(true);
  });

  test("a timeout removes the half-written temp file and leaves no output", async () => {
    const dir = tempDir();
    const { spawner } = fakeSpawner((c) => writeFileSync(outputOf(c.args), "half"));

    const error = await runFfmpeg({
      inputs: [{ path: "in.png" }],
      args: [],
      output: join(dir, "out.mp4"),
      durationSec: 1,
      spawner,
      env: {},
      timeoutMs: 30,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FfmpegTimeoutError);
    expect(existsSync(join(dir, "out.mp4"))).toBe(false);
    expect(Bun.spawnSync(["ls", "-A", dir]).stdout.toString()).toBe("");
  });
});

describe("runFfmpegArgv: review round 1", () => {
  test("refuses an argv that does not end with the output it was told, before any child starts", async () => {
    const { spawner, calls } = fakeSpawner(() => {});

    await expect(runFfmpegArgv({ argv: ARGV, output: "/elsewhere/other.mkv", spawner, env: {} })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });

  test("a timeout that fires after ffmpeg exited 0, before close, does not turn the success into a timeout", async () => {
    const { spawner, calls } = fakeSpawner((c) => {
      c.child.report(30, true);
      c.child.exit(0, null, 80); // exited now, `close` 80 ms later; the 20 ms timer fires in between
    });

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {}, timeoutMs: 20 })).resolves.toBeUndefined();
    expect(calls[0]?.child.killedWith).toEqual([]);
  });

  test("a stream error on stdout kills the child and rejects with that error instead of crashing the process", async () => {
    const broken = new Error("EPIPE: stdout broke");
    const { spawner, calls } = fakeSpawner((c) => c.child.stdout.emit("error", broken));

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {} })).rejects.toBe(broken);
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });

  test("a stream error on stderr does the same", async () => {
    const broken = new Error("EPIPE: stderr broke");
    const { spawner } = fakeSpawner((c) => c.child.stderr.emit("error", broken));

    await expect(runFfmpegArgv({ argv: ARGV, output: OUT, spawner, env: {} })).rejects.toBe(broken);
  });

  test("adds the missing filter cap when the builder wrote only one of the two", async () => {
    const { spawner, calls } = fakeSpawner((c) => succeed(c.child));
    const argv = ["-hide_banner", "-nostdin", "-y", "-filter_threads", "2", "-i", "in.png", OUT];

    await runFfmpegArgv({ argv, output: OUT, spawner, env: {} });

    const args = calls[0]?.args ?? [];
    expect(args.filter((a) => a === "-filter_threads")).toHaveLength(1);
    expect(args.filter((a) => a === "-filter_complex_threads")).toHaveLength(1);
    expect(args[args.indexOf("-filter_complex_threads") + 1]).toBe("2");
  });
});
