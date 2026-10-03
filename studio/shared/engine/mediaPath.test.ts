import { describe, expect, test } from "bun:test";
import { isUnsafePickedPath } from "./mediaPath";

// Paths that are never a plain file, read by Windows' rules on any platform (3f.1). Main refuses them before the engine hears of a pick, and
// the engine refuses them again before it touches the disk: the same function on both sides.

describe("isUnsafePickedPath on Windows' rules", () => {
  const win = (path: string): boolean => isUnsafePickedPath(path, "win32");

  test("takes an ordinary drive path, a UNC path, a long-path prefix of a drive and forward slashes", () => {
    expect(win("C:\\Users\\me\\a.jpg")).toBe(false);
    expect(win("c:/Users/me/a.jpg")).toBe(false);
    expect(win("\\\\server\\share\\a.jpg")).toBe(false);
    expect(win("\\\\?\\C:\\very\\long\\path\\a.jpg")).toBe(false);
    expect(win("\\\\?\\UNC\\server\\share\\a.jpg")).toBe(false);
  });

  test("refuses the device namespace: a COM port, a pipe, a raw volume and anything else under \\\\.\\ or \\\\?\\", () => {
    expect(win("\\\\.\\COM1")).toBe(true);
    expect(win("\\\\.\\pipe\\studio")).toBe(true);
    expect(win("\\\\.\\C:")).toBe(true);
    expect(win("\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\a.jpg")).toBe(true);
    expect(win("\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\a.jpg")).toBe(true);
  });

  test("refuses a name with an alternate data stream", () => {
    expect(win("C:\\Users\\me\\a.jpg:secret")).toBe(true);
    expect(win("C:\\Users\\me\\a.jpg::$DATA")).toBe(true);
  });

  test("refuses a reserved device name, with or without an extension, in any case", () => {
    for (const name of ["CON", "con.jpg", "NUL", "Nul.txt", "PRN", "AUX.mp4", "COM1", "com9.jpg", "LPT1", "lpt3.png", "COM\u00b9"]) {
      expect(win(`C:\\Users\\me\\${name}`)).toBe(true);
    }
  });

  test("does not mistake a name that merely starts like one", () => {
    for (const name of ["console.jpg", "nullable.png", "COM10.jpg", "LPT0x.png", "auxiliary.mp3"]) {
      expect(win(`C:\\Users\\me\\${name}`)).toBe(false);
    }
  });

  test("a colon is an ordinary character in a POSIX name, and a device name is an ordinary file there", () => {
    expect(isUnsafePickedPath("/Users/me/a:b.jpg", "darwin")).toBe(false);
    expect(isUnsafePickedPath("/Users/me/CON", "linux")).toBe(false);
  });
});
