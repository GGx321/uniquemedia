import { describe, expect, test } from "bun:test";
import { fakeSpawner } from "../../node/fakeFfmpeg.testkit";
import { PROBE_CODEC_WHITELIST, ProbeError, probeArgv, probeDump } from "./audioProbe";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The probe's child process (3f.4): hardened argv, a bounded dump, and a child that is killed on a cancel and on a time-out.

const signal = (): AbortSignal => new AbortController().signal;
const PATH = process.platform === "win32" ? "C:\\lib\\media\\.staging\\a.media" : "/lib/media/.staging/a.media";

async function failure(run: Promise<unknown>): Promise<ProbeError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof ProbeError) return error;
    throw error;
  }
  throw new Error("expected the probe to fail");
}

describe("the probe's argv", () => {
  test("forces the demuxer, allows only the file protocol, caps allocations, reads no stdin and opens only the importer's decoders", () => {
    const argv = probeArgv({ path: PATH, demuxer: "mp3" });
    expect(argv).toEqual(["-nostdin", "-hide_banner", "-max_alloc", "67108864", "-protocol_whitelist", "file", "-codec_whitelist", PROBE_CODEC_WHITELIST, "-f", "mp3", "-i", PATH]);
  });

  test("the whitelist names exactly the decoders the importer takes, and no picture decoder", () => {
    const names = PROBE_CODEC_WHITELIST.split(",");
    expect(names).toEqual(expect.arrayContaining(["mp3float", "aac", "alac", "flac", "vorbis", "opus", "pcm_s16le"]));
    for (const picture of ["mjpeg", "png", "bmp", "gif", "webp"]) expect(names).not.toContain(picture);
  });

  test("a relative path is refused before anything is spawned", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined);
    await expect(probeDump({ path: "a.mp3", demuxer: "mp3", signal: signal(), spawner })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("the dump", () => {
  test("is what ffmpeg printed on stderr, whatever its exit code", async () => {
    const { spawner } = fakeSpawner(({ child }) => {
      child.complain("Input #0, mp3, from 'a':\n  Stream #0:0: Audio: mp3, 44100 Hz\nAt least one output file must be specified\n");
      child.exit(1);
    });
    expect(await probeDump({ path: PATH, demuxer: "mp3", signal: signal(), spawner })).toContain("Stream #0:0: Audio: mp3");
  });

  test("past the cap is refused, never read as if it were whole, and the child is stopped", async () => {
    const { spawner, calls } = fakeSpawner(({ child }) => {
      child.complain(Buffer.alloc(300 * 1024, 0x61));
    }, true);
    const error = await failure(probeDump({ path: PATH, demuxer: "mp3", signal: signal(), spawner }));
    expect(error.kind).toBe("dump-too-large");
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });

  test("a child that cannot be started is a spawn failure, with no text of the system's", async () => {
    const error = await failure(
      probeDump({
        path: PATH,
        demuxer: "mp3",
        signal: signal(),
        spawner: () => {
          throw new Error(`ENOENT ${PATH}`);
        },
      }),
    );
    expect(error.kind).toBe("spawn");
    expect(error.message).not.toContain(PATH);
  });
});

describe("a cancel and a time-out", () => {
  test("a cancel kills the child and rejects once it is gone", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined, true);
    const controller = new AbortController();
    const running = failure(probeDump({ path: PATH, demuxer: "mp3", signal: controller.signal, spawner }));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect((await running).kind).toBe("aborted");
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
    expect(calls[0]?.child.closed).toBe(true);
  });

  test("a cancel that came before the probe starts spawns nothing", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined);
    const controller = new AbortController();
    controller.abort();
    expect((await failure(probeDump({ path: PATH, demuxer: "mp3", signal: controller.signal, spawner }))).kind).toBe("aborted");
    expect(calls).toHaveLength(0);
  });

  test("a child that never answers is killed at the time limit", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined, true);
    const error = await failure(probeDump({ path: PATH, demuxer: "mp3", signal: signal(), spawner, timeoutMs: 20 }));
    expect(error.kind).toBe("timeout");
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });
});
