// Q5: full->limited range and BT.601->BT.709 correctness on a colour chart with a coloured
// RGBA sticker overlaid. The output is decoded WITHOUT any colour conversion (yuv420p raw
// planes) and each patch is compared with the expected limited-range BT.709 Y'CbCr computed
// from the patch's RGB. Variants show the 601 trap.
// Usage: bun spike/render-bench/colour.ts
import { ff, CHART, STICKER, OUT, saveResult } from "./common";
import { CONV, TAGS } from "./graphs";
import { GRID, BLOCK_L, BLOCK_R, STICKER_COLOURS, type RGB } from "./assets";
import { join } from "node:path";

const W = 1080, H = 1920;
const clamp = (v: number) => Math.min(255, Math.max(0, v));

/** Expected limited-range Y'CbCr (8 bit, not rounded) for full-range R'G'B' under a matrix. */
function ycc(rgb: RGB, m: "709" | "601"): [number, number, number] {
  const [kr, kb] = m === "709" ? [0.2126, 0.0722] : [0.299, 0.114];
  const kg = 1 - kr - kb;
  const y = kr * rgb[0] + kg * rgb[1] + kb * rgb[2];
  const cb = (rgb[2] - y) / (2 * (1 - kb));
  const cr = (rgb[0] - y) / (2 * (1 - kr));
  return [16 + (219 / 255) * y, 128 + (224 / 255) * cb, 128 + (224 / 255) * cr];
}
const mix = (a: RGB, b: RGB, alpha: number): RGB => [0, 1, 2].map((i) => alpha * a[i]! + (1 - alpha) * b[i]!) as RGB;

interface Patch { name: string; x: number; y: number; rgb: RGB }
const patches: Patch[] = [];
GRID.forEach((rgb, i) => {
  const col = i % 4, row = Math.floor(i / 4);
  patches.push({ name: `grid${i}`, x: (col + 0.5) * 270, y: (row + 0.5) * 240, rgb });
});
patches.push({ name: "blockL", x: 270, y: 1440 + 20, rgb: BLOCK_L }, { name: "blockR", x: 810, y: 1680, rgb: BLOCK_R });
const SX = 70, SY = 1500;
STICKER_COLOURS.forEach((c, i) => {
  patches.push({ name: `stickerOpaque${i}`, x: SX + 50 + 100 * i, y: SY + 50, rgb: c });
  patches.push({ name: `stickerA128_${i}`, x: SX + 50 + 100 * i, y: SY + 150, rgb: mix(c, BLOCK_L, 128 / 255) });
});

interface Variant { name: string; photo: string; sticker: string; note: string }
const UP = "scale=1080:1920:flags=lanczos";
const variants: Variant[] = [
  {
    name: "explicit",
    photo: CONV,
    sticker: "format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p",
    note: "the plan's chain: swscale pc/601 -> tv/709 for the photo, explicit 709 tv for the sticker",
  },
  {
    name: "explicit-zscale-photo",
    photo:
      "setparams=colorspace=bt470bg:color_primaries=bt709:color_trc=bt709:range=pc," +
      "zscale=rin=pc:r=tv:min=bt470bg:m=bt709,format=yuv420p," +
      "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv",
    sticker: "format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p",
    note: "photo through zscale (frames tagged before zscale, SP3) instead of swscale",
  },
  {
    name: "sticker-implicit-601",
    photo: CONV,
    sticker: "format=yuva420p",
    note: "TRAP: sticker converted by the auto-inserted scaler (BT.601 matrix) and mixed with 709 video",
  },
  {
    name: "photo-untouched",
    photo: "format=yuv420p",
    sticker: "format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p",
    note: "TRAP: photo only range-converted (601 coefficients kept) but tagged bt709",
  },
];

async function decodePlanes(file: string): Promise<{ y: Uint8Array; u: Uint8Array; v: Uint8Array }> {
  const r = await ff(["-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-"]);
  const ys = W * H, cs = (W / 2) * (H / 2);
  return { y: r.stdout.subarray(0, ys), u: r.stdout.subarray(ys, ys + cs), v: r.stdout.subarray(ys + cs, ys + 2 * cs) };
}

function avg(plane: Uint8Array, stride: number, cx: number, cy: number, r: number): number {
  let s = 0, n = 0;
  for (let y = Math.round(cy - r); y < Math.round(cy + r); y++)
    for (let x = Math.round(cx - r); x < Math.round(cx + r); x++) { s += plane[y * stride + x]!; n++; }
  return s / n;
}

async function render(v: Variant, final: boolean): Promise<string> {
  const out = join(OUT, `colour-${v.name}${final ? "-final" : ""}.mp4`);
  const enc = final
    ? ["-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20", "-maxrate", "3500k", "-bufsize", "7000k"]
    : ["-c:v", "libx264", "-preset", "ultrafast", "-qp", "0"];
  await ff([
    "-loop", "1", "-framerate", "30", "-t", "1", "-i", CHART,
    "-loop", "1", "-framerate", "30", "-t", "1", "-i", STICKER,
    "-filter_complex",
    `[0:v]${v.photo},${UP}[base];[1:v]${v.sticker}[st];[base][st]overlay=x=${SX}:y=${SY}:eof_action=endall:format=yuv420[v]`,
    "-map", "[v]", ...enc, "-pix_fmt", "yuv420p", ...TAGS, "-r", "30", "-frames:v", "30", out,
  ]);
  return out;
}

/** JPEG round-trip baseline: chart.jpg decoded with the CORRECT 601 full matrix vs the spec RGB. */
async function jpegBaseline(): Promise<number> {
  const r = await ff(["-i", CHART, "-vf", "scale=in_range=pc:in_color_matrix=bt601,format=rgb24", "-f", "rawvideo", "-"]);
  let worst = 0;
  for (const p of patches.filter((q) => q.name.startsWith("grid") || q.name.startsWith("block"))) {
    const sx = p.x / 1.5, sy = p.y / 1.5;
    for (let c = 0; c < 3; c++) {
      let s = 0, n = 0;
      for (let y = Math.round(sy - 8); y < Math.round(sy + 8); y++)
        for (let x = Math.round(sx - 8); x < Math.round(sx + 8); x++) { s += r.stdout[(y * 720 + x) * 3 + c]!; n++; }
      worst = Math.max(worst, Math.abs(s / n - p.rgb[c]!));
    }
  }
  return +worst.toFixed(2);
}

const out: Record<string, unknown> = { jpegRoundTripMaxRgbDev: await jpegBaseline() };
for (const final of [false, true]) {
  for (const v of variants) {
    if (final && v.name !== "explicit") continue;
    const file = await render(v, final);
    const pl = await decodePlanes(file);
    let maxY = 0, maxCb = 0, maxCr = 0;
    const worstByGroup: Record<string, number> = {};
    const per: Record<string, unknown>[] = [];
    for (const p of patches) {
      const [ey, ecb, ecr] = ycc(p.rgb, "709");
      const dy = avg(pl.y, W, p.x, p.y, 10) - ey;
      const dcb = avg(pl.u, W / 2, p.x / 2, p.y / 2, 4) - ecb;
      const dcr = avg(pl.v, W / 2, p.x / 2, p.y / 2, 4) - ecr;
      maxY = Math.max(maxY, Math.abs(dy)); maxCb = Math.max(maxCb, Math.abs(dcb)); maxCr = Math.max(maxCr, Math.abs(dcr));
      const grp = p.name.replace(/\d+$/, "").replace(/_$/, "");
      worstByGroup[grp] = Math.max(worstByGroup[grp] ?? 0, Math.abs(dy), Math.abs(dcb), Math.abs(dcr));
      per.push({ patch: p.name, dY: +dy.toFixed(2), dCb: +dcb.toFixed(2), dCr: +dcr.toFixed(2) });
    }
    const key = `${v.name}${final ? " (final encode CRF 20)" : " (lossless)"}`;
    const res = {
      note: v.note,
      maxAbsDev: { Y: +maxY.toFixed(2), Cb: +maxCb.toFixed(2), Cr: +maxCr.toFixed(2) },
      worstByPatchGroup: Object.fromEntries(Object.entries(worstByGroup).map(([k, x]) => [k, +x.toFixed(2)])),
      patches: per,
    };
    out[key] = res;
    console.log(key.padEnd(44), JSON.stringify(res.maxAbsDev), JSON.stringify(res.worstByPatchGroup));
  }
}
void clamp;
saveResult("colour", out);
