import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { bytesSource, probeVideo, type ByteSource, type ProbeRefusal, type VideoInfo } from "./videoProbe";
import { box, buildMp4, concat, fullBox, largeBox, MATRIX, u32, type ColrSpec, type Mp4Spec, type TrackSpec, type VideoEntrySpec } from "./testing/mp4VideoBuilder";
useNativeGlobals();

// 3f.3a: Studio's own reading of an untrusted MP4 or MOV. Every fact that decides what the importer does (rotation, HDR, VFR, the codec,
// the size and the length) comes from the boxes, never from ffmpeg's text. These tests build the boxes by hand.

const probe = (bytes: Uint8Array) => probeVideo(bytesSource(bytes));

async function infoOf(spec: Mp4Spec): Promise<VideoInfo> {
  const result = await probe(buildMp4(spec));
  if (!result.ok) throw new Error(`expected the file to be read, it was refused: ${result.reason}`);
  return result.info;
}

async function refusalOf(spec: Mp4Spec | Uint8Array): Promise<ProbeRefusal> {
  const result = await probe(spec instanceof Uint8Array ? spec : buildMp4(spec));
  if (result.ok) throw new Error("expected the file to be refused");
  return result.reason;
}

const video = (over: Partial<TrackSpec> = {}): TrackSpec => ({ handler: "vide", ...over });
const entry = (over: Partial<VideoEntrySpec> = {}): VideoEntrySpec => ({ fourcc: "avc1", width: 1920, height: 1080, ...over });
const nclx = (primaries: number, transfer: number, matrix: number, fullRange = false): ColrSpec => ({ type: "nclx", primaries, transfer, matrix, fullRange });
const withVideo = (over: Partial<TrackSpec>): Mp4Spec => ({ tracks: [video(over)] });

describe("the codec comes from the sample entry", () => {
  test.each([
    ["avc1", "h264"],
    ["avc3", "h264"],
    ["hvc1", "hevc"],
    ["hev1", "hevc"],
    ["apcn", "prores"],
    ["apch", "prores"],
    ["apcs", "prores"],
    ["apco", "prores"],
    ["ap4h", "prores"],
  ] as const)("%s is %s", async (fourcc, codec) => {
    const info = await infoOf(withVideo({ entry: entry({ fourcc }) }));
    expect(info.video.fourcc).toBe(fourcc);
    expect(info.video.codec).toBe(codec);
  });

  test.each(["vp09", "av01", "mp4v", "mjp2", "dvh1", "dvhe", "encv", "avc2", "apcx"])("%s is refused as an unsupported codec", async (fourcc) => {
    expect(await refusalOf(withVideo({ entry: entry({ fourcc }) }))).toBe("unsupported-codec");
  });
});

describe("size and length", () => {
  test("the size is the sample entry's, and the tkhd says the same", async () => {
    const info = await infoOf(withVideo({ entry: entry({ width: 3840, height: 2160 }) }));
    expect([info.video.width, info.video.height]).toEqual([3840, 2160]);
  });

  test("a tkhd that disagrees with the sample entry is refused", async () => {
    expect(await refusalOf(withVideo({ tkhdWidth: 1280 }))).toBe("dimension-mismatch");
    expect(await refusalOf(withVideo({ tkhdHeight: 1079 }))).toBe("dimension-mismatch");
  });

  test("a zero side is refused", async () => {
    expect(await refusalOf(withVideo({ entry: entry({ width: 0 }), tkhdWidth: 0 }))).toBe("bad-header");
  });

  test("the length is the longer of mvhd's and the video track's own", async () => {
    const info = await infoOf({ mvhdTimescale: 600, mvhdDuration: 600 * 10, tracks: [video({ mdhdTimescale: 30000, stts: [[450, 1001]] })] });
    expect(info.durationMs).toBe(Math.round((450 * 1001 * 1000) / 30000));
  });

  test("mvhd's length counts when it is the longer (an audio track outlasting the picture)", async () => {
    const info = await infoOf({ mvhdTimescale: 1000, mvhdDuration: 20_000, tracks: [video({ stts: [[30, 1000]] })] });
    expect(info.durationMs).toBe(30_000);
    const longer = await infoOf({ mvhdTimescale: 1000, mvhdDuration: 40_000, tracks: [video({ stts: [[30, 1000]] })] });
    expect(longer.durationMs).toBe(40_000);
  });

  test("a version 1 mvhd, tkhd and mdhd (64-bit times) are read", async () => {
    const info = await infoOf({ mvhdVersion1: true, mvhdDuration: 12_000, tracks: [video({ version1: true, stts: [[360, 1000]] })] });
    expect(info.durationMs).toBe(360_000);
    expect(info.video.width).toBe(1920);
  });

  test("a 64-bit duration that does not fit a safe integer is refused", async () => {
    const bytes = buildMp4({ mvhdVersion1: true, mvhdDuration: 10 });
    // mvhd v1: ver/flags 4, creation 8, modification 8, timescale 4, duration 8: put 0xffffffff_ffffffff in the duration.
    const at = indexOfType(bytes, "mvhd") + 4 + 4 + 8 + 8 + 4;
    new DataView(bytes.buffer, bytes.byteOffset).setBigUint64(at, 0xffffffffffffffffn);
    expect(await refusalOf(bytes)).toBe("bad-header");
  });

  test("a zero timescale is refused", async () => {
    expect(await refusalOf({ mvhdTimescale: 0 })).toBe("bad-header");
    expect(await refusalOf(withVideo({ mdhdTimescale: 0 }))).toBe("bad-header");
  });
});

describe("rotation comes from the tkhd matrix", () => {
  test.each([
    ["r0", 0],
    ["r90", 90],
    ["r180", 180],
    ["r270", 270],
  ] as const)("%s is a clockwise turn of %i degrees to show it upright", async (name, degrees) => {
    expect((await infoOf(withVideo({ matrix: MATRIX[name] }))).video.rotation).toBe(degrees);
  });

  test("the translation words do not matter", async () => {
    const info = await infoOf(withVideo({ rawMatrix: [0, 0x10000, 0, 0xffff0000, 0, 0, 0x04380000, 0x07800000, 0x40000000] }));
    expect(info.video.rotation).toBe(90);
  });

  test.each([
    ["a mirror", [-1, 0, 0, 1]],
    ["a flip", [1, 0, 0, -1]],
    ["a transposed mirror", [0, 1, 1, 0]],
    ["a scale", [2, 0, 0, 2]],
    ["a shear", [1, 1, 0, 1]],
    ["a 45 degree turn", [0.7071, 0.7071, -0.7071, 0.7071]],
    ["a zero matrix", [0, 0, 0, 0]],
  ] as const)("%s is refused", async (_name, matrix) => {
    expect(await refusalOf(withVideo({ matrix }))).toBe("unsupported-matrix");
  });

  test("a projective matrix (u, v or w not the identity's) is refused", async () => {
    expect(await refusalOf(withVideo({ rawMatrix: [0x10000, 0, 1, 0, 0x10000, 0, 0, 0, 0x40000000] }))).toBe("unsupported-matrix");
    expect(await refusalOf(withVideo({ rawMatrix: [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x20000000] }))).toBe("unsupported-matrix");
  });
});

describe("the dynamic range comes from colr and the Dolby Vision box", () => {
  test("a clip with no colr is SDR, and says it had no tags", async () => {
    const info = await infoOf(withVideo({ entry: entry() }));
    expect(info.video.dynamicRange).toBe("sdr");
    expect(info.video.colour).toEqual({ tagged: false, primaries: 1, transfer: 1, matrix: 1, fullRange: false });
  });

  test("BT.709 nclx is SDR", async () => {
    const info = await infoOf(withVideo({ entry: entry({ colr: nclx(1, 1, 1) }) }));
    expect(info.video.dynamicRange).toBe("sdr");
    expect(info.video.colour.tagged).toBe(true);
  });

  test("transfer 16 is PQ and 18 is HLG", async () => {
    expect((await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 16, 9) }) }))).video.dynamicRange).toBe("pq");
    expect((await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9) }) }))).video.dynamicRange).toBe("hlg");
  });

  test("a QuickTime nclc (no full-range bit) is read like an nclx", async () => {
    const info = await infoOf(withVideo({ entry: entry({ fourcc: "apch", colr: { type: "nclc", primaries: 1, transfer: 1, matrix: 1 } }) }));
    expect(info.video.colour).toEqual({ tagged: true, primaries: 1, transfer: 1, matrix: 1, fullRange: false });
  });

  test("the full-range bit is read", async () => {
    expect((await infoOf(withVideo({ entry: entry({ colr: nclx(1, 1, 1, true) }) }))).video.colour.fullRange).toBe(true);
  });

  test("unspecified primaries and matrix are read as BT.709 for a picture of HD size, BT.601 below it", async () => {
    const hd = await infoOf(withVideo({ entry: entry({ colr: nclx(2, 2, 2) }) }));
    expect(hd.video.colour).toMatchObject({ primaries: 1, transfer: 1, matrix: 1 });
    const sd = await infoOf(withVideo({ entry: entry({ width: 640, height: 480, colr: nclx(2, 2, 2) }) }));
    expect(sd.video.colour).toMatchObject({ primaries: 6, transfer: 1, matrix: 6 });
  });

  test("an ICC profile colr beside an nclx is ignored, and the nclx is used", async () => {
    const icc = box("colr", concat(Uint8Array.from([0x70, 0x72, 0x6f, 0x66]), new Uint8Array(40)));
    const info = await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), extra: [icc] }) }));
    expect(info.video.dynamicRange).toBe("hlg");
  });

  test("two nclx boxes are refused (a demuxer may take the other one)", async () => {
    expect(await refusalOf(withVideo({ entry: entry({ colr: [nclx(1, 1, 1), nclx(9, 16, 9)] }) }))).toBe("unsupported-colour");
  });

  test.each([
    ["a linear transfer", nclx(1, 8, 1)],
    ["SMPTE 428", nclx(1, 17, 1)],
    ["an RGB matrix", nclx(1, 1, 0)],
    ["a constant-luminance matrix", nclx(9, 1, 10)],
    ["ICtCp", nclx(9, 16, 14)],
    ["an unknown primaries code", nclx(200, 1, 1)],
  ])("%s is refused", async (_name, colr) => {
    expect(await refusalOf(withVideo({ entry: entry({ fourcc: "hvc1", colr }) }))).toBe("unsupported-colour");
  });

  test("Dolby Vision 8.4 in an hvc1 entry is read as its HLG base", async () => {
    const info = await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby: { box: "dvcC", profile: 8, compatibilityId: 4 } }) }));
    expect(info.video.dynamicRange).toBe("hlg");
    expect(info.video.dolbyVision).toEqual({ profile: 8, compatibilityId: 4 });
  });

  test("the same box under the name dvvC (what profile 8 uses) is read the same", async () => {
    const info = await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby: { box: "dvvC", profile: 8, compatibilityId: 4 } }) }));
    expect(info.video.dolbyVision).toEqual({ profile: 8, compatibilityId: 4 });
  });

  test("Dolby Vision 8.4 with no colr takes its HLG tags from the compatibility id", async () => {
    const info = await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", dolby: { profile: 8, compatibilityId: 4 } }) }));
    expect(info.video.dynamicRange).toBe("hlg");
    expect(info.video.colour).toEqual({ tagged: true, primaries: 9, transfer: 18, matrix: 9, fullRange: false });
  });

  test("Dolby Vision 8.1 is read as its PQ base and 8.2 as its SDR base", async () => {
    expect((await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", dolby: { profile: 8, compatibilityId: 1 } }) }))).video.dynamicRange).toBe("pq");
    expect((await infoOf(withVideo({ entry: entry({ fourcc: "hvc1", dolby: { profile: 8, compatibilityId: 2 } }) }))).video.dynamicRange).toBe("sdr");
  });

  test.each([
    ["profile 5 (no usable base layer)", { profile: 5, compatibilityId: 0 }],
    ["profile 7 (two layers)", { profile: 7, compatibilityId: 6 }],
    ["profile 8 with an enhancement layer", { profile: 8, compatibilityId: 4, elPresent: true }],
    ["profile 8 with a base the reader does not know", { profile: 8, compatibilityId: 9 }],
  ])("Dolby Vision %s is refused", async (_name, dolby) => {
    expect(await refusalOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby }) }))).toBe("unsupported-codec");
  });

  test("Dolby Vision on an AVC entry is refused", async () => {
    expect(await refusalOf(withVideo({ entry: entry({ fourcc: "avc1", dolby: { profile: 8, compatibilityId: 4 } }) }))).toBe("unsupported-codec");
  });

  test("a colr that contradicts the Dolby Vision base is refused", async () => {
    expect(await refusalOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 16, 9), dolby: { profile: 8, compatibilityId: 4 } }) }))).toBe("unsupported-colour");
  });

  test("two Dolby Vision boxes are refused", async () => {
    const both = [
      { box: "dvcC", profile: 8, compatibilityId: 4 },
      { box: "dvvC", profile: 8, compatibilityId: 4 },
    ] as const;
    expect(await refusalOf(withVideo({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby: both }) }))).toBe("unsupported-codec");
  });
});

describe("variable frame rate comes from stts", () => {
  test("one run of equal deltas is constant", async () => {
    const info = await infoOf(withVideo({ mdhdTimescale: 600, stts: [[900, 20]] }));
    expect(info.video.variableFrameRate).toBe(false);
    expect(info.video.samples).toBe(900);
    expect(info.video.sourceFps).toBe(30);
  });

  test("29.97 fps is constant and is reported to three decimals", async () => {
    const info = await infoOf(withVideo({ mdhdTimescale: 30000, stts: [[300, 1001]] }));
    expect(info.video.variableFrameRate).toBe(false);
    expect(info.video.sourceFps).toBe(29.97);
  });

  test("millisecond rounding of a 30 fps clip (33, 33, 34) is constant", async () => {
    const info = await infoOf(withVideo({ mdhdTimescale: 1000, stts: [[100, 33], [50, 34], [100, 33]] }));
    expect(info.video.variableFrameRate).toBe(false);
  });

  test("the last sample's own length does not make a constant clip variable", async () => {
    const info = await infoOf(withVideo({ mdhdTimescale: 600, stts: [[899, 20], [1, 5]] }));
    expect(info.video.variableFrameRate).toBe(false);
  });

  test("a clip that mixes 30 and 10 fps is variable", async () => {
    const info = await infoOf(withVideo({ mdhdTimescale: 600, stts: [[100, 20], [30, 60], [100, 20]] }));
    expect(info.video.variableFrameRate).toBe(true);
    expect(info.video.sourceFps).toBeCloseTo(230 / ((100 * 20 + 30 * 60 + 100 * 20) / 600), 3);
  });

  test("two samples with the same timestamp make it variable", async () => {
    const info = await infoOf(withVideo({ mdhdTimescale: 600, stts: [[10, 20], [2, 0], [10, 20]] }));
    expect(info.video.variableFrameRate).toBe(true);
  });

  test("a video track with no stts is refused", async () => {
    expect(await refusalOf(withVideo({ noStts: true }))).toBe("bad-header");
  });

  test("no samples is refused", async () => {
    expect(await refusalOf(withVideo({ stts: [] }))).toBe("bad-header");
    expect(await refusalOf(withVideo({ stts: [[0, 1000]] }))).toBe("bad-header");
  });

  test("samples with no time between them are refused", async () => {
    expect(await refusalOf(withVideo({ stts: [[30, 0]] }))).toBe("bad-header");
  });

  test("a rate above 1000 fps is refused", async () => {
    expect(await refusalOf(withVideo({ mdhdTimescale: 1000, stts: [[3000, 0.5 as number]] }))).toBe("bad-header");
    expect(await refusalOf(withVideo({ mdhdTimescale: 90000, stts: [[3000, 1]] }))).toBe("bad-header");
  });

  test("an stts that declares more entries than it holds is refused", async () => {
    expect(await refusalOf(withVideo({ stts: [[30, 1000]], sttsDeclaredCount: 5000 }))).toBe("bad-box");
  });

  test("an stts that declares more entries than it holds is refused even when other boxes follow it (its table never runs into them)", async () => {
    const spec: Mp4Spec = { tracks: [video({ stts: [[30, 1000]], sttsDeclaredCount: 40 }), { handler: "soun" }, { handler: "soun" }] };
    expect(await refusalOf(spec)).toBe("bad-box");
  });

  test("a run whose ticks do not fit a safe integer is refused", async () => {
    expect(await refusalOf(withVideo({ stts: [[0xffffffff, 0xffffffff]] }))).toBe("bad-header");
  });

  test("a huge sample count is read as a length, not iterated", async () => {
    // 4e9 samples at 1 tick of a 1000 timescale: an absurd length, which the importer's limit refuses; the walker only reports it.
    const info = await infoOf(withVideo({ mdhdTimescale: 1_000_000, stts: [[0xffffffff, 1000]] }));
    expect(info.video.samples).toBe(0xffffffff);
    expect(info.durationMs).toBeGreaterThan(4_000_000_000);
  });
});

describe("tracks", () => {
  test("an audio track beside the picture is counted and otherwise ignored", async () => {
    const info = await infoOf({ tracks: [video(), { handler: "soun" }] });
    expect(info.audioTracks).toBe(1);
    expect(info.video.codec).toBe("h264");
  });

  test("a timed-metadata track (what an iPhone writes) is ignored", async () => {
    const info = await infoOf({ tracks: [{ handler: "meta" }, video(), { handler: "soun" }, { handler: "meta" }] });
    expect(info.video.width).toBe(1920);
  });

  test("two video tracks are refused: ffmpeg drops a track it cannot use, so which one it would map is not the walker's to say", async () => {
    expect(await refusalOf({ tracks: [video(), video({ entry: entry({ width: 640, height: 480 }) })] })).toBe("several-video-tracks");
    expect(await refusalOf({ tracks: [{ handler: "soun" }, video(), { handler: "meta" }, video()] })).toBe("several-video-tracks");
  });

  test("a file with no video track is refused", async () => {
    expect(await refusalOf({ tracks: [{ handler: "soun" }] })).toBe("no-video-track");
  });

  test("a file with no track at all is refused", async () => {
    expect(await refusalOf({ tracks: [] })).toBe("no-video-track");
  });

  test("more than sixteen tracks are refused", async () => {
    expect(await refusalOf({ tracks: Array.from({ length: 17 }, () => ({ handler: "meta" })) })).toBe("too-many-tracks");
    expect((await probe(buildMp4({ tracks: [video(), ...Array.from({ length: 15 }, () => ({ handler: "meta" }))] }))).ok).toBe(true);
  });

  test("a video track with no tkhd is refused", async () => {
    expect(await refusalOf(withVideo({ noTkhd: true }))).toBe("bad-header");
  });

  test("two sample entries in the video track are refused (the codec could change mid-stream)", async () => {
    expect(await refusalOf(withVideo({ entries: 2 }))).toBe("several-sample-entries");
  });

  test("a pixel aspect ratio that is not 1:1 is refused, and 1:1 is fine", async () => {
    expect(await refusalOf(withVideo({ entry: entry({ pasp: [4, 3] }) }))).toBe("non-square-pixels");
    expect((await infoOf(withVideo({ entry: entry({ pasp: [1, 1] }) }))).video.width).toBe(1920);
    expect((await infoOf(withVideo({ entry: entry({ pasp: [2, 2] }) }))).video.width).toBe(1920);
  });

  test("an external data reference is refused, on any track", async () => {
    expect(await refusalOf(withVideo({ drefFlags: [0] }))).toBe("external-data-reference");
    expect(await refusalOf({ tracks: [video(), { handler: "soun", drefFlags: [1, 0] }] })).toBe("external-data-reference");
  });
});

describe("the top level", () => {
  test("moov before mdat is read", async () => {
    expect((await infoOf({ layout: "moov-first" })).video.width).toBe(1920);
  });

  test("moov after mdat (a file never made streamable) is read", async () => {
    expect((await infoOf({ layout: "moov-last", mdat: new Uint8Array(4096) })).video.width).toBe(1920);
  });

  test("a file with no moov is refused", async () => {
    expect(await refusalOf({ layout: "no-moov" })).toBe("no-moov");
  });

  test("two moov boxes are refused", async () => {
    expect(await refusalOf({ layout: "two-moov" })).toBe("several-moov");
  });

  test("a file with no ftyp first is refused", async () => {
    expect(await refusalOf({ noFtyp: true })).toBe("no-ftyp");
  });

  test.each(["moof", "sidx", "mfra"])("a fragmented file (%s at the top level) is refused", async (type) => {
    expect(await refusalOf({ topExtra: [box(type, new Uint8Array(8))] })).toBe("fragmented");
  });

  test("mvex inside moov (a fragmented file) is refused", async () => {
    expect(await refusalOf({ moovExtra: [box("mvex", new Uint8Array(0))] })).toBe("fragmented");
  });

  test("unknown top-level boxes (free, uuid, wide) are skipped, not read", async () => {
    const info = await infoOf({ topExtra: [box("free", new Uint8Array(100)), box("uuid", new Uint8Array(64)), box("wide")] });
    expect(info.video.width).toBe(1920);
  });

  test("a moov over the cap is refused without being read", async () => {
    const reads: number[] = [];
    const ftyp = buildMp4({}).subarray(0, 24);
    const head = concat(ftyp, u32(32 * 1024 * 1024), Uint8Array.from([0x6d, 0x6f, 0x6f, 0x76]));
    const size = 64 * 1024 * 1024;
    const result = await probeVideo({
      size,
      read: async (position, length) => {
        reads.push(length);
        const out = new Uint8Array(length);
        if (position < head.length) out.set(head.subarray(position, position + length));
        return out;
      },
    });
    expect(result).toEqual({ ok: false, reason: "moov-too-large" });
    expect(Math.max(...reads)).toBeLessThanOrEqual(16);
  });

  test("a file of 2 GiB (by its mdat's header) is walked without reading it", async () => {
    const head = buildMp4({ layout: "moov-first" });
    const moovEnd = head.byteLength - 24; // everything before the 16-byte mdat box the builder wrote (8-byte header and 16 bytes of data)
    const prefix = head.subarray(0, moovEnd);
    const size = 2 * 1024 * 1024 * 1024;
    const mdatHeader = concat(u32(1), Uint8Array.from([0x6d, 0x64, 0x61, 0x74]), bigEndian64(BigInt(size - prefix.byteLength)));
    const bytes = concat(prefix, mdatHeader);
    let read = 0;
    const source: ByteSource = {
      size,
      read: async (position, length) => {
        read += length;
        if (position >= bytes.byteLength) return new Uint8Array(length);
        return bytes.subarray(position, position + length);
      },
    };
    const result = await probeVideo(source);
    expect(result.ok).toBe(true);
    expect(read).toBeLessThan(prefix.byteLength + 1024);
  });

  test("a file whose last box runs past the end is refused as truncated", async () => {
    const bytes = buildMp4({ layout: "moov-last", mdat: new Uint8Array(4096) });
    expect(await refusalOf(bytes.subarray(0, bytes.byteLength - 10))).toBe("bad-box");
  });

  test("a file with a few stray bytes after its last box is refused", async () => {
    expect(await refusalOf(concat(buildMp4({}), new Uint8Array(5)))).toBe("bad-box");
  });

  test("a top-level box of size 0 runs to the end of the file", async () => {
    const bytes = buildMp4({ layout: "moov-first" });
    // Turn the final mdat's size into 0: it then covers the rest (its own 16 bytes), the same file.
    const at = bytes.byteLength - 24;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, 0);
    expect((await probe(bytes)).ok).toBe(true);
  });

  test("a box of size 0 inside moov is refused", async () => {
    const bytes = buildMp4({ moovExtra: [box("free", new Uint8Array(8))] });
    // The moov's last child is that free box: its size field is 16 bytes from the end of moov; zero it.
    const at = indexOfType(bytes, "free") - 4;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, 0);
    expect(await refusalOf(bytes)).toBe("bad-box");
  });

  test("a box of size 1..7 is refused, at the top level and inside", async () => {
    for (const size of [1, 2, 7]) {
      const top = concat(buildMp4({}), box("free", new Uint8Array(0), size));
      expect(await refusalOf(top)).toBe("bad-box");
      expect(await refusalOf({ moovExtra: [box("free", new Uint8Array(0), size)] })).toBe("bad-box");
    }
  });

  test("a 64-bit size smaller than its own header, or past the parent, is refused", async () => {
    expect(await refusalOf(concat(buildMp4({}), largeBox("free", new Uint8Array(0), 15n)))).toBe("bad-box");
    expect(await refusalOf(concat(buildMp4({}), largeBox("free", new Uint8Array(0), 1n << 40n)))).toBe("bad-box");
    expect(await refusalOf(concat(buildMp4({}), largeBox("free", new Uint8Array(0), 0xffffffffffffffffn)))).toBe("bad-box");
    expect(await refusalOf({ moovExtra: [largeBox("free", new Uint8Array(0), 1n << 33n)] })).toBe("bad-box");
  });

  test("a 64-bit size that is honest is read (a big mdat, a large box inside moov)", async () => {
    expect((await infoOf({ topExtra: [largeBox("free", new Uint8Array(8), 24n)] })).video.width).toBe(1920);
    expect((await infoOf({ moovExtra: [largeBox("free", new Uint8Array(8), 24n)] })).video.width).toBe(1920);
  });

  test("a child that runs past its parent is refused (an overlap with whatever follows)", async () => {
    const bytes = buildMp4({ moovExtra: [box("free", new Uint8Array(8))] });
    const at = indexOfType(bytes, "free") - 4;
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(at, 5000);
    expect(await refusalOf(bytes)).toBe("bad-box");
  });

  test("a moov that holds a moov of its own does not loop: nested boxes are read by a fixed schema, never by their claim", async () => {
    const inner = box("moov", concat(box("moov", concat(box("moov", new Uint8Array(0))))));
    const info = await infoOf({ moovExtra: [inner] });
    expect(info.video.width).toBe(1920);
  });

  test("a trak that contains a trak is not descended into", async () => {
    const info = await infoOf({ tracks: [video({ trakExtra: [box("trak", box("trak", new Uint8Array(0)))] })] });
    expect(info.video.width).toBe(1920);
  });

  test("tens of thousands of tiny boxes are refused by the visit budget", async () => {
    const many = Array.from({ length: 20_000 }, () => box("free", new Uint8Array(0)));
    expect(await refusalOf({ moovExtra: many })).toBe("too-many-boxes");
    expect(await refusalOf({ topExtra: Array.from({ length: 5_000 }, () => box("free", new Uint8Array(0))) })).toBe("too-many-boxes");
  });

  test("an stsd entry that has no room for the visual fields is refused", async () => {
    const short = fullBox("stsd", 0, concat(u32(1), box("avc1", new Uint8Array(40))));
    const bytes = buildMp4({});
    expect(await refusalOf(replaceBox(bytes, "stsd", short))).toBe("bad-box");
  });

  test("an entry count that is larger than the box holds is refused", async () => {
    const bytes = buildMp4({});
    const stsdAt = indexOfType(bytes, "stsd");
    new DataView(bytes.buffer, bytes.byteOffset).setUint32(stsdAt + 4 + 4, 100);
    expect(await refusalOf(bytes)).toBe("several-sample-entries");
  });
});

describe("what a reader may be asked for", () => {
  test("a source that returns fewer bytes than asked is a truncated file, not an exception", async () => {
    const bytes = buildMp4({});
    const source: ByteSource = { size: bytes.byteLength, read: async (position, length) => bytes.subarray(position, position + Math.max(0, length - 1)) };
    expect(await probeVideo(source)).toEqual({ ok: false, reason: "bad-box" });
  });

  test("a source that throws is not swallowed", async () => {
    const source: ByteSource = {
      size: 1000,
      read: async () => {
        throw new Error("disk gone");
      },
    };
    await expect(probeVideo(source)).rejects.toThrow("disk gone");
  });

  test("an empty file and a file shorter than a box header are refused", async () => {
    expect(await refusalOf(new Uint8Array(0))).toBe("no-ftyp");
    expect(await refusalOf(new Uint8Array(7))).toBe("no-ftyp");
  });
});

describe("fuzz: no input makes the walker throw, hang or read without bound", () => {
  // A small deterministic generator: the same inputs on every run and every platform.
  function prng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
  }

  const seeds: Record<string, Uint8Array> = {
    sdr: buildMp4({ tracks: [video({ stts: [[100, 20], [30, 60]] }), { handler: "soun" }] }),
    hdr: buildMp4({ layout: "moov-last", tracks: [video({ entry: entry({ fourcc: "hvc1", colr: nclx(9, 18, 9), dolby: { profile: 8, compatibilityId: 4 } }), matrix: MATRIX.r90 })] }),
    v1: buildMp4({ mvhdVersion1: true, tracks: [video({ version1: true })] }),
  };

  async function mustSettle(bytes: Uint8Array): Promise<void> {
    let bytesRead = 0;
    const source: ByteSource = {
      size: bytes.byteLength,
      read: async (position, length) => {
        bytesRead += length;
        return bytes.subarray(position, position + length);
      },
    };
    const result = await probeVideo(source);
    expect(typeof result.ok).toBe("boolean");
    // Whatever the file claims, the walker reads headers and one moov under its cap; never more than twice the file plus a header per box.
    expect(bytesRead).toBeLessThanOrEqual(bytes.byteLength * 2 + 64 * 1024);
  }

  test.each(Object.keys(seeds))("every prefix of the %s file is settled", async (name) => {
    const bytes = seeds[name];
    if (bytes === undefined) throw new Error("no seed");
    for (let length = 0; length <= bytes.byteLength; length++) await mustSettle(bytes.subarray(0, length));
  });

  test.each(Object.keys(seeds))("a thousand random byte flips of the %s file are settled", async (name) => {
    const bytes = seeds[name];
    if (bytes === undefined) throw new Error("no seed");
    const next = prng(name.length * 7919);
    for (let i = 0; i < 1000; i++) {
      const copy = Uint8Array.from(bytes);
      const flips = 1 + Math.floor(next() * 4);
      for (let f = 0; f < flips; f++) copy[Math.floor(next() * copy.byteLength)] = Math.floor(next() * 256);
      await mustSettle(copy);
    }
  });

  test("a thousand files made of random box headers are settled", async () => {
    const next = prng(42);
    const types = ["moov", "trak", "mdia", "minf", "stbl", "stsd", "stts", "mvhd", "tkhd", "ftyp", "mdat", "free", "hvc1", "colr"];
    for (let i = 0; i < 1000; i++) {
      const parts: Uint8Array[] = [box("ftyp", Uint8Array.from([0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0]))];
      const count = 1 + Math.floor(next() * 12);
      for (let b = 0; b < count; b++) {
        const type = types[Math.floor(next() * types.length)] ?? "free";
        const payload = Uint8Array.from({ length: Math.floor(next() * 64) }, () => Math.floor(next() * 256));
        const lie = next() < 0.3 ? Math.floor(next() * 2 ** 32) : undefined;
        parts.push(box(type, payload, lie));
      }
      await mustSettle(concat(...parts));
    }
  });

  test("random garbage is settled", async () => {
    const next = prng(7);
    for (let i = 0; i < 300; i++) await mustSettle(Uint8Array.from({ length: Math.floor(next() * 600) }, () => Math.floor(next() * 256)));
  });
});

// ---------- helpers ----------

function bigEndian64(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value);
  return out;
}

/** The offset of the four-character type `type` in `bytes` (its box starts four bytes earlier). */
function indexOfType(bytes: Uint8Array, type: string): number {
  const needle = [...type].map((c) => c.charCodeAt(0));
  for (let i = 0; i + 4 <= bytes.byteLength; i++) if (needle.every((byte, k) => bytes[i + k] === byte)) return i;
  throw new Error(`no ${type} in the file`);
}

/** The file with the (first) box of `type` replaced by `replacement`; the parents' sizes are fixed up for the ancestors the builder makes. */
function replaceBox(bytes: Uint8Array, type: string, replacement: Uint8Array): Uint8Array {
  const at = indexOfType(bytes, type) - 4;
  const oldSize = new DataView(bytes.buffer, bytes.byteOffset).getUint32(at);
  const out = concat(bytes.subarray(0, at), replacement, bytes.subarray(at + oldSize));
  const delta = replacement.byteLength - oldSize;
  const view = new DataView(out.buffer, out.byteOffset);
  for (const ancestor of ["moov", "trak", "mdia", "minf", "stbl"]) {
    const ancestorAt = indexOfType(out, ancestor) - 4;
    view.setUint32(ancestorAt, view.getUint32(ancestorAt) + delta);
  }
  return out;
}
