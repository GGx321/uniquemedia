// Generates the synthetic inputs under .cache/render-bench/assets:
//   chart.jpg   720x1280 colour chart, full-range BT.601 JPEG (same shape as a real 1K photo)
//   sticker.png 400x300 RGBA sticker: opaque row, alpha-128 row, soft-alpha gradient row
//   texture.jpg 720x1280 blurred noise, a worst case for motion-smoothness metrics
// Patch tables are exported: colour.ts compares the decoded output against them.
import { ASSETS, CHART, STICKER, TEXTURE, ff } from "./common";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

export type RGB = [number, number, number];

// 4 columns x 6 rows, each 180x160 source px (720x960), then two uniform blocks
// (360x320 each) under it. The sticker is later laid over the left block.
export const GRID: RGB[] = [
  [255, 255, 255], [191, 191, 0], [0, 191, 191], [0, 191, 0],
  [191, 0, 191], [191, 0, 0], [0, 0, 191], [0, 0, 0],
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0],
  [0, 255, 255], [255, 0, 255], [64, 64, 64], [128, 128, 128],
  [192, 192, 192], [224, 172, 105], [141, 85, 36], [198, 134, 66],
  [241, 194, 125], [255, 219, 172], [16, 16, 16], [235, 235, 235],
];
export const BLOCK_L: RGB = [90, 140, 200];
export const BLOCK_R: RGB = [200, 120, 60];

export const CELL_W = 180;
export const CELL_H = 160;

function chartRaw(): Uint8Array {
  const w = 720, h = 1280;
  const buf = new Uint8Array(w * h * 3);
  const put = (x0: number, y0: number, cw: number, ch: number, c: RGB) => {
    for (let y = y0; y < y0 + ch; y++)
      for (let x = x0; x < x0 + cw; x++) buf.set(c, (y * w + x) * 3);
  };
  GRID.forEach((c, i) => put((i % 4) * CELL_W, Math.floor(i / 4) * CELL_H, CELL_W, CELL_H, c));
  put(0, 960, 360, 320, BLOCK_L);
  put(360, 960, 360, 320, BLOCK_R);
  return buf;
}

export const STICKER_COLOURS: RGB[] = [[220, 40, 40], [40, 180, 60], [40, 80, 220], [250, 180, 30]];
export const STICKER_W = 400;
export const STICKER_H = 300;

function stickerRaw(): Uint8Array {
  const buf = new Uint8Array(STICKER_W * STICKER_H * 4);
  for (let y = 0; y < STICKER_H; y++)
    for (let x = 0; x < STICKER_W; x++) {
      const col = Math.floor(x / 100);
      const row = Math.floor(y / 100);
      const c = STICKER_COLOURS[col]!;
      // row 0 opaque, row 1 alpha 128, row 2 horizontal alpha ramp (soft edge look)
      const a = row === 0 ? 255 : row === 1 ? 128 : Math.round((x / (STICKER_W - 1)) * 255);
      buf.set([c[0], c[1], c[2], a], (y * STICKER_W + x) * 4);
    }
  return buf;
}

async function rawToImage(raw: Uint8Array, w: number, h: number, fmt: string, vf: string, out: string, codec: string[]) {
  const tmp = join(ASSETS, `${out.split("/").pop()}.raw`);
  writeFileSync(tmp, raw);
  await ff(["-f", "rawvideo", "-pix_fmt", fmt, "-s", `${w}x${h}`, "-i", tmp, "-vf", vf, "-frames:v", "1", ...codec, out]);
}

export async function makeAssets() {
  // RGB -> full-range BT.601 explicitly, so the JPEG carries what a camera JPEG carries.
  await rawToImage(chartRaw(), 720, 1280, "rgb24", "scale=out_color_matrix=bt601:out_range=full,format=yuvj420p", CHART, ["-c:v", "mjpeg", "-q:v", "1"]);
  await rawToImage(stickerRaw(), STICKER_W, STICKER_H, "rgba", "null", STICKER, ["-c:v", "png"]);
  await ff([
    "-f", "lavfi", "-i", "nullsrc=s=720x1280,format=gray,geq=lum='random(1)*255'",
    "-vf", "gblur=sigma=1.1,format=yuvj420p", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", TEXTURE,
  ]);
}

if (import.meta.main) {
  await makeAssets();
  console.log("assets written to", ASSETS);
}
