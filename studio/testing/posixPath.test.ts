import { expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { relativePosix } from "./posixPath";

test("returns a Windows relative path with forward slashes", () => {
  expect(relativePosix("C:\\repo\\studio", "C:\\repo\\studio\\shared\\scenes\\template.ts", win32)).toBe("shared/scenes/template.ts");
});

test("leaves a POSIX relative path as it is", () => {
  expect(relativePosix("/repo/studio", "/repo/studio/shared/scenes/template.ts", posix)).toBe("shared/scenes/template.ts");
});

test("returns an empty string for the folder itself", () => {
  expect(relativePosix("C:\\repo\\studio", "C:\\repo\\studio", win32)).toBe("");
});
