import { describe, expect, test } from "bun:test";
import { fakeSpawner } from "../../node/fakeFfmpeg.testkit";
import { PROBE_CODEC_WHITELIST, ProbeError, probeArgv, probeDump, selectionHasNoExtraStreams } from "./audioProbe";
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

// 3f.4 review H1, the check that parses no text: ffmpeg's OWN stream selection is the authority on whether the file holds more than the one audio stream the
// encode will map. `-map 0:a:1`, `0:V` (a real video: an attached picture is not one), `0:s`, `0:d` and `0:t` must each fail with "matches no streams".
describe("the stream selection check (3f.4 review H1)", () => {
  const SELECTORS = ["0:a:1", "0:V", "0:s", "0:d", "0:t"];
  const noStreams = (selector: string): string => `Stream map '${selector}' matches no streams.\nTo ignore this, add a trailing '?' to the map.\n`;
  const options = (spawner: Parameters<typeof probeDump>[0]["spawner"], extra: { timeoutMs?: number; signal?: AbortSignal } = {}) => ({ path: PATH, demuxer: "ogg" as const, signal: extra.signal ?? signal(), spawner, ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }) });

  /** A spawner that answers each selector as `answer(selector)` says: the text on stderr and the exit code. */
  function answering(answer: (selector: string) => { text: string; code: number }) {
    return fakeSpawner(({ child, args }) => {
      const selector = args[args.indexOf("-map") + 1] ?? "";
      const said = answer(selector);
      child.complain(said.text);
      child.exit(said.code);
    });
  }

  test("asks ffmpeg about each selector, in its own process, with the probe's hardening and the demuxer forced", async () => {
    const { spawner, calls } = answering((selector) => ({ text: noStreams(selector), code: 1 }));
    expect(await selectionHasNoExtraStreams(options(spawner))).toBe(true);
    expect(calls.map((call) => call.args[call.args.indexOf("-map") + 1])).toEqual(SELECTORS);
    for (const call of calls) {
      const argv = [...call.args];
      expect(argv).toEqual(expect.arrayContaining(["-nostdin", "-protocol_whitelist", "file", "-codec_whitelist", PROBE_CODEC_WHITELIST, "-f", "ogg", "-i", PATH]));
      // Nothing is written anywhere: the output is the null muxer, and a stream that does match is decoded for a blink at most.
      expect(argv.slice(-3)).toEqual(["-f", "null", "-"]);
      expect(argv).toContain("-t");
    }
  });

  test("passes when every selector matches no stream", async () => {
    expect(await selectionHasNoExtraStreams(options(answering((selector) => ({ text: noStreams(selector), code: 1 })).spawner))).toBe(true);
  });

  test.each(SELECTORS)("fails when %s DOES match a stream (ffmpeg goes on and exits 0)", async (selector) => {
    const { spawner } = answering((asked) => (asked === selector ? { text: "", code: 0 } : { text: noStreams(asked), code: 1 }));
    expect(await selectionHasNoExtraStreams(options(spawner))).toBe(false);
  });

  test("fails when a selector fails for ANY OTHER reason than matching nothing: a stream whose decoder is not allowed is still a stream", async () => {
    const { spawner } = answering((selector) => (selector === "0:V" ? { text: "[theora @ 0x1] Codec (theora) not on whitelist\nError while opening decoder\n", code: 1 } : { text: noStreams(selector), code: 1 }));
    expect(await selectionHasNoExtraStreams(options(spawner))).toBe(false);
  });

  test("a refusal that names another selector does not count for this one", async () => {
    const { spawner } = answering((selector) => ({ text: selector === "0:a:1" ? noStreams("0:s") : noStreams(selector), code: 1 }));
    expect(await selectionHasNoExtraStreams(options(spawner))).toBe(false);
  });

  test("the message must come with a failing exit: a child that prints it and exits 0 proved nothing", async () => {
    const { spawner } = answering((selector) => ({ text: noStreams(selector), code: selector === "0:d" ? 0 : 1 }));
    expect(await selectionHasNoExtraStreams(options(spawner))).toBe(false);
  });

  test("stops asking at the first selector that finds a stream", async () => {
    const { spawner, calls } = answering((selector) => (selector === "0:a:1" ? { text: "", code: 0 } : { text: noStreams(selector), code: 1 }));
    expect(await selectionHasNoExtraStreams(options(spawner))).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("a cancel kills the running child and rejects as aborted", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined, true);
    const controller = new AbortController();
    const running = failure(selectionHasNoExtraStreams(options(spawner, { signal: controller.signal })));
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    expect((await running).kind).toBe("aborted");
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });

  test("a child that never answers is killed at the time limit", async () => {
    const { spawner, calls } = fakeSpawner(() => undefined, true);
    expect((await failure(selectionHasNoExtraStreams(options(spawner, { timeoutMs: 20 })))).kind).toBe("timeout");
    expect(calls[0]?.child.killedWith).toEqual(["SIGKILL"]);
  });

  test("a relative path is refused before anything is spawned", async () => {
    const { spawner, calls } = answering(() => ({ text: "", code: 0 }));
    await expect(selectionHasNoExtraStreams({ ...options(spawner), path: "a.ogg" })).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});
