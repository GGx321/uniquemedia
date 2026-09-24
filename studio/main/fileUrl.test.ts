import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { fileUrlToPathOn } from "./fileUrl";

// fileUrlToPathOn reads a file URL by the rules of the platform it is given,
// whatever the host: Bun ignores fileURLToPath's `windows` option, so without
// it a run on macOS could not hold main's sender check to Windows' rules.

describe("fileUrlToPathOn agrees with this platform's own fileURLToPath", () => {
  // Run on the macOS and on the Windows runner: each checks its own platform's
  // reading against the runtime's, compared as normalised paths, as the
  // sender check compares them. The URLs are ones every runtime reads alike,
  // and one without a drive letter (Windows' fileURLToPath throws on it, as
  // the Windows runner showed). The other refusals (a host, an encoded
  // separator, a malformed escape) are this module's own rules, at least as
  // strict as Node's, and are pinned per platform below.
  const corpus = [
    "file:///C:/Program%20Files/Studio/resources/app.asar/out-studio/renderer/index.html",
    "file:///c:/program%20files/studio/index.html",
    "file:///C:/a/index%2Ehtml",
    "file:///C:/a/main/../renderer/index.html",
    "file:///C:/%C3%A9t%C3%A9/index.html",
    "file:///C:/a/b?x=1#frag",
    "file://localhost/C:/a/b",
    "file:///Applications/Studio.app/Contents/Resources/index.html",
  ];
  const normalise = (path: string) => (process.platform === "win32" ? win32.normalize(path) : posix.normalize(path));
  const runtime = (url: string): string | null => {
    try {
      return normalise(fileURLToPath(url));
    } catch {
      return null;
    }
  };
  for (const url of corpus) {
    test(url, () => {
      const path = fileUrlToPathOn(url, process.platform);
      expect(path === null ? null : normalise(path)).toBe(runtime(url));
    });
  }
});

describe("fileUrlToPathOn on Windows", () => {
  test("a drive-letter URL becomes a drive path with backslashes, its escapes decoded", () => {
    expect(fileUrlToPathOn("file:///C:/Program%20Files/Studio/index.html", "win32")).toBe("C:\\Program Files\\Studio\\index.html");
    expect(fileUrlToPathOn("file:///c:/%C3%A9t%C3%A9/i.html", "win32")).toBe("c:\\été\\i.html");
  });

  test("a URL without a drive letter is not an absolute path and is refused", () => {
    expect(fileUrlToPathOn("file:///Applications/Studio.app/index.html", "win32")).toBeNull();
    expect(fileUrlToPathOn("file:///1:/x", "win32")).toBeNull();
  });

  test("an encoded backslash or slash is refused, in either letter case", () => {
    for (const escape of ["%5C", "%5c", "%2F", "%2f"]) {
      expect(fileUrlToPathOn(`file:///C:/a/x${escape}..${escape}index.html`, "win32")).toBeNull();
    }
  });

  test("a URL with a host (a UNC share) is refused, where fileURLToPath would read the share", () => {
    expect(fileUrlToPathOn("file://server/share/index.html", "win32")).toBeNull();
    // Refused for its host alone: its path has a drive letter.
    expect(fileUrlToPathOn("file://server/C:/share/index.html", "win32")).toBeNull();
  });
});

describe("fileUrlToPathOn off Windows", () => {
  for (const platform of ["darwin", "linux"] satisfies NodeJS.Platform[]) {
    test(`a URL is its decoded path; a drive letter is just a directory name (${platform})`, () => {
      expect(fileUrlToPathOn("file:///Applications/Studio.app/My%20App/index.html", platform)).toBe("/Applications/Studio.app/My App/index.html");
      expect(fileUrlToPathOn("file:///C:/Program%20Files/index.html", platform)).toBe("/C:/Program Files/index.html");
    });

    test(`an encoded backslash is a plain character of the name; an encoded slash is refused (${platform})`, () => {
      expect(fileUrlToPathOn("file:///a/x%5C..%5Cindex.html", platform)).toBe("/a/x\\..\\index.html");
      expect(fileUrlToPathOn("file:///a/x%2F..%2Findex.html", platform)).toBeNull();
    });

    test(`a URL with a host is refused (${platform})`, () => {
      expect(fileUrlToPathOn("file://server/share/index.html", platform)).toBeNull();
    });
  }
});

describe("fileUrlToPathOn refuses what is not a readable file URL", () => {
  for (const platform of ["darwin", "win32"] satisfies NodeJS.Platform[]) {
    test(`a malformed escape, a web URL and garbage (${platform})`, () => {
      expect(fileUrlToPathOn("file:///C:/a/%E0%A4%A", platform)).toBeNull();
      expect(fileUrlToPathOn("https://example.com/C:/a", platform)).toBeNull();
      expect(fileUrlToPathOn("::::", platform)).toBeNull();
    });

    test(`another scheme with no host, whose path alone would pass (${platform})`, () => {
      expect(fileUrlToPathOn("studio-media:///C:/a/index.html", platform)).toBeNull();
      expect(fileUrlToPathOn("studio-media:/C:/a/index.html", platform)).toBeNull();
      expect(fileUrlToPathOn("xfile:///C:/a/index.html", platform)).toBeNull();
    });
  }
});
