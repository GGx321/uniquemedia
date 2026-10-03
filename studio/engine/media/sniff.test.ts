import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { formatOf, isHeic, mediaKindsOf, resolveMediaKind, unfitReason } from "./sniff";
useNativeGlobals();

// The boundary never trusts an extension: what a file IS comes from its first bytes. This is a coarse family check (is it a photo, a
// video, a track or a sticker at all); the per-kind importers (3f.2 to 3f.5) decode and validate the file properly.

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const bytes = (...parts: (number | number[])[]): Uint8Array => Uint8Array.from(parts.flat());
const zeros = (n: number): number[] => new Array<number>(n).fill(0);

const PNG_SIG = [0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, zeros(16));
const GIF89 = bytes(ascii("GIF89a"), zeros(16));
const GIF87 = bytes(ascii("GIF87a"), zeros(16));
const WEBP = bytes(ascii("RIFF"), zeros(4), ascii("WEBP"), ascii("VP8 "), zeros(8));
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const chunk = (type: string, body: number[]): number[] => [...u32(body.length), ...ascii(type), ...body, 0, 0, 0, 0];
const IHDR = chunk("IHDR", [...u32(8), ...u32(8), 8, 6, 0, 0, 0]);
const PNG_STILL = bytes(PNG_SIG, IHDR, chunk("IDAT", [1, 2, 3]), chunk("IEND", []));
const APNG = bytes(PNG_SIG, IHDR, chunk("acTL", [...u32(2), ...u32(0)]), chunk("IDAT", [1, 2, 3]), chunk("IEND", []));
const ftyp = (brand: string): Uint8Array => bytes(u32(24), ascii("ftyp"), ascii(brand), u32(0), ascii(brand), ascii("isom"));
const WAV = bytes(ascii("RIFF"), zeros(4), ascii("WAVE"), ascii("fmt "), zeros(8));

describe("mediaKindsOf", () => {
  test("a JPEG is a photo", () => {
    expect(mediaKindsOf(JPEG)).toEqual(["photo"]);
  });

  test("a PNG is a photo or a sticker, a WebP a photo", () => {
    expect(mediaKindsOf(PNG_STILL)).toEqual(["photo", "sticker"]);
    expect(mediaKindsOf(WEBP)).toEqual(["photo"]);
  });

  test("a GIF, in both versions, is a sticker", () => {
    expect(mediaKindsOf(GIF89)).toEqual(["sticker"]);
    expect(mediaKindsOf(GIF87)).toEqual(["sticker"]);
  });

  test("an MP4 or a MOV is a video, or a track when it is audio-only (the head cannot tell)", () => {
    expect(mediaKindsOf(ftyp("isom"))).toEqual(["video", "audio"]);
    expect(mediaKindsOf(ftyp("qt  "))).toEqual(["video", "audio"]);
  });

  test("an M4A brand is audio only", () => {
    expect(mediaKindsOf(ftyp("M4A "))).toEqual(["audio"]);
  });

  test("mp3 (an ID3 tag, or a bare frame), wav, flac and ogg are audio", () => {
    expect(mediaKindsOf(bytes(ascii("ID3"), 4, 0, zeros(16)))).toEqual(["audio"]);
    expect(mediaKindsOf(bytes(0xff, 0xfb, 0x90, 0x00, zeros(16)))).toEqual(["audio"]);
    expect(mediaKindsOf(WAV)).toEqual(["audio"]);
    expect(mediaKindsOf(bytes(ascii("fLaC"), zeros(16)))).toEqual(["audio"]);
    expect(mediaKindsOf(bytes(ascii("OggS"), zeros(16)))).toEqual(["audio"]);
  });

  test("a raw AAC stream (ADTS) is audio", () => {
    expect(mediaKindsOf(bytes(0xff, 0xf1, 0x50, 0x80, zeros(16)))).toEqual(["audio"]);
  });

  test("a RIFF that is neither WEBP nor WAVE is nothing (an AVI is not taken)", () => {
    expect(mediaKindsOf(bytes(ascii("RIFF"), zeros(4), ascii("AVI "), zeros(8)))).toEqual([]);
  });

  test("text, a Windows executable, a shell script and a PDF are nothing, whatever their name says", () => {
    expect(mediaKindsOf(bytes(ascii("hello, this is not a photo")))).toEqual([]);
    expect(mediaKindsOf(bytes(ascii("MZ"), zeros(30)))).toEqual([]);
    expect(mediaKindsOf(bytes(ascii("#!/bin/sh\nrm -rf ~\n")))).toEqual([]);
    expect(mediaKindsOf(bytes(ascii("%PDF-1.7\n")))).toEqual([]);
  });

  test("HEIC (an ftyp with a heic brand) is not a video or a track", () => {
    expect(mediaKindsOf(ftyp("heic"))).toEqual([]);
    expect(mediaKindsOf(ftyp("mif1"))).toEqual([]);
    expect(mediaKindsOf(ftyp("avif"))).toEqual([]);
  });

  test("a head that is too short to hold a signature is nothing, and so is an empty one", () => {
    expect(mediaKindsOf(new Uint8Array())).toEqual([]);
    expect(mediaKindsOf(bytes(0xff, 0xd8))).toEqual([]);
    expect(mediaKindsOf(bytes(ascii("GIF8")))).toEqual([]);
    expect(mediaKindsOf(bytes(0x89, ...ascii("PNG")))).toEqual([]);
  });

  test("a truncated ftyp box is nothing", () => {
    expect(mediaKindsOf(bytes(u32(24), ascii("ftyp"), ascii("is")))).toEqual([]);
  });

  test("a 0xFF byte that is not a frame sync is not an mp3", () => {
    expect(mediaKindsOf(bytes(0xff, 0x00, 0x00, 0x00, zeros(16)))).toEqual([]);
  });
});

describe("resolveMediaKind", () => {
  test("a pick of one kind accepts bytes of that kind", () => {
    expect(resolveMediaKind("photo", JPEG)).toBe("photo");
    expect(resolveMediaKind("sticker", GIF89)).toBe("sticker");
    expect(resolveMediaKind("audio", ftyp("M4A "))).toBe("audio");
  });

  test("a pick of one kind refuses bytes of another: a PNG is not a video, a script is not a photo", () => {
    expect(resolveMediaKind("video", PNG_STILL)).toBeNull();
    expect(resolveMediaKind("photo", bytes(ascii("#!/bin/sh\n")))).toBeNull();
    expect(resolveMediaKind("audio", JPEG)).toBeNull();
  });

  test("a still PNG may be picked as a sticker (the sticker importer refuses it as not animated)", () => {
    expect(resolveMediaKind("sticker", PNG_STILL)).toBe("sticker");
  });

  test("`any` reads the kind from the bytes: a JPEG is a photo, a GIF a sticker, a wav a track", () => {
    expect(resolveMediaKind("any", JPEG)).toBe("photo");
    expect(resolveMediaKind("any", GIF89)).toBe("sticker");
    expect(resolveMediaKind("any", WAV)).toBe("audio");
  });

  test("`any` takes an MP4 for a video and an M4A brand for a track", () => {
    expect(resolveMediaKind("any", ftyp("isom"))).toBe("video");
    expect(resolveMediaKind("any", ftyp("M4A "))).toBe("audio");
  });

  test("`any` takes a still PNG for a photo and an APNG for a sticker", () => {
    expect(resolveMediaKind("any", PNG_STILL)).toBe("photo");
    expect(resolveMediaKind("any", APNG)).toBe("sticker");
  });

  test("`any` refuses what is nothing", () => {
    expect(resolveMediaKind("any", bytes(ascii("MZ"), zeros(30)))).toBeNull();
  });
});

describe("HEIC", () => {
  test("an ftyp with a heic, heix, hevc or mif1 brand is HEIC, and an avif or an mp4 is not", () => {
    for (const brand of ["heic", "heix", "hevc", "mif1", "msf1"]) expect(isHeic(ftyp(brand))).toBe(true);
    expect(isHeic(ftyp("avif"))).toBe(false);
    expect(isHeic(ftyp("isom"))).toBe(false);
    expect(isHeic(JPEG)).toBe(false);
  });

  test("is told from other wrong bytes only for a photo pick or `any`: the owner is told to save it as a JPEG", () => {
    expect(unfitReason("photo", ftyp("heic"))).toBe("heic");
    expect(unfitReason("any", ftyp("heic"))).toBe("heic");
    expect(unfitReason("video", ftyp("heic"))).toBe("format");
    expect(unfitReason("audio", ftyp("heic"))).toBe("format");
  });

  test("any other bytes the pick does not take are a plain format refusal", () => {
    expect(unfitReason("photo", bytes(ascii("#!/bin/sh\n")))).toBe("format");
    expect(unfitReason("any", bytes(ascii("MZ"), zeros(30)))).toBe("format");
  });
});

describe("formatOf", () => {
  test("names the container: what ffmpeg is told with -f, never the extension's guess", () => {
    expect(formatOf(JPEG)).toBe("jpeg");
    expect(formatOf(PNG_STILL)).toBe("png");
    expect(formatOf(APNG)).toBe("apng");
    expect(formatOf(WEBP)).toBe("webp");
    expect(formatOf(GIF89)).toBe("gif");
    expect(formatOf(ftyp("isom"))).toBe("mp4");
    expect(formatOf(ftyp("qt  "))).toBe("mov");
    expect(formatOf(ftyp("M4A "))).toBe("m4a");
    expect(formatOf(WAV)).toBe("wav");
    expect(formatOf(bytes(ascii("fLaC"), zeros(16)))).toBe("flac");
    expect(formatOf(bytes(ascii("OggS"), zeros(16)))).toBe("ogg");
    expect(formatOf(bytes(ascii("ID3"), 4, 0, zeros(16)))).toBe("mp3");
    expect(formatOf(bytes(0xff, 0xfb, 0x90, 0x00, zeros(16)))).toBe("mp3");
    expect(formatOf(bytes(0xff, 0xf1, 0x50, 0x80, zeros(16)))).toBe("aac");
  });

  test("is null for bytes that are no container at all, and for a HEIC", () => {
    expect(formatOf(bytes(ascii("#!/bin/sh\n")))).toBeNull();
    expect(formatOf(ftyp("heic"))).toBeNull();
    expect(formatOf(new Uint8Array())).toBeNull();
  });
});
