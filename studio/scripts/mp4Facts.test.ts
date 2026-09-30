import { describe, expect, test } from "bun:test";
import { boxTree, formatBoxTree, mp4Facts } from "./mp4Facts";

// What the packaged E2E records about each rendered file on each OS (plan 3a.9): the full box tree, including the children of
// the sample entries and the `stbl` set, the `ftyp` brands, the creation and modification times, the `©too` string and the
// compressor name. Built here from hand-made boxes, so these tests depend on no encoder.

const u32 = (n: number): number[] => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const fourcc = (type: string): number[] => Array.from(type, (c) => c.charCodeAt(0) & 255);
const cat = (...parts: readonly (readonly number[] | Uint8Array)[]): number[] => parts.flatMap((p) => Array.from(p));
const box = (type: string, ...payload: readonly (readonly number[])[]): number[] => {
  const body = cat(...payload);
  return [...u32(8 + body.length), ...fourcc(type), ...body];
};
const zeros = (n: number): number[] => new Array<number>(n).fill(0);
/** A full box's payload: version 0, no flags, then `rest`. */
const full = (...rest: readonly (readonly number[])[]): number[] => cat([0, 0, 0, 0], ...rest);

/** An `avc1` sample entry: 78 bytes of fields (the compressor name is the 32-byte Pascal string at 42), then its child boxes. */
function avc1(compressor: string, ...children: readonly (readonly number[])[]): number[] {
  const fields = zeros(78);
  fields[42] = compressor.length;
  fields.splice(43, compressor.length, ...fourcc(compressor));
  return box("avc1", fields, ...children);
}

/** An `mp4a` sample entry: 28 bytes of fields, then its child boxes. */
const mp4a = (...children: readonly (readonly number[])[]): number[] => box("mp4a", zeros(28), ...children);

const stsd = (...entries: readonly (readonly number[])[]): number[] => box("stsd", full(u32(entries.length), ...entries));

function sample(options: { creation?: number; modification?: number; tool?: string; compressor?: string; brands?: string[] } = {}): Uint8Array {
  const { creation = 0, modification = 0, tool = "Lavf61.1.100", compressor = "Lavc61.3.100 libx264", brands = ["isom", "iso2", "avc1", "mp41"] } = options;
  const times = [...u32(creation), ...u32(modification)];
  const videoTrak = box(
    "trak",
    box("tkhd", full(times, zeros(8))),
    box("edts", box("elst", full(u32(1), zeros(12)))),
    box(
      "mdia",
      box("mdhd", full(times, zeros(8))),
      box("hdlr", full(zeros(20))),
      box(
        "minf",
        box("vmhd", full(zeros(8))),
        box("dinf", box("dref", full(u32(1), box("url ", [0, 0, 0, 1])))),
        box("stbl", stsd(avc1(compressor, box("avcC", zeros(10)), box("colr", zeros(11)), box("pasp", zeros(8)), box("btrt", zeros(12)))), box("stts", full(zeros(4))), box("stss", full(zeros(4))), box("ctts", full(zeros(4))), box("stsc", full(zeros(4))), box("stsz", full(zeros(8))), box("stco", full(zeros(4)))),
      ),
    ),
  );
  const audioTrak = box("trak", box("tkhd", full(times, zeros(8))), box("mdia", box("mdhd", full(times, zeros(8))), box("minf", box("stbl", stsd(mp4a(box("esds", zeros(20)), box("btrt", zeros(12)))), box("sgpd", full(zeros(4))), box("sbgp", full(zeros(4)))))));
  const udta = box("udta", box("meta", full(box("hdlr", full(zeros(20))), box("ilst", box("©too", box("data", cat([0, 0, 0, 1, 0, 0, 0, 0], fourcc(tool))))))));
  return Uint8Array.from(
    cat(
      box("ftyp", fourcc(brands[0] ?? "isom"), u32(512), ...brands.map(fourcc)),
      box("moov", box("mvhd", full(times, zeros(8))), videoTrak, audioTrak, udta),
      box("free", zeros(4)),
      box("mdat", zeros(16)),
    ),
  );
}

describe("boxTree", () => {
  test("lists the top-level boxes in file order", () => {
    expect(boxTree(sample()).map((node) => node.type)).toEqual(["ftyp", "moov", "free", "mdat"]);
  });

  test("goes into the sample entries of `stsd`, so a box inside `avc1` or `mp4a` shows", () => {
    const text = formatBoxTree(boxTree(sample()));

    expect(text).toContain("stsd(avc1(avcC colr pasp btrt))");
    expect(text).toContain("stsd(mp4a(esds btrt))");
  });

  test("lists the `stbl` set of each track", () => {
    const text = formatBoxTree(boxTree(sample()));

    expect(text).toContain("stbl(stsd(avc1(avcC colr pasp btrt)) stts stss ctts stsc stsz stco)");
    expect(text).toContain("stbl(stsd(mp4a(esds btrt)) sgpd sbgp)");
  });

  test("goes through `meta` (a full box) and `ilst` to the `©too` string's box", () => {
    expect(formatBoxTree(boxTree(sample()))).toContain("udta(meta(hdlr ilst(©too(data))))");
  });

  test("shows a box it has never heard of in place, which is the point: Windows may write one the allowlist lacks", () => {
    const bytes = Uint8Array.from(cat(box("ftyp", fourcc("isom"), u32(0)), box("moov", box("mvhd", full(zeros(16))), box("trak", box("mdia", box("minf", box("stbl", box("zzzz", zeros(4)))))))));

    expect(formatBoxTree(boxTree(bytes))).toContain("stbl(zzzz)");
  });

  test("throws on a box that runs past its parent, instead of walking garbage", () => {
    const bad = Uint8Array.from([...u32(100), ...fourcc("moov"), 0, 0, 0, 0]);

    expect(() => boxTree(bad)).toThrow();
  });
});

describe("mp4Facts", () => {
  test("reads the `ftyp` brands", () => {
    expect(mp4Facts(sample()).brands).toEqual({ major: "isom", minor: 512, compatible: ["isom", "iso2", "avc1", "mp41"] });
  });

  test("reads zero creation and modification times from `mvhd`, every `tkhd` and every `mdhd`", () => {
    expect(mp4Facts(sample()).times).toEqual({ mvhd: [{ creation: 0, modification: 0 }], tkhd: [{ creation: 0, modification: 0 }, { creation: 0, modification: 0 }], mdhd: [{ creation: 0, modification: 0 }, { creation: 0, modification: 0 }] });
  });

  test("reads a time that is not zero, so a file that carries the machine's clock shows it", () => {
    const facts = mp4Facts(sample({ creation: 3_700_000_000, modification: 3_700_000_005 }));

    expect(facts.times.mvhd).toEqual([{ creation: 3_700_000_000, modification: 3_700_000_005 }]);
    expect(facts.times.tkhd.every((t) => t.creation === 3_700_000_000)).toBe(true);
  });

  test("reads the `©too` string and the video's compressor name", () => {
    const facts = mp4Facts(sample({ tool: "Lavf60.16.100", compressor: "Lavc60.31.102 libx264" }));

    expect(facts.tool).toBe("Lavf60.16.100");
    expect(facts.compressor).toBe("Lavc60.31.102 libx264");
  });

  test("reads null for a file without them", () => {
    const bare = Uint8Array.from(cat(box("ftyp", fourcc("isom"), u32(0)), box("moov", box("mvhd", full(zeros(16))))));

    expect(mp4Facts(bare)).toMatchObject({ tool: null, compressor: null, times: { mvhd: [{ creation: 0, modification: 0 }], tkhd: [], mdhd: [] } });
  });
});
