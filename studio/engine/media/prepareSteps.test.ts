import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { createRealDecodeBackend } from "../decode/realBackend";
import { createWasmImageDecoder } from "../decode/wasmDecode";
import { encodeStickerFrames } from "../stickers/encodeJob";
import { observer, type PrepareReporter } from "./imports";
import { createPhotoImporter, MAX_PHOTO_PIXELS } from "./photoImporter";
import { handoff, quadrantPicture } from "./photoFixtures.testkit";
import { flatGif } from "./stickerFixtures.testkit";
import { createStickerImporter, type StickerImporterDeps } from "./stickerImporter";
useNativeGlobals();

// 3f.6: a photo's and a sticker's import tell the job the same three coarse steps: the work is begun with 3 units, the picture is DECODED (1), the result is
// ENCODED and checked (2); the third unit is the end of the job (the record), which the job announces itself. A file that is refused never begins, and a reporter
// that throws changes nothing. `observer` is the one place a throw of a reporter is absorbed.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-prepare-steps-");
const NODE_MODULES_DIR = join(import.meta.dir, "../../../node_modules");
let decoder: ReturnType<typeof createWasmImageDecoder>;

beforeAll(async () => {
  decoder = createWasmImageDecoder(await createRealDecodeBackend(NODE_MODULES_DIR), { maxPixels: MAX_PHOTO_PIXELS });
});

/** A reporter that writes down what it was told, as one line each. */
function recording(): { prepare: PrepareReporter; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    prepare: {
      begin: (total, judged) => void lines.push(judged === undefined ? `begin ${total}` : `begin ${total} ${JSON.stringify(judged)}`),
      report: (done) => void lines.push(`report ${done}`),
    },
  };
}

const throwing: PrepareReporter = {
  begin: () => {
    throw new Error("begin broke");
  },
  report: () => {
    throw new Error("report broke");
  },
};

describe("observer", () => {
  test("passes what it is told on, unchanged, to the reporter it wraps", () => {
    const { prepare, lines } = recording();
    const seen = observer(prepare);
    seen.begin(3, { hdrToSdr: true, fromFps: null });
    seen.report(2);
    expect(lines).toEqual(['begin 3 {"hdrToSdr":true,"fromFps":null}', "report 2"]);
  });

  test("absorbs a throw of the reporter: the importer's work is never the reporter's failure", () => {
    const seen = observer(throwing);
    expect(() => seen.begin(3)).not.toThrow();
    expect(() => seen.report(1)).not.toThrow();
  });

  test("with no reporter it is a reporter that does nothing", () => {
    const seen = observer(undefined);
    expect(() => {
      seen.begin(3);
      seen.report(1);
    }).not.toThrow();
  });
});

describe("the photo importer's steps", () => {
  const importer = (): ReturnType<typeof createPhotoImporter> => createPhotoImporter({ decode: decoder });

  test("begins with three units, then tells decoded (1) and encoded (2), in that order, for a JPEG", async () => {
    const hand = await handoff(tmp(), await quadrantPicture(tmp(), "p", 64, 48, "jpeg"), { format: "jpeg" });
    const { prepare, lines } = recording();
    const outcome = await importer()({ ...hand.request, prepare });
    expect(outcome.ok).toBe(true);
    expect(lines).toEqual(["begin 3", "report 1", "report 2"]);
  });

  test("tells the same steps for a WebP, whose decode is an ffmpeg call", async () => {
    const hand = await handoff(tmp(), await quadrantPicture(tmp(), "p", 48, 32, "webp"), { format: "webp" });
    const { prepare, lines } = recording();
    expect((await importer()({ ...hand.request, prepare })).ok).toBe(true);
    expect(lines).toEqual(["begin 3", "report 1", "report 2"]);
  });

  test("a picture that is turned away says nothing: a file refused from its header never begins", async () => {
    const hand = await handoff(tmp(), new Uint8Array([1, 2, 3]), { format: "gif" });
    const { prepare, lines } = recording();
    expect((await importer()({ ...hand.request, prepare })).ok).toBe(false);
    expect(lines).toEqual([]);
  });

  test("a picture the decoder cannot read begins, and never reports a decode it did not make", async () => {
    // A JPEG's first bytes and nothing else: the header gives no size, so it is refused before the decode.
    const hand = await handoff(tmp(), new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]), { format: "jpeg" });
    const { prepare, lines } = recording();
    expect((await importer()({ ...hand.request, prepare })).ok).toBe(false);
    expect(lines).toEqual(["begin 3"]);
  });

  test("a reporter that throws does not fail the import", async () => {
    const hand = await handoff(tmp(), await quadrantPicture(tmp(), "p", 64, 48, "jpeg"), { format: "jpeg" });
    expect((await importer()({ ...hand.request, prepare: throwing })).ok).toBe(true);
  });
});

describe("the sticker importer's steps", () => {
  const encodeHere: StickerImporterDeps["encode"] = async (job, signal) => {
    signal.throwIfAborted();
    const raw = readFileSync(job.rawPath);
    const frameBytes = job.width * job.height * 4;
    return encodeStickerFrames(job, (index, into) => into.set(raw.subarray(index * frameBytes, (index + 1) * frameBytes)));
  };
  const importer = (): ReturnType<typeof createStickerImporter> => createStickerImporter({ encode: encodeHere });

  test("begins with three units, then tells decoded (1) and encoded (2), in that order", async () => {
    const hand = await handoff(tmp(), flatGif([0, 2], [10, 10]), { format: "gif", kind: "sticker" });
    const { prepare, lines } = recording();
    const outcome = await importer()({ ...hand.request, prepare });
    expect(outcome.ok).toBe(true);
    expect(lines).toEqual(["begin 3", "report 1", "report 2"]);
  });

  test("a sticker that is turned away from its header says nothing: it never begins", async () => {
    const hand = await handoff(tmp(), new Uint8Array([71, 73, 70, 56, 57, 97, 1]), { format: "gif", kind: "sticker" });
    const { prepare, lines } = recording();
    expect((await importer()({ ...hand.request, prepare })).ok).toBe(false);
    expect(lines).toEqual([]);
  });

  test("a still sticker (one frame) is refused before the work begins: nothing is reported", async () => {
    const hand = await handoff(tmp(), flatGif([0], [10]), { format: "gif", kind: "sticker" });
    const { prepare, lines } = recording();
    expect(await importer()({ ...hand.request, prepare })).toEqual({ ok: false, reason: "not-animated" });
    expect(lines).toEqual([]);
  });

  test("a reporter that throws does not fail the import", async () => {
    const hand = await handoff(tmp(), flatGif([0, 2], [10, 10]), { format: "gif", kind: "sticker" });
    expect((await importer()({ ...hand.request, prepare: throwing })).ok).toBe(true);
  });
});
