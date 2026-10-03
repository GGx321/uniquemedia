import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { musicTracks } from "./fixtures";
import { probeMp4Audio } from "./mp4aProbe";
import { box, buildM4a, concat, fullBox, largeBox, u32 } from "./testing/m4aBuilder";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Invariant 31, acceptance: a track is accepted only after a bounded box walker reads an `mp4a` audio stream (HE-AAC
// `mp4a.40.5` and AAC-LC both). The walker never believes a size: each is checked against what its parent holds.

const bytesOf = (file: string): Uint8Array => new Uint8Array(readFileSync(file));

function refusalOf(bytes: Uint8Array): string {
  const probe = probeMp4Audio(bytes);
  return probe.ok ? "accepted" : probe.reason;
}

function patch(bytes: Uint8Array, from: string, to: string): Uint8Array {
  const copy = Uint8Array.from(bytes);
  const needle = Buffer.from(from, "latin1");
  const at = Buffer.from(copy).indexOf(needle);
  if (at < 0) throw new Error(`${from} is not in the file`);
  copy.set(Buffer.from(to, "latin1"), at);
  return copy;
}

describe("the real HE-AAC excerpts", () => {
  test.each(Object.entries(musicTracks))("%s is read as an mp4a stereo stream at its own sample rate and length", (_name, fixture) => {
    const probe = probeMp4Audio(bytesOf(fixture.file));
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.info.codec).toBe("mp4a");
    expect(probe.info.channels).toBe(2);
    expect(probe.info.sampleRate).toBe(fixture.sampleRate);
    expect(Math.abs((probe.info.durationMs ?? 0) - fixture.durationMs)).toBeLessThanOrEqual(100);
  });

  test("reports HE-AAC as an SBR object type, so 3c.5 can tell it from AAC-LC", () => {
    const probe = probeMp4Audio(bytesOf(musicTracks.hot.file));
    expect(probe.ok && [2, 5, 29]).toContain(probe.ok ? probe.info.audioObjectType : -1);
  });
});

describe("a synthetic file the walker must accept", () => {
  test("AAC-LC stereo", () => {
    const probe = probeMp4Audio(buildM4a());
    expect(probe.ok && probe.info).toMatchObject({ codec: "mp4a", audioObjectType: 2, channels: 2, sampleRate: 44100, durationMs: 8000 });
  });

  test("HE-AAC (SBR) at 48 kHz", () => {
    const probe = probeMp4Audio(buildM4a({ aot: 5, sampleRate: 48000, timescale: 48000, duration: 48000 * 3 }));
    expect(probe.ok && probe.info).toMatchObject({ audioObjectType: 5, sampleRate: 48000, durationMs: 3000 });
  });

  test("HE-AACv2 (PS)", () => {
    expect(probeMp4Audio(buildM4a({ aot: 29 })).ok).toBe(true);
  });

  test("mono", () => {
    expect(probeMp4Audio(buildM4a({ channels: 1 })).ok).toBe(true);
  });
});

describe("what is not an MP4 at all", () => {
  test.each([
    ["nothing", new Uint8Array(0)],
    ["seven bytes", new Uint8Array(7)],
    ["a PNG", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])],
    ["text", new TextEncoder().encode("<html>not audio</html>")],
    ["an MP3 with an ID3 tag", new TextEncoder().encode("ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000")],
    ["a zero-filled megabyte", new Uint8Array(1 << 20)],
  ])("%s", (_label, bytes) => {
    expect(probeMp4Audio(bytes).ok).toBe(false);
  });

  test("a file whose first box is not ftyp", () => {
    expect(refusalOf(concat(box("free", new Uint8Array(8)), buildM4a()))).toBe("no-ftyp");
  });

  test("a file with no ftyp at all", () => {
    expect(refusalOf(buildM4a({ noFtyp: true }))).toBe("no-ftyp");
  });

  test("an ftyp alone", () => {
    expect(refusalOf(box("ftyp", new TextEncoder().encode("isom\u0000\u0000\u0002\u0000isom")))).toBe("no-moov");
  });
});

describe("a stream that is not AAC in an audio track", () => {
  test("a sample entry that is not mp4a (ALAC)", () => {
    expect(refusalOf(buildM4a({ entry: "alac" }))).toBe("not-mp4a");
  });

  test("a sample entry of the fixture patched to another codec", () => {
    expect(refusalOf(patch(bytesOf(musicTracks.hot.file), "mp4a", "ac-3"))).toBe("not-mp4a");
  });

  test("a video track", () => {
    expect(refusalOf(buildM4a({ handler: "vide" }))).toBe("no-audio-track");
  });

  test("a fixture patched into a video track", () => {
    expect(refusalOf(patch(bytesOf(musicTracks.hot.file), "soun", "vide"))).toBe("no-audio-track");
  });

  test("an audio track with a video track beside it", () => {
    expect(refusalOf(buildM4a({ extraTracks: ["vide"] }))).toBe("several-tracks");
  });

  test("two audio tracks", () => {
    expect(refusalOf(buildM4a({ extraTracks: ["soun"] }))).toBe("several-tracks");
  });

  test("an mp4a entry with no esds (nothing says what it is)", () => {
    expect(refusalOf(buildM4a({ noEsds: true }))).toBe("esds-unreadable");
  });

  test("an mp4a entry that carries MP3 (objectTypeIndication 0x6b)", () => {
    expect(refusalOf(buildM4a({ oti: 0x6b }))).toBe("not-aac");
  });

  test.each([1, 3, 4, 22])("an AAC object type %i that Studio does not use", (aot) => {
    expect(refusalOf(buildM4a({ aot }))).toBe("unsupported-profile");
  });

  test("six channels", () => {
    expect(refusalOf(buildM4a({ channels: 6 }))).toBe("unsupported-format");
  });

  test.each([1000, 200000])("a sample rate of %i Hz", (sampleRate) => {
    expect(refusalOf(buildM4a({ sampleRate }))).toBe("unsupported-format");
  });
});

// Review 3c.4 F1: the walker used to refuse only handler `vide`. What decodes must be exactly what was walked, so the
// file is ONE track and its handler is `soun`: a video hidden behind another handler name, or a second track that
// `-map 0:a:0` would pick instead of the checked one, never passes.
describe("exactly one track, and it is sound", () => {
  test.each(["pict", "auxv", "xyzw", "meta", "text", "vide", "\u0000\u0000\u0000\u0000"])("a lone track with the handler %j is refused", (handler) => {
    expect(probeMp4Audio(buildM4a({ handler })).ok).toBe(false);
  });

  test.each(["pict", "auxv", "xyzw", "soun", "vide"])("a sound track with a second track (%j) beside it is refused: the decode would pick by position, not by what was checked", (other) => {
    expect(refusalOf(buildM4a({ extraTracks: [other] }))).toBe("several-tracks");
  });

  test("the same when the unchecked track comes first", () => {
    const one = buildM4a({ handler: "xyzw", extraTracks: ["soun"] });
    expect(probeMp4Audio(one).ok).toBe(false);
  });

  test("the four real HE-AAC files are one sound track each", () => {
    for (const fixture of Object.values(musicTracks)) expect(probeMp4Audio(bytesOf(fixture.file)).ok).toBe(true);
  });
});

// Review 3c.4 F2: `moov/cmov` is a compressed moov that ffmpeg inflates (a 1.1 MB file claiming 1 GiB cost 1.09 GB of
// memory, and a video track can hide inside it). Boxes are an allowlist at the two levels a file can add them.
describe("only the boxes an audio file has", () => {
  const refused = (bytes: Uint8Array): string => refusalOf(bytes);

  test.each(["cmov", "mvex", "meta", "uuid", "pssh", "trax"])("a %j inside moov is refused", (type) => {
    expect(refused(buildM4a({ moovExtra: [box(type, new Uint8Array(8))] }))).toBe("box-not-allowed");
  });

  test.each(["mvhd", "free", "skip", "iods"])("a %j inside moov is allowed", (type) => {
    expect(probeMp4Audio(buildM4a({ moovExtra: [box(type, new Uint8Array(8))] })).ok).toBe(true);
  });

  test.each(["moof", "mfra", "sidx", "meta", "uuid", "styp", "emsg", "pdin", "cmov"])("a top-level %j is refused", (type) => {
    expect(refused(buildM4a({ topExtra: [box(type, new Uint8Array(8))] }))).toBe("box-not-allowed");
  });

  test.each(["free", "skip", "wide"])("a top-level %j is allowed", (type) => {
    expect(probeMp4Audio(buildM4a({ topExtra: [box(type, new Uint8Array(8))] })).ok).toBe(true);
  });

  test("a compressed moov (a cmov that holds the real one) is refused as a whole, whatever it claims to hold", () => {
    const bomb = concat(box("ftyp", new Uint8Array(8)), box("moov", box("cmov", concat(box("dcom", new TextEncoder().encode("zlib")), box("cmvd", new Uint8Array(64))))));
    expect(refused(bomb)).toBe("box-not-allowed");
  });
});

// 3c.4 re-review: `udta/meta/ilst/covr` makes ffmpeg see a second stream (an attached picture), and a box repeated inside
// its parent is read by the walker once and by another demuxer perhaps otherwise. Neither depends on ffmpeg's version.
describe("tags with pictures, and repeated boxes", () => {
  const tags = (...items: Uint8Array[]): Uint8Array => box("udta", box("meta", concat(u32(0), box("ilst", concat(...items)))));

  test("cover art (udta/meta/ilst/covr) is refused: ffmpeg would show it as a second stream", () => {
    expect(refusalOf(buildM4a({ moovExtra: [tags(box("covr", box("data", new Uint8Array(16))))] }))).toBe("box-not-allowed");
  });

  test("cover art among other tags is refused too", () => {
    expect(refusalOf(buildM4a({ moovExtra: [tags(box("©too", box("data", new Uint8Array(16))), box("covr", box("data", new Uint8Array(16))))] }))).toBe("box-not-allowed");
  });

  // Round 3: cover art hides wherever ffmpeg looks for tags, not only under moov/udta/meta/ilst.
  const covr = box("covr", box("data", new Uint8Array(16)));
  const meta = (prefix = true): Uint8Array => box("meta", concat(prefix ? u32(0) : new Uint8Array(0), box("ilst", covr)));

  test.each([
    ["trak/udta/meta/ilst", { trakExtra: [box("udta", meta())] }],
    ["trak/meta/ilst", { trakExtra: [meta()] }],
    ["mdia/udta/meta/ilst", { mdiaExtra: [box("udta", meta())] }],
    ["moov/udta/udta/meta/ilst", { moovExtra: [box("udta", box("udta", meta()))] }],
    ["moov/udta/meta with no version field (QuickTime style)", { moovExtra: [box("udta", meta(false))] }],
    ["moov/meta/ilst", { moovExtra: [meta()] }],
    ["a meta whose only visible child is a free that holds the picture", { moovExtra: [box("udta", box("meta", concat(u32(0), box("free", concat(box("hdlr", new Uint8Array(24)), box("ilst", covr))))))] }],
  ])("cover art under %s is refused", (_label, options) => {
    expect(probeMp4Audio(buildM4a(options)).ok).toBe(false);
  });

  // Round 4: deeper still. ffmpeg shows an attached picture wherever a tag holder sits, so the guarantee is "no covr
  // anywhere in moov", not a list of places.
  const ilstBare = box("ilst", covr);
  test.each([
    ["minf/udta/meta/ilst", { minfExtra: [box("udta", meta())] }],
    ["stbl/udta/meta/ilst", { stblExtra: [box("udta", meta())] }],
    ["minf/meta/ilst", { minfExtra: [meta()] }],
    ["a bare ilst directly under trak", { trakExtra: [ilstBare] }],
    ["a bare ilst under minf", { minfExtra: [ilstBare] }],
    ["dinf/udta/meta/ilst", { dinfExtra: [box("udta", meta())] }],
  ])("cover art under %s is refused", (_label, options) => {
    expect(probeMp4Audio(buildM4a(options)).ok).toBe(false);
  });

  test("cover art in any other box of moov is refused too: the type bytes alone are enough", () => {
    expect(refusalOf(buildM4a({ moovExtra: [box("free", box("covr", new Uint8Array(8)))] }))).toBe("box-not-allowed");
  });

  test("the encoder tag a re-cut file carries (the 3c.1 fixtures have it) is allowed", () => {
    expect(probeMp4Audio(buildM4a({ moovExtra: [tags(box("©too", box("data", new Uint8Array(16))))] })).ok).toBe(true);
  });

  test("a udta of plain boxes is allowed, and a meta too short to read is a bad box", () => {
    expect(probeMp4Audio(buildM4a({ moovExtra: [box("udta", box("free", new Uint8Array(8)))] })).ok).toBe(true);
    expect(refusalOf(buildM4a({ moovExtra: [box("udta", box("meta", new Uint8Array(2)))] }))).toBe("bad-box");
  });

  test.each(["mdia", "hdlr", "mdhd", "minf", "dinf", "dref", "stbl", "stsd", "esds"])("a %s repeated inside its parent is refused", (type) => {
    expect(probeMp4Audio(buildM4a({ dupBox: type })).ok).toBe(false);
  });

  test("the real files have none of these: every cached CDN excerpt still walks", () => {
    for (const fixture of Object.values(musicTracks)) expect(probeMp4Audio(bytesOf(fixture.file)).ok).toBe(true);
  });
});

describe("a file that points outside itself", () => {
  test("a data reference that is not self-contained (ffmpeg would open it as a second file or URL)", () => {
    expect(refusalOf(buildM4a({ drefFlags: [0] }))).toBe("external-data-reference");
  });

  test("one self-contained reference and one external one", () => {
    expect(refusalOf(buildM4a({ drefFlags: [1, 0] }))).toBe("external-data-reference");
  });
});

describe("sizes are never believed", () => {
  test("a box larger than the file", () => {
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), box("moov", new Uint8Array(8), 1_000_000)))).toBe("bad-box");
  });

  test("a box smaller than its own header", () => {
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), box("moov", new Uint8Array(8), 4)))).toBe("bad-box");
  });

  test("a 64-bit size beyond the file (compared as a BigInt, never truncated)", () => {
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), largeBox("moov", new Uint8Array(8), 2n ** 40n)))).toBe("bad-box");
  });

  test("a 64-bit size of 2^64 - 1", () => {
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), largeBox("moov", new Uint8Array(8), 2n ** 64n - 1n)))).toBe("bad-box");
  });

  test("a 64-bit size smaller than its own header", () => {
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), largeBox("moov", new Uint8Array(8), 4n)))).toBe("bad-box");
  });

  test("a child that claims more than its parent holds", () => {
    const good = buildM4a();
    const moovAt = Buffer.from(good).indexOf(Buffer.from("moov", "latin1")) - 4;
    const trakAt = Buffer.from(good).indexOf(Buffer.from("trak", "latin1")) - 4;
    expect(trakAt).toBeGreaterThan(moovAt);
    const lie = Uint8Array.from(good);
    new DataView(lie.buffer).setUint32(trakAt, 0x00ffffff);
    expect(refusalOf(lie)).toBe("bad-box");
  });

  test("a file cut in the middle of moov", () => {
    const good = buildM4a();
    const cut = good.subarray(0, Buffer.from(good).indexOf(Buffer.from("stsd", "latin1")) + 6);
    expect(probeMp4Audio(cut).ok).toBe(false);
  });

  test("a top-level box of size 0 (to the end of the file) is read to the end and never past it", () => {
    const withZero = concat(box("ftyp", new TextEncoder().encode("isom\u0000\u0000\u0002\u0000isom")), u32(0), new TextEncoder().encode("mdat"), new Uint8Array(32));
    expect(refusalOf(withZero)).toBe("no-moov");
  });
});

describe("the walk is bounded whatever the file says", () => {
  test("ten thousand top-level boxes", () => {
    const many = concat(...Array.from({ length: 10_000 }, () => box("free")));
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), many, buildM4a({ noFtyp: true })))).toBe("too-many-boxes");
  });

  test("ten thousand boxes inside moov", () => {
    const many = concat(...Array.from({ length: 10_000 }, () => box("free")));
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), box("moov", many)))).toBe("too-many-boxes");
  });

  test("a moov of a hundred tracks", () => {
    const tracks = concat(...Array.from({ length: 100 }, () => box("trak")));
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), box("moov", tracks)))).toBe("too-many-tracks");
  });

  test("a second moov", () => {
    const one = buildM4a();
    const second = box("moov", box("trak"));
    expect(refusalOf(concat(one, second))).toBe("several-moov");
  });

  test("a nested container as deep as the input allows is never descended: only the schema's own path is", () => {
    let nested: Uint8Array = box("free");
    for (let i = 0; i < 5000; i++) nested = box("free", nested);
    expect(refusalOf(concat(box("ftyp", new Uint8Array(8)), box("moov", nested)))).toBe("no-audio-track");
  });

  test("a moov above the size cap is refused without being read", () => {
    const huge = concat(box("ftyp", new Uint8Array(8)), box("moov", new Uint8Array(9 * 1024 * 1024)));
    expect(refusalOf(huge)).toBe("moov-too-large");
  });

  test("an stsd claiming a million entries is read for its first only", () => {
    const good = buildM4a();
    const at = Buffer.from(good).indexOf(Buffer.from("stsd", "latin1")) + 4 + 4;
    const lie = Uint8Array.from(good);
    new DataView(lie.buffer).setUint32(at, 1_000_000);
    expect(probeMp4Audio(lie).ok).toBe(false);
  });

  test("a descriptor length that runs past the esds", () => {
    const bad = concat(
      box("ftyp", new Uint8Array(8)),
      box(
        "moov",
        box(
          "trak",
          box(
            "mdia",
            concat(
              fullBox("mdhd", 0, concat(u32(0), u32(0), u32(44100), u32(44100), new Uint8Array(4))),
              fullBox("hdlr", 0, concat(u32(0), new TextEncoder().encode("soun"), new Uint8Array(13))),
              box("minf", box("stbl", fullBox("stsd", 0, concat(u32(1), box("mp4a", concat(new Uint8Array(28), fullBox("esds", 0, Uint8Array.from([0x03, 0xff, 0xff, 0xff, 0x7f, 1, 2, 3]))))))))
            )
          )
        )
      )
    );
    expect(refusalOf(bad)).toBe("esds-unreadable");
  });
});
