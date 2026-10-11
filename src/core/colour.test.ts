import { test, expect } from "bun:test";
import { HDR_WITHOUT_ZSCALE, sourceToBt709 } from "./colour";
import type { MediaInfo, VideoColor } from "./types";

/**
 * Every copy leaves tagged BT.709, limited range, 8-bit 4:2:0, so every source
 * has to be IN that form before the recipe touches it. The conversion is
 * decided here from the probe alone; `ffmpegExecutor.colour.test.ts` renders
 * the real thing and measures it.
 */

const SDR709: VideoColor = { pixFmt: "yuv420p", space: "bt709", transfer: "bt709", primaries: "bt709", range: "tv" };
const UNTAGGED: VideoColor = { pixFmt: "yuv420p", space: "", transfer: "", primaries: "", range: "" };

const hd = (color?: VideoColor): MediaInfo => ({
  kind: "video", durationSec: 5, width: 1080, height: 1920, hasAudio: true, ...(color ? { color } : {}),
});
const sd = (color: VideoColor): MediaInfo => ({ ...hd(color), width: 640, height: 480 });

const SDR_OUT = "m=709:t=709:p=709:r=tv:dither=ordered,format=yuv420p";
const TONEMAP =
  "format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=mobius:param=0.8:peak=4.926:desat=0," +
  "zscale=t=bt709:m=bt709:r=tv:dither=ordered,format=yuv420p";

test("a BT.709 limited-range 8-bit source gets no conversion at all", () => {
  expect(sourceToBt709(hd(SDR709), true)).toBeNull();
  // 4:2:2 or 4:4:4 at 8 bits is the same colour; the encoder's own
  // -pix_fmt yuv420p subsamples it as it always has.
  expect(sourceToBt709(hd({ ...SDR709, pixFmt: "yuv422p" }), true)).toBeNull();
});

test("an info nobody probed is read as the form the graph ships", () => {
  expect(sourceToBt709(hd(), true)).toBeNull();
});

test("an untagged HD source is read as BT.709 and left alone", () => {
  expect(sourceToBt709(hd(UNTAGGED), true)).toBeNull();
  // ffprobe builds that print the word rather than omit the key.
  const unknown: VideoColor = { pixFmt: "yuv420p", space: "unknown", transfer: "unknown", primaries: "unknown", range: "unknown" };
  expect(sourceToBt709(hd(unknown), true)).toBeNull();
});

test("an untagged SD source is read as BT.601 and converted to BT.709", () => {
  expect(sourceToBt709(sd(UNTAGGED), true)).toBe(
    `zscale=min=smpte170m:rin=tv:tin=bt709:pin=bt709:${SDR_OUT}`
  );
});

test("the 720-line boundary decides the untagged matrix", () => {
  expect(sourceToBt709({ ...sd(UNTAGGED), width: 1280, height: 720 }, true)).toBeNull();
  expect(sourceToBt709({ ...sd(UNTAGGED), width: 1278, height: 718 }, true)).toContain("min=smpte170m");
});

test("a tagged BT.601 source converts from exactly what it states", () => {
  const tagged: VideoColor = { pixFmt: "yuv420p", space: "smpte170m", transfer: "smpte170m", primaries: "smpte170m", range: "tv" };
  expect(sourceToBt709(sd(tagged), true)).toBe(
    `zscale=min=smpte170m:rin=tv:tin=smpte170m:pin=smpte170m:${SDR_OUT}`
  );
  // A tag beats the size rule: an HD file that says BT.601 is BT.601.
  expect(sourceToBt709(hd({ ...tagged, space: "bt470bg" }), true)).toContain("min=bt470bg");
});

test("a full-range source is brought to limited range", () => {
  expect(sourceToBt709(hd({ ...SDR709, range: "pc" }), true)).toBe(
    `zscale=min=bt709:rin=pc:tin=bt709:pin=bt709:${SDR_OUT}`
  );
  // A JPEG-range pixel format says it even when the range tag is missing.
  expect(sourceToBt709(hd({ ...SDR709, pixFmt: "yuvj420p", range: "" }), true)).toContain("rin=pc");
});

test("a source deeper than 8 bits is dithered down to 8", () => {
  expect(sourceToBt709(hd({ ...SDR709, pixFmt: "yuv420p10le" }), true)).toBe(
    `zscale=min=bt709:rin=tv:tin=bt709:pin=bt709:${SDR_OUT}`
  );
});

test("an RGB source is converted to BT.709 YUV rather than left to swscale's BT.601 default", () => {
  expect(sourceToBt709(hd({ ...UNTAGGED, pixFmt: "rgb24" }), true)).toContain(`rin=pc:tin=bt709:pin=bt709:${SDR_OUT}`);
});

test("HLG is tone-mapped to SDR from 203-nit reference white", () => {
  const hlg: VideoColor = { pixFmt: "yuv420p10le", space: "bt2020nc", transfer: "arib-std-b67", primaries: "bt2020", range: "tv" };
  expect(sourceToBt709(hd(hlg), true)).toBe(
    `zscale=min=bt2020nc:rin=tv:tin=arib-std-b67:pin=bt2020:t=linear:npl=203,${TONEMAP}`
  );
});

test("PQ is tone-mapped the same way", () => {
  const pq: VideoColor = { pixFmt: "yuv420p10le", space: "bt2020nc", transfer: "smpte2084", primaries: "bt2020", range: "tv" };
  expect(sourceToBt709(hd(pq), true)).toBe(
    `zscale=min=bt2020nc:rin=tv:tin=smpte2084:pin=bt2020:t=linear:npl=203,${TONEMAP}`
  );
});

test("an HDR source with no matrix or primaries tag is read as BT.2020", () => {
  const bare: VideoColor = { pixFmt: "yuv420p10le", space: "", transfer: "arib-std-b67", primaries: "", range: "" };
  expect(sourceToBt709(hd(bare), true)).toContain("min=bt2020nc:rin=tv:tin=arib-std-b67:pin=bt2020:");
});

test("an unknown tag value falls back to the guess, never reaches ffmpeg", () => {
  const odd: VideoColor = { pixFmt: "yuv420p", space: "ictcp", transfer: "smpte428", primaries: "nonsense", range: "tv" };
  const chain = sourceToBt709(sd(odd), true) ?? "";
  expect(chain).toContain("min=smpte170m:");
  expect(chain).toContain("tin=bt709:");
  expect(chain).toContain("pin=bt709:");
});

// ── without zscale ───────────────────────────────────────────────────────────

test("without zscale an SDR source falls back to the colorspace filter", () => {
  expect(sourceToBt709(sd(UNTAGGED), false)).toBe(
    "colorspace=ispace=smpte170m:itrc=bt709:iprimaries=bt709:irange=tv:all=bt709:range=tv:format=yuv420p"
  );
  expect(sourceToBt709(hd(SDR709), false)).toBeNull();
});

test("without zscale an HDR source fails loudly, in words the app shows", () => {
  const hlg: VideoColor = { pixFmt: "yuv420p10le", space: "bt2020nc", transfer: "arib-std-b67", primaries: "bt2020", range: "tv" };
  expect(() => sourceToBt709(hd(hlg), false)).toThrow(HDR_WITHOUT_ZSCALE);
  expect(HDR_WITHOUT_ZSCALE).toMatch(/HDR/);
  expect(HDR_WITHOUT_ZSCALE).toMatch(/[а-яё]/i);
});
