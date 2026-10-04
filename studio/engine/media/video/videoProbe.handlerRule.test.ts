import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { bytesSource, probeVideo, type ProbeRefusal, type VideoInfo } from "./videoProbe";
import { box, buildMp4, concat, hdlrBox, largeBox, u32, type Mp4Spec, type TrackSpec } from "./testing/mp4VideoBuilder";
useNativeGlobals();

// 3f.3a follow-up (review round 4, variants D and E). ffmpeg's mov demuxer descends into every container of its parse table (`stbl`, `dinf`,
// `edts`, `tref`, `udta`, and `meta` anywhere, scanning `meta` for an `hdlr` on a 4-byte step) and the LAST `hdlr` it reads wins. Rounds 2 and 3
// listed the places an `hdlr` could hide; D (inside `stbl`) and E (inside `dinf`) were two more. The rule that closes the class is one: the only
// `hdlr` a track may have is the one in `mdia`, and a data handler in `minf`. An `hdlr` anywhere else in the `trak` is refused, whatever it says.
// (Measured on ffmpeg 6.x: an `hdlr` in a sample entry, and one outside any `trak`, changes nothing, so neither is walked.)

async function infoOf(spec: Mp4Spec): Promise<VideoInfo> {
  const result = await probeVideo(bytesSource(buildMp4(spec)));
  if (!result.ok) throw new Error(`expected the file to be read, it was refused: ${result.reason}`);
  return result.info;
}

async function refusalOf(spec: Mp4Spec): Promise<ProbeRefusal> {
  const result = await probeVideo(bytesSource(buildMp4(spec)));
  if (result.ok) throw new Error("expected the file to be refused");
  return result.reason;
}

const video = (over: Partial<TrackSpec> = {}): TrackSpec => ({ handler: "vide", ...over });
/** A track labelled sound whose sample entry is a picture (what an attacker writes). */
const sound = (over: Partial<TrackSpec> = {}): TrackSpec => ({ handler: "soun", sampleEntry: "video", ...over });

describe("an hdlr anywhere in the trak subtree except mdia's and minf's data handler is refused", () => {
  const SUBTYPES: string[] = ["vide", "soun", "mdir", "mdta", "alis"];
  /** Each place an `hdlr` can be put in a track, as the track spec that puts the handler there. */
  const PLACES: Readonly<Record<string, (handler: Uint8Array) => Partial<TrackSpec>>> = {
    "the trak itself": (handler) => ({ trakExtra: [handler] }),
    "stbl, before stsd": (handler) => ({ stblExtra: [handler] }),
    "dinf, before dref": (handler) => ({ dinfExtra: [handler] }),
    edts: (handler) => ({ edtsExtra: [handler] }),
    tref: (handler) => ({ trakExtra: [box("tref", handler)] }),
    udta: (handler) => ({ trakExtra: [box("udta", handler)] }),
    "a mdia inside udta": (handler) => ({ trakExtra: [box("udta", box("mdia", handler))] }),
    "a stbl inside udta": (handler) => ({ trakExtra: [box("udta", box("stbl", handler))] }),
  };

  for (const [place, put] of Object.entries(PLACES)) {
    test.each(SUBTYPES)(`a %s handler in ${place} of a sound track is refused`, async (subtype) => {
      expect(await refusalOf({ tracks: [video(), sound(put(hdlrBox(subtype)))] })).toBe("hidden-handler");
    });
  }

  test.each(Object.keys(PLACES))("a handler in the VIDEO track itself is refused too: %s", async (place) => {
    const put = PLACES[place];
    if (put === undefined) throw new Error("no such place");
    expect(await refusalOf({ tracks: [video(put(hdlrBox("vide")))] })).toBe("hidden-handler");
  });

  describe("a meta box is scanned the way ffmpeg scans it: for an hdlr tag on a 4-byte step, wherever the meta box is", () => {
    const metaWith = (subtype: string): Uint8Array => box("meta", concat(u32(0), hdlrBox(subtype)));
    const META_PLACES: Readonly<Record<string, (meta: Uint8Array) => Partial<TrackSpec>>> = {
      stbl: (meta) => ({ stblExtra: [meta] }),
      minf: (meta) => ({ minfExtra: [meta] }),
      dinf: (meta) => ({ dinfExtra: [meta] }),
      edts: (meta) => ({ edtsExtra: [meta] }),
      tref: (meta) => ({ trakExtra: [box("tref", meta)] }),
    };

    test.each(Object.keys(META_PLACES))("a meta box in %s with a vide handler is refused", async (place) => {
      const put = META_PLACES[place];
      if (put === undefined) throw new Error("no such place");
      expect(await refusalOf({ tracks: [video(), sound(put(metaWith("vide")))] })).toBe("hidden-handler");
    });

    test("an hdlr tag after padding, on a 4-byte step, is found (ffmpeg skips to it)", async () => {
      const padded = box("meta", concat(new Uint8Array(8), hdlrBox("vide")));
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [padded] })] })).toBe("hidden-handler");
    });

    test("an hdlr tag as the first four bytes of the meta box is found too", async () => {
      const first = box("meta", new Uint8Array([0x68, 0x64, 0x6c, 0x72, 0, 0, 0, 0, 0, 0, 0, 0, 0x76, 0x69, 0x64, 0x65, 0, 0, 0, 0]));
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [first] })] })).toBe("hidden-handler");
    });

    test("an hdlr tag on an odd offset is not one ffmpeg finds, and is not refused", async () => {
      const odd = box("meta", concat(new Uint8Array(3), hdlrBox("vide")));
      expect((await infoOf({ tracks: [video(), sound({ trakExtra: [odd] })] })).video.width).toBe(1920);
    });

    test("a meta box with no handler in it is not refused", async () => {
      const plain = box("meta", concat(u32(0), box("keys", new Uint8Array(8))));
      expect((await infoOf({ tracks: [video({ trakExtra: [plain] })] })).video.width).toBe(1920);
    });
  });

  describe("ffmpeg does not need a well-formed list: it clamps a size and reads on, so a malformed one is read as ffmpeg reads it", () => {
    const sized = (size: number): Uint8Array => {
      const handler = Uint8Array.from(hdlrBox("vide"));
      new DataView(handler.buffer).setUint32(0, size);
      return handler;
    };

    test("an hdlr whose size is 0 (to the end of its parent) in udta is refused", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", sized(0))] })] })).toBe("hidden-handler");
    });

    test("an hdlr whose size is far past its parent in udta is refused", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", sized(0x7fffffff))] })] })).toBe("hidden-handler");
    });

    test("an hdlr with a 64-bit size in udta is refused", async () => {
      const payload = hdlrBox("vide").subarray(8);
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", largeBox("hdlr", payload, BigInt(16 + payload.byteLength)))] })] })).toBe("hidden-handler");
    });

    test("an hdlr inside a udta that has a 64-bit size is found (its children start after the 16-byte header)", async () => {
      const handler = hdlrBox("vide");
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", largeBox("udta", handler, BigInt(16 + handler.byteLength)))] })] })).toBe("hidden-handler");
    });

    test("an hdlr whose 64-bit size is far past its parent is refused", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", largeBox("hdlr", hdlrBox("vide").subarray(8), 2n ** 40n))] })] })).toBe("hidden-handler");
    });

    test("an hdlr that comes before a broken box in udta is refused (the broken box ends the list after the handler was read)", async () => {
      const broken = concat(hdlrBox("vide"), u32(3), new Uint8Array([0x78, 0x78, 0x78, 0x78]));
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", broken)] })] })).toBe("hidden-handler");
    });

    test("an hdlr after another box in udta is found", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [box("udta", concat(box("xxxx", new Uint8Array(4)), hdlrBox("vide")))] })] })).toBe("hidden-handler");
    });

    test("the zero terminator a QuickTime udta ends with is not a box, and is not refused", async () => {
      const info = await infoOf({ tracks: [video({ trakExtra: [box("udta", concat(box("name", new Uint8Array(6)), u32(0)))] })] });
      expect(info.video.width).toBe(1920);
    });
  });

  describe("every trak is walked, and the walk is bounded", () => {
    test("a trak with no mdia at all, holding only a handler, is refused", async () => {
      expect(await refusalOf({ tracks: [video()], moovExtra: [box("trak", hdlrBox("vide"))] })).toBe("hidden-handler");
    });

    const nested = (levels: number, inner: Uint8Array): Uint8Array => (levels === 0 ? inner : nested(levels - 1, box("udta", inner)));

    test("a handler ten containers deep (ffmpeg's own limit is 10 levels) is refused as a handler", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [nested(8, hdlrBox("vide"))] })] })).toBe("hidden-handler");
    });

    test("a tree nested far past what ffmpeg follows is refused as too many boxes, not followed to its bottom", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ trakExtra: [nested(40, hdlrBox("vide"))] })] })).toBe("too-many-boxes");
    });
  });

  describe("the one hdlr a minf may have is a data handler", () => {
    test("component type dhlr with subtype vide is not a data handler: ffmpeg reads the subtype", async () => {
      expect(await refusalOf({ tracks: [video(), sound({ minfExtra: [hdlrBox("vide", "dhlr")] })] })).toBe("hidden-handler");
    });

    test("dhlr with subtype soun is refused as well", async () => {
      expect(await refusalOf({ tracks: [video({ minfExtra: [hdlrBox("soun", "dhlr")] })] })).toBe("hidden-handler");
    });

    test.each([
      ["alis", "dhlr"],
      ["url ", "dhlr"],
      ["rsrc", "dhlr"],
      ["alis", ""],
      ["url ", "mhlr"],
    ])("a data handler %s (component type '%s') is taken", async (subtype, component) => {
      expect((await infoOf({ tracks: [video({ minfExtra: [hdlrBox(subtype, component)] })] })).video.width).toBe(1920);
    });

    test("a minf handler that is no data handler and names no media (mdir) is refused: the rule has no list of names to forget", async () => {
      expect(await refusalOf({ tracks: [video({ minfExtra: [hdlrBox("mdir")] })] })).toBe("hidden-handler");
    });

    test("a dhlr handler whose subtype names nothing at all is a data handler and is taken", async () => {
      expect((await infoOf({ tracks: [video({ minfExtra: [hdlrBox("\0\0\0\0", "dhlr")] })] })).video.width).toBe(1920);
    });

    test("two handlers in minf are still refused as a repeat, whatever they say", async () => {
      expect(await refusalOf({ tracks: [video({ minfExtra: [hdlrBox("url ", "dhlr"), hdlrBox("url ", "dhlr")] })] })).toBe("duplicate-box");
    });
  });

  describe("ordinary files keep importing", () => {
    const entry = (fourcc: string): TrackSpec["entry"] => ({ fourcc, width: 1920, height: 1080 });
    const data = (): Uint8Array[] => [hdlrBox("url ", "dhlr")];

    test("a MOV with sowt audio, a text chapter track, a tmcd timecode track and an mebx metadata track, each with its data handler", async () => {
      const info = await infoOf({
        tracks: [
          video({ minfExtra: data() }),
          { handler: "soun", sampleEntry: "video", entry: entry("sowt"), minfExtra: data() },
          { handler: "text", sampleEntry: "video", entry: entry("text"), minfExtra: data() },
          { handler: "tmcd", sampleEntry: "video", entry: entry("tmcd"), minfExtra: data() },
          { handler: "meta", sampleEntry: "video", entry: entry("mebx"), minfExtra: data() },
        ],
      });
      expect(info.video.width).toBe(1920);
      expect(info.audioTracks).toBe(1);
    });

    test("the file's own mdta metadata (moov/meta with an mdta handler, and moov/udta/meta) is outside every track and is not refused", async () => {
      const mdta = box("meta", concat(u32(0), hdlrBox("mdta"), box("keys", new Uint8Array(8))));
      const info = await infoOf({ tracks: [video({ minfExtra: data() })], moovExtra: [mdta, box("udta", mdta)] });
      expect(info.video.width).toBe(1920);
    });

    test("a track whose udta holds only data boxes and whose tref points at another track is not refused", async () => {
      const info = await infoOf({ tracks: [video({ trakExtra: [box("tref", box("chap", u32(2))), box("udta", box("name", new Uint8Array(6)))] })] });
      expect(info.video.width).toBe(1920);
    });
  });
});
