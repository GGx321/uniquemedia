import { describe, expect, test } from "bun:test";
import { dataUrlBytes } from "./dataUrl";

// 3d.4: the preview's sticker canvas reads a picture's bytes to decode its frames. In the dev mock the picture is a `data:` URL, and
// the window's CSP lets script fetch only the built-in stickers' route, so a data URL is read here, without a fetch.

describe("dataUrlBytes", () => {
  test("a base64 data URL: its type and bytes", () => {
    expect(dataUrlBytes("data:image/png;base64,iVBORw0K")).toEqual({ type: "image/png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]) });
  });

  test("a percent-encoded data URL: the bytes of its UTF-8 text", () => {
    expect(dataUrlBytes("data:image/svg+xml,%3Csvg%2F%3E")).toEqual({ type: "image/svg+xml", bytes: new TextEncoder().encode("<svg/>") });
  });

  test("a type with parameters keeps only the type", () => {
    expect(dataUrlBytes("data:image/png;charset=x;base64,AA==")?.type).toBe("image/png");
  });

  test("anything else is not read: another scheme, no comma, broken base64 or broken escapes", () => {
    expect(dataUrlBytes("studio-media://sticker/heart-pulse")).toBe(null);
    expect(dataUrlBytes("data:image/png;base64")).toBe(null);
    expect(dataUrlBytes("data:image/png;base64,***")).toBe(null);
    expect(dataUrlBytes("data:text/plain,%E0%A4%A")).toBe(null);
  });
});
