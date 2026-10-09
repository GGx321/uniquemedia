import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import * as durableFs from "../library/durableFs";
import { AUTOPILOT_TRACKS_FILE, AutopilotTrackFlags } from "./autopilotTrackFlags";
useNativeGlobals();

// The «для автопилота» flag of an own track (Stage 4, S4.5d; plan §7): an append-only log `<library>/media/autopilot-tracks.jsonl`, `{ mediaId, on, at }`, the last line
// per track wins. A log that is torn or cannot be read says «no own track is flagged»: the autopilot then uses fewer tracks, never an unflagged one.

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

let dir = "";
let path = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-track-flags-"));
  await mkdir(join(dir, "media"), { recursive: true });
  path = join(dir, "media", AUTOPILOT_TRACKS_FILE);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const flags = () => new AutopilotTrackFlags(path, () => NOW);
const line = (mediaId: string, on: boolean) => `${JSON.stringify({ mediaId, on, at: new Date(NOW).toISOString() })}\n`;
const sorted = (set: ReadonlySet<string>): string[] => [...set].sort();

describe("the log's name", () => {
  test("is autopilot-tracks.jsonl", () => {
    expect(AUTOPILOT_TRACKS_FILE).toBe("autopilot-tracks.jsonl");
  });
});

describe("reading", () => {
  test("a library with no log has no flagged track", async () => {
    expect(sorted(await flags().flagged())).toEqual([]);
  });

  test("a track whose last line says on is flagged", async () => {
    await writeFile(path, line("media-aaaaaaaa", true));
    expect(sorted(await flags().flagged())).toEqual(["media-aaaaaaaa"]);
  });

  test("the last line per track wins: on, off, on is flagged and on, off is not", async () => {
    await writeFile(path, line("media-aaaaaaaa", true) + line("media-bbbbbbbb", true) + line("media-aaaaaaaa", false) + line("media-bbbbbbbb", false) + line("media-bbbbbbbb", true));
    expect(sorted(await flags().flagged())).toEqual(["media-bbbbbbbb"]);
  });

  test("a torn last line (a crash inside an append) means no own track is flagged, the complete lines before it included", async () => {
    await writeFile(path, line("media-aaaaaaaa", true) + '{"mediaId":"media-bbbbbbbb","on":tr');
    expect(sorted(await flags().flagged())).toEqual([]);
  });

  test("a complete line that is not JSON means no own track is flagged", async () => {
    await writeFile(path, `${line("media-aaaaaaaa", true)}not json\n`);
    expect(sorted(await flags().flagged())).toEqual([]);
  });

  test("a complete line that breaks the schema (a wrong type, an extra field) means no own track is flagged", async () => {
    await writeFile(path, `${line("media-aaaaaaaa", true)}${JSON.stringify({ mediaId: "media-bbbbbbbb", on: "yes", at: new Date(NOW).toISOString() })}\n`);
    expect(sorted(await flags().flagged())).toEqual([]);
    await writeFile(path, `${line("media-aaaaaaaa", true)}${JSON.stringify({ mediaId: "media-bbbbbbbb", on: true, at: new Date(NOW).toISOString(), extra: 1 })}\n`);
    expect(sorted(await flags().flagged())).toEqual([]);
  });

  test("a log that cannot be read at all (a folder where the file should be) means no own track is flagged", async () => {
    await mkdir(path);
    expect(sorted(await flags().flagged())).toEqual([]);
  });
});

describe("writing", () => {
  test("a flag round-trips: set on, read back flagged; set off, read back not flagged", async () => {
    const log = flags();
    await log.set("media-aaaaaaaa", true);
    expect(sorted(await log.flagged())).toEqual(["media-aaaaaaaa"]);
    await log.set("media-aaaaaaaa", false);
    expect(sorted(await log.flagged())).toEqual([]);
  });

  test("a line is { mediaId, on, at } with at as an ISO time, one per call, appended", async () => {
    const log = flags();
    await log.set("media-aaaaaaaa", true);
    await log.set("media-aaaaaaaa", false);
    const lines = (await readFile(path, "utf8")).split("\n").filter((l) => l !== "");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { mediaId: "media-aaaaaaaa", on: true, at: new Date(NOW).toISOString() },
      { mediaId: "media-aaaaaaaa", on: false, at: new Date(NOW).toISOString() },
    ]);
  });

  test("a flag survives a new instance over the same file (a restart)", async () => {
    await flags().set("media-aaaaaaaa", true);
    expect(sorted(await flags().flagged())).toEqual(["media-aaaaaaaa"]);
  });

  test("a set over a damaged log (a complete bad line) refuses and leaves the file as it was", async () => {
    const damaged = `${line("media-aaaaaaaa", true)}not json\n`;
    await writeFile(path, damaged);
    await expect(flags().set("media-bbbbbbbb", true)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(damaged);
    expect(sorted(await flags().flagged())).toEqual([]);
  });

  test("a set over a torn log does not bring back the flags the torn log was hiding: only the track just set is flagged", async () => {
    await writeFile(path, line("media-aaaaaaaa", true) + '{"mediaId":"media-cc');
    const log = flags();
    expect(sorted(await log.flagged())).toEqual([]);
    await log.set("media-bbbbbbbb", true);
    expect(sorted(await log.flagged())).toEqual(["media-bbbbbbbb"]);
  });

  test("concurrent sets are all kept, in call order", async () => {
    const log = flags();
    await Promise.all([log.set("media-aaaaaaaa", true), log.set("media-bbbbbbbb", true), log.set("media-aaaaaaaa", false)]);
    expect(sorted(await log.flagged())).toEqual(["media-bbbbbbbb"]);
  });

  test("a media id that is not an id is refused and nothing is written", async () => {
    await expect(flags().set("../media", true)).rejects.toThrow();
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  test("a set that already stands writes nothing: the log keeps one line per change", async () => {
    const log = flags();
    await log.set("media-aaaaaaaa", true);
    await log.set("media-aaaaaaaa", true);
    await log.set("media-bbbbbbbb", false);
    expect((await readFile(path, "utf8")).split("\n").filter((l) => l !== "")).toHaveLength(1);
  });

  test("on and off racing for one track end in the state of the LAST call", async () => {
    const log = flags();
    await Promise.all([log.set("media-aaaaaaaa", true), log.set("media-aaaaaaaa", false)]);
    expect(sorted(await log.flagged())).toEqual([]);
    await Promise.all([log.set("media-aaaaaaaa", false), log.set("media-aaaaaaaa", true)]);
    expect(sorted(await log.flagged())).toEqual(["media-aaaaaaaa"]);
  });
});

describe("healing a torn log is one step (no window where a hidden flag reads as on)", () => {
  const tornWithTwoHidden = () => line("media-aaaaaaaa", true) + line("media-cccccccc", true) + '{"mediaId":"media-dd';

  test("a second write that fails after the first leaves no hidden flag readable as on", async () => {
    await writeFile(path, tornWithTwoHidden());
    const real = durableFs.appendJsonLine;
    let calls = 0;
    const spy = spyOn(durableFs, "appendJsonLine").mockImplementation(async (target, value, options) => {
      if (++calls > 1) throw new Error("the disk failed");
      return real(target, value, options);
    });
    try {
      await flags()
        .set("media-bbbbbbbb", true)
        .catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    const readable = await flags().flagged();
    expect(readable.has("media-aaaaaaaa")).toBe(false);
    expect(readable.has("media-cccccccc")).toBe(false);
  });

  test("a crash right before the new log replaces the torn one leaves the torn log: still closed, nothing readable as on", async () => {
    await writeFile(path, tornWithTwoHidden());
    const crashing = new AutopilotTrackFlags(path, () => NOW, {
      beforeRename: async () => {
        throw new Error("crash");
      },
    });
    await expect(crashing.set("media-bbbbbbbb", true)).rejects.toThrow();
    expect(sorted(await flags().flagged())).toEqual([]);
  });

  test("the torn tail is kept in a .torn file beside the log, and the new log has only whole lines", async () => {
    await writeFile(path, tornWithTwoHidden());
    await flags().set("media-bbbbbbbb", true);
    expect(await readFile(`${path}.torn`, "utf8")).toContain('{"mediaId":"media-dd');
    expect((await readFile(path, "utf8")).endsWith("\n")).toBe(true);
    expect(sorted(await flags().flagged())).toEqual(["media-bbbbbbbb"]);
  });
});
