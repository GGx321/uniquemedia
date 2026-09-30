import { describe, expect, test } from "bun:test";
import { KINDS } from "./kinds";

const bytes = (...values: (number | string)[]): Uint8Array =>
  Uint8Array.from(values.flatMap((v) => (typeof v === "string" ? [...v].map((c) => c.charCodeAt(0)) : [v])));
const pad = (header: Uint8Array): Uint8Array => Uint8Array.from({ length: 16 }, (_, i) => header[i] ?? 0);

const HEADERS = {
  jpg: pad(bytes(0xff, 0xd8, 0xff, 0xe0)),
  png: pad(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a)),
  webp: pad(bytes("RIFF", 1, 2, 3, 4, "WEBP")),
  gif87: pad(bytes("GIF87a")),
  gif89: pad(bytes("GIF89a")),
  mp4: pad(bytes(0, 0, 0, 0x20, "ftypisom")),
  html: pad(bytes("<html><body>")),
  empty: new Uint8Array(0),
  zeros: new Uint8Array(16),
};

const accepts = (kind: keyof typeof KINDS, header: Uint8Array): boolean => KINDS[kind].sniff(header);

describe("KINDS: content type", () => {
  test("each kind has the type it is served with", () => {
    expect(Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, v.contentType]))).toEqual({
      jpg: "image/jpeg",
      png: "image/png",
      webp: "image/webp",
      gif: "image/gif",
      apng: "image/apng",
      mp4: "video/mp4",
      m4a: "audio/mp4",
    });
  });

  test("each kind's extension is its key, lowercase, without a dot", () => {
    for (const [key, kind] of Object.entries(KINDS)) expect<string>(kind.ext).toBe(key);
  });

  test("every kind has a positive size limit", () => {
    for (const kind of Object.values(KINDS)) expect(kind.maxBytes).toBeGreaterThan(0);
  });
});

describe("KINDS: sniffing the first bytes", () => {
  test("jpg accepts a JPEG start and nothing else", () => {
    expect(accepts("jpg", HEADERS.jpg)).toBe(true);
    for (const other of [HEADERS.png, HEADERS.webp, HEADERS.gif89, HEADERS.mp4, HEADERS.html, HEADERS.empty, HEADERS.zeros]) expect(accepts("jpg", other)).toBe(false);
  });

  test("png and apng accept the PNG signature and nothing else", () => {
    for (const kind of ["png", "apng"] as const) {
      expect(accepts(kind, HEADERS.png)).toBe(true);
      for (const other of [HEADERS.jpg, HEADERS.webp, HEADERS.gif89, HEADERS.mp4, HEADERS.html, HEADERS.empty, HEADERS.zeros]) expect(accepts(kind, other)).toBe(false);
    }
  });

  test("a PNG signature cut short is refused", () => {
    expect(accepts("png", HEADERS.png.subarray(0, 7))).toBe(false);
  });

  test("webp needs RIFF and WEBP with the size between", () => {
    expect(accepts("webp", HEADERS.webp)).toBe(true);
    expect(accepts("webp", pad(bytes("RIFF", 1, 2, 3, 4, "WAVE")))).toBe(false);
    expect(accepts("webp", pad(bytes("RIFX", 1, 2, 3, 4, "WEBP")))).toBe(false);
    for (const other of [HEADERS.jpg, HEADERS.png, HEADERS.mp4, HEADERS.html, HEADERS.empty]) expect(accepts("webp", other)).toBe(false);
  });

  test("gif accepts both versions and nothing else", () => {
    expect(accepts("gif", HEADERS.gif87)).toBe(true);
    expect(accepts("gif", HEADERS.gif89)).toBe(true);
    expect(accepts("gif", pad(bytes("GIF88a")))).toBe(false);
    for (const other of [HEADERS.jpg, HEADERS.png, HEADERS.webp, HEADERS.mp4, HEADERS.html, HEADERS.empty]) expect(accepts("gif", other)).toBe(false);
  });

  test("mp4 and m4a need ftyp at bytes 4 to 8", () => {
    for (const kind of ["mp4", "m4a"] as const) {
      expect(accepts(kind, HEADERS.mp4)).toBe(true);
      expect(accepts(kind, pad(bytes("ftyp", 0, 0, 0, 0)))).toBe(false);
      for (const other of [HEADERS.jpg, HEADERS.png, HEADERS.webp, HEADERS.gif89, HEADERS.html, HEADERS.empty, HEADERS.zeros]) expect(accepts(kind, other)).toBe(false);
    }
  });

  test("a header shorter than the signature is refused, never read past its end", () => {
    for (const kind of Object.values(KINDS)) expect(kind.sniff(bytes(0xff))).toBe(false);
  });
});
