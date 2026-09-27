// Runs as a full Electron app (never ELECTRON_RUN_AS_NODE, which turns
// require("electron") into just the binary path string, not the API): the
// only way to get nativeImage's real Chromium/libjpeg-turbo decode, which is
// what parity.test.ts needs (spike/face-js/README.md: "Electron
// nativeImage.toBitmap() is also 100% byte-identical to cv2.imread").
//
// argv[2] is a JSON manifest [{ in, out }]; each "in" image is decoded and
// its BGRA bitmap written to "out" as: 4-byte LE width, 4-byte LE height,
// then width*height*4 raw bytes. Test-only — never imported by studio/engine.
import { app, nativeImage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));

app.whenReady().then(() => {
  try {
    for (const { in: inPath, out: outPath } of manifest) {
      const img = nativeImage.createFromPath(inPath);
      const { width, height } = img.getSize();
      if (width === 0 || height === 0) throw new Error(`electronDecode: failed to decode ${inPath}`);
      const bitmap = img.toBitmap();
      const header = Buffer.alloc(8);
      header.writeInt32LE(width, 0);
      header.writeInt32LE(height, 4);
      writeFileSync(outPath, Buffer.concat([header, bitmap]));
    }
    app.exit(0);
  } catch (err) {
    console.error(String(err && err.stack ? err.stack : err));
    app.exit(1);
  }
});
