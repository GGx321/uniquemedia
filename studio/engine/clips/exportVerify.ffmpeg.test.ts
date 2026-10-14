import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpegArgv } from "../../node/runFfmpeg";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openFileSource } from "../media/video/fileSource";
import { probeVideo } from "../media/video/videoProbe";
import { verifyAndHashMp4 } from "../verify";
import { clipExportArgv } from "./exportProfile";
import { CLIP_EXPORT_FORBIDDEN_TEXT, verifyClipExport, type ClipExportVerdict } from "./exportVerify";
import { runFfmpegForFixture } from "./testing/clipFixtures";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4c (plan s5b1 I5.58, §8 V4c): what an exported clip says about itself is a hard boundary. A source seeded with a device, a place, «shot on», the provider and an
// encoder tag is exported with the real argv by the bundled ffmpeg, and `verifyClipExport` (its own allowlist on the render verifier's box primitives) must find nothing but the real
// `creation_time` and the BT.709 tags. Each of the profile's metadata flags is taken away once, and the verifier must catch what comes back. The render verifier (invariant 14) is
// untouched and still refuses this profile.

const EXPORTED_AT = new Date("2026-10-14T09:30:15.000Z");
/** What the source is seeded with; none of it may survive the export, anywhere outside the coded pictures. */
const SEEDED = ["Apple", "iPhone 15 Pro", "+48.8577+002.2950", "shot on iPhone", "Kling", "kwaivgi", "x-ai", "grok", "OpenRouter", "Kling encoder", "KlingVideoHandler", "GrokSound"];

let dir = "";
let source = "";
let clean = "";
let cleanVerdict: ClipExportVerdict;

/** The seeded source: Grok-like (a sound track), 720 x 1280, 24 fps, 1 s, with x264's own SEI and every tag a phone or a provider might write. */
async function seededSource(path: string): Promise<void> {
  await runFfmpegForFixture([
    "-f", "lavfi", "-i", "testsrc2=s=720x1280:r=24:d=1",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
    "-map", "0:v", "-map", "1:a",
    "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "32k",
    "-metadata", "make=Apple", "-metadata", "model=iPhone 15 Pro", "-metadata", "location=+48.8577+002.2950/", "-metadata", "comment=shot on iPhone",
    // The muxer replaces a container `encoder` with its own; the provider's names go into a description, and the stream's encoder tag becomes the compressor name.
    "-metadata", "description=kwaivgi kling via OpenRouter, x-ai grok",
    "-metadata:s:v:0", "encoder=Kling encoder", "-metadata:s:v:0", "handler_name=KlingVideoHandler", "-metadata:s:a:0", "handler_name=GrokSound",
    "-movflags", "+faststart+use_metadata_tags",
    path,
  ]);
}

/** The real argv, changed by `edit` (a flag taken away, a tag added), run by the bundled ffmpeg. */
async function exportWith(name: string, edit: (argv: string[]) => string[] = (argv) => argv): Promise<string> {
  const output = join(dir, `${name}.mp4`);
  const argv = edit(clipExportArgv({ input: source, output, mode: "duplicate", colour: { matrix: 1, fullRange: false, dynamicRange: "sdr" }, exportedAt: EXPORTED_AT }));
  await runFfmpegArgv({ argv, output, timeoutMs: 120_000 });
  return output;
}

/** `argv` without the flag `flag` and its value. */
const without = (flag: string) => (argv: string[]): string[] => {
  const at = argv.indexOf(flag);
  return at < 0 ? argv : [...argv.slice(0, at), ...argv.slice(at + 2)];
};

/** `argv` with `extra` inserted right before the output's `-f mp4`. */
const adding = (...extra: string[]) => (argv: string[]): string[] => [...argv.slice(0, -3), ...extra, ...argv.slice(-3)];

const codesOf = (verdict: ClipExportVerdict): string[] => verdict.reasons.map((reason) => reason.code);

/** Every byte of the file outside the top-level `mdat`, as Latin-1 text (an independent reading: a plain top-level walk). */
function outsideMdat(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (let at = 0; at + 8 <= bytes.length; ) {
    let size = view.getUint32(at);
    if (size === 1) size = Number(view.getBigUint64(at + 8));
    if (size === 0) size = bytes.length - at;
    const type = Buffer.from(bytes.subarray(at + 4, at + 8)).toString("latin1");
    if (type !== "mdat") text += Buffer.from(bytes.subarray(at, at + size)).toString("latin1");
    at += size;
  }
  return text;
}

/** The creation and modification times of every `mvhd`, `tkhd` and `mdhd`, in seconds since 1970 (an independent reading of the version-0 boxes ffmpeg writes). */
function headerTimes(bytes: Uint8Array): Array<{ type: string; created: number; modified: number }> {
  const text = Buffer.from(bytes).toString("latin1");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ type: string; created: number; modified: number }> = [];
  for (const type of ["mvhd", "tkhd", "mdhd"]) {
    for (let at = text.indexOf(type); at >= 0; at = text.indexOf(type, at + 4)) {
      if (at > text.indexOf("mdat")) break;
      const body = at + 4;
      expect(bytes[body]).toBe(0);
      out.push({ type, created: view.getUint32(body + 4) - 2_082_844_800, modified: view.getUint32(body + 8) - 2_082_844_800 });
    }
  }
  return out;
}

/** The packed language code of every `mdhd` (an independent reading of the version-0 boxes ffmpeg writes: it sits 20 bytes into the body). */
function mdhdLanguages(bytes: Uint8Array): number[] {
  const text = Buffer.from(bytes).toString("latin1");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let at = text.indexOf("mdhd"); at >= 0 && at < text.indexOf("mdat"); at = text.indexOf("mdhd", at + 4)) out.push(view.getUint16(at + 4 + 20));
  return out;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-clip-export-verify-"));
  source = join(dir, "seeded.mp4");
  await seededSource(source);
  clean = await exportWith("clean");
  cleanVerdict = await verifyClipExport(clean, { createdAt: EXPORTED_AT });
}, 120_000);

afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("the source really carries what the export must drop", () => {
  test("every seeded value is in the source's boxes (so the export's tests prove something)", async () => {
    const text = outsideMdat(new Uint8Array(await readFile(source))).toLowerCase();
    for (const value of SEEDED) expect(text.includes(value.toLowerCase())).toBe(true);
  });
});

describe("a clean export (the real argv)", () => {
  test("passes the clip export verifier", () => {
    expect(cleanVerdict.reasons).toEqual([]);
    expect(cleanVerdict.ok).toBe(true);
  });

  test("hands back the size and the sha256 of the bytes it judged", async () => {
    const bytes = await readFile(clean);
    expect(cleanVerdict.bytes).toBe(bytes.length);
    expect(cleanVerdict.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  test("its creation_time is the real export time in mvhd, tkhd and mdhd, never 0", async () => {
    const times = headerTimes(new Uint8Array(await readFile(clean)));
    expect(times.map((t) => t.type).sort()).toEqual(["mdhd", "mvhd", "tkhd"]);
    for (const time of times) {
      expect(time.created).toBe(EXPORTED_AT.getTime() / 1000);
      expect(time.modified).toBe(EXPORTED_AT.getTime() / 1000);
    }
  });

  test("none of the seeded values survives anywhere outside the coded pictures", async () => {
    const text = outsideMdat(new Uint8Array(await readFile(clean))).toLowerCase();
    for (const value of SEEDED) expect(text.includes(value.toLowerCase())).toBe(false);
  });

  test("no tool's name is left either: no Lavf, Lavc, x264 or handler name outside the coded pictures", async () => {
    const text = outsideMdat(new Uint8Array(await readFile(clean))).toLowerCase();
    for (const value of ["lavf", "lavc", "x264", "videohandler", "soundhandler", "©too", "©xyz", "keys", "mdta"]) expect(text.includes(value)).toBe(false);
  });

  test("has one track, the video: Grok's sound never reaches the export", async () => {
    const opened = await openFileSource(clean);
    try {
      const probe = await probeVideo(opened.source);
      if (!probe.ok) throw new Error(`the export did not probe: ${probe.reason}`);
      expect(probe.info.audioTracks).toBe(0);
      expect(probe.info.video.codec).toBe("h264");
      expect([probe.info.video.width, probe.info.video.height]).toEqual([1080, 1920]);
    } finally {
      await opened.close();
    }
  });
});

describe("what the verifier catches", () => {
  test("a creation_time that is not the export time (more than 2 s off) is refused", async () => {
    const verdict = await verifyClipExport(clean, { createdAt: new Date(EXPORTED_AT.getTime() + 3_000) });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("CREATION_TIME_WRONG");
  });

  test("a creation_time within 2 s of the export time passes", async () => {
    expect((await verifyClipExport(clean, { createdAt: new Date(EXPORTED_AT.getTime() + 1_500) })).ok).toBe(true);
  });

  test("the clean export's mdhd says «und» (the premise of the language pin)", async () => {
    expect(mdhdLanguages(new Uint8Array(await readFile(clean)))).toEqual([0x55c4]);
  });

  test("a source language carried into mdhd (fra) is refused", async () => {
    const french = await exportWith("language-fra", adding("-metadata:s:v:0", "language=fra"));
    expect(mdhdLanguages(new Uint8Array(await readFile(french)))).not.toEqual([0x55c4]);

    const verdict = await verifyClipExport(french, { createdAt: EXPORTED_AT });

    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("without -empty_hdlr_name 1 the video handler is named again, and the export is refused", async () => {
    const verdict = await verifyClipExport(await exportWith("named-handler", without("-empty_hdlr_name")), { createdAt: EXPORTED_AT });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("HANDLER_NAME_NOT_EMPTY");
  });

  test("with encoder=\"\" in place of one space ffmpeg-static 6.0 writes «Lavc libx264» as the compressor name, and the export is refused", async () => {
    const verdict = await verifyClipExport(await exportWith("empty-encoder", (argv) => argv.map((token) => (token === "encoder= " ? "encoder=" : token))), { createdAt: EXPORTED_AT });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("COMPRESSOR_NAME_NOT_BLANK");
    expect(codesOf(verdict)).toContain("FORBIDDEN_TEXT");
  });

  test("without the SEI filter x264's own SEI is in the coded pictures, and the NAL walk refuses it", async () => {
    const verdict = await verifyClipExport(await exportWith("with-sei", without("-bsf:v")), { createdAt: EXPORTED_AT });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("SEI_FOUND");
  });

  test("any tag beyond creation_time (a title naming the provider) is refused, as a tag and as forbidden text", async () => {
    const verdict = await verifyClipExport(await exportWith("titled", adding("-metadata", "title=Kling clip")), { createdAt: EXPORTED_AT });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("TAG_PRESENT");
    expect(codesOf(verdict)).toContain("FORBIDDEN_TEXT");
  });

  test("a sound track is refused: the export is one video track", async () => {
    const withSound = (argv: string[]): string[] => adding("-map", "0:a:0", "-c:a", "aac")(argv.filter((token) => token !== "-an"));
    const verdict = await verifyClipExport(await exportWith("with-sound", withSound), { createdAt: EXPORTED_AT });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("UNEXPECTED_TRACKS");
  });

  test("an index after the media data is refused (no faststart)", async () => {
    const verdict = await verifyClipExport(await exportWith("not-faststart", without("-movflags")), { createdAt: EXPORTED_AT });
    expect(verdict.ok).toBe(false);
    expect(codesOf(verdict)).toContain("NOT_FASTSTART");
  });

  test("a forbidden word INSIDE a coded picture is not a tag and does not refuse the file (short strings collide with mdat's bytes)", async () => {
    const bytes = new Uint8Array(await readFile(clean));
    const text = Buffer.from(bytes).toString("latin1");
    const mdat = text.indexOf("mdat");
    // Well inside the first slice's payload (past the length prefix and the NAL header): the NAL walk is unchanged.
    const at = mdat + 4 + 64;
    bytes.set(Buffer.from("GPS", "latin1"), at);
    const patched = join(dir, "gps-in-mdat.mp4");
    await writeFile(patched, bytes);
    expect((await verifyClipExport(patched, { createdAt: EXPORTED_AT })).ok).toBe(true);
  });

  test("its forbidden text holds the render's engine signatures, the providers and the device words, compared without letter case", () => {
    const lower = CLIP_EXPORT_FORBIDDEN_TEXT.map((word) => word.toLowerCase());
    for (const word of ["kling", "kwaivgi", "x-ai", "grok", "openrouter", "lavf", "lavc", "x264", "apple", "iphone", "gps", "©xyz", "videohandler", "videolan"]) expect(lower).toContain(word);
  });
});

describe("the render verifier (invariant 14) is untouched and still refuses this profile", () => {
  test("verifyAndHashMp4 refuses a clean clip export: a real creation time, an empty handler name, a blank compressor name", async () => {
    const opened = await openFileSource(clean);
    let frames: number;
    try {
      const probe = await probeVideo(opened.source);
      if (!probe.ok) throw new Error(`the export did not probe: ${probe.reason}`);
      frames = probe.info.video.samples;
    } finally {
      await opened.close();
    }
    const verified = await verifyAndHashMp4(clean, { frames });
    expect(verified.result.ok).toBe(false);
    const codes = verified.result.ok ? [] : verified.result.reasons.map((reason) => reason.code);
    expect(codes).toContain("NONZERO_TIMESTAMP");
    expect(codes).toContain("METADATA_VALUE_NOT_ALLOWED");
  });

  test("allowlist.ts and checks.ts are byte-equal to the render's (their line endings aside)", () => {
    const sha = (name: string): string => createHash("sha256").update(readFileSync(join(import.meta.dir, "..", "verify", name), "utf8").replace(/\r\n/g, "\n")).digest("hex");
    expect(sha("allowlist.ts")).toBe("99ab020d3c51e0555770b935703902a47a0e4d311b0faeccacf1c85f581e5eb5");
    expect(sha("checks.ts")).toBe("95ee1f53d0385361a777b8ad360202c9adb638d98ee1bcb80b05eabf1254a794");
  });
});

describe("no code path writes a device, a place or a camera (static)", () => {
  /** The engine's clip sources (not their tests or test kits). */
  const sources = (): Array<{ name: string; text: string }> =>
    readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
      .map((name) => ({ name, text: readFileSync(join(import.meta.dir, name), "utf8") }));

  test("every -metadata a clip source writes is creation_time or the blank encoder", () => {
    const writes = sources().flatMap(({ name, text }) => [...text.matchAll(/"-metadata(?::[^"]*)?",\s*(`[^`]*`|"[^"]*")/g)].map((match) => `${name}: ${match[1] ?? ""}`));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(/: (`creation_time=\$\{[^}]+\}`|"encoder= ")$/.test(write)).toBe(true);
  });

  test("no clip source spells a make, model, location, ©xyz or com.apple key", () => {
    for (const { name, text } of sources()) {
      for (const key of [/\bmake=/i, /\bmodel=/i, /\blocation=/i, /com\.apple/i]) expect(`${name}: ${key.test(text)}`).toBe(`${name}: false`);
      // The verifier's own list of what may never appear names ©xyz (as an escape); nothing else may.
      if (name !== "exportVerify.ts") expect(`${name}: ${/©xyz|\\u00a9xyz/.test(text)}`).toBe(`${name}: false`);
    }
  });
});
