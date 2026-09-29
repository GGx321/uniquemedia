import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFfmpegOk } from "../../engine/render/ffmpeg.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { encodeApng } from "./apngWriter";
useNativeGlobals();

// The bundled ffmpeg is the render's real APNG reader: what it decodes here is
// what pass 2 will overlay.

const W = 20;
const H = 12;
const N = 5;
const dir = mkdtempSync(join(tmpdir(), "b5-apng-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function frame(n: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      out.set([(x * 9 + n * 40) & 255, (y * 17) & 255, (n * 50) & 255, 40 + ((x * 11 + y * 3 + n) % 200)], i);
    }
  }
  return out;
}

describe("the bundled ffmpeg reads the writer's APNG", () => {
  const frames = Array.from({ length: N }, (_, n) => frame(n));
  const file = join(dir, "t.apng");
  writeFileSync(file, encodeApng({ width: W, height: H, frames }));

  test("decodes N frames of the exact pixels, at 30 fps", async () => {
    const r = await runFfmpegOk(["-v", "error", "-f", "apng", "-i", file, "-vf", "fps=30,format=rgba", "-f", "rawvideo", "-pix_fmt", "rgba", "-"]);
    expect(r.stdout.length).toBe(W * H * 4 * N);
    for (let n = 0; n < N; n++) {
      const got = r.stdout.subarray(n * W * H * 4, (n + 1) * W * H * 4);
      expect(Buffer.compare(got, frames[n] ?? new Uint8Array(0))).toBe(0);
    }
  });
});
