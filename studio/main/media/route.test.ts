import { describe, expect, test } from "bun:test";
import { parseMediaRoute } from "./route";

const A = "avatar-0001";
const B = "second-0002";

describe("parseMediaRoute accepts exactly the routes of invariant 28", () => {
  const accepted: [string, unknown][] = [
    [`studio-media://photo/${A}/${B}`, { route: "photo", avatarId: A, photoId: B }],
    [`studio-media://video/${A}/${B}`, { route: "video", avatarId: A, videoId: B }],
    [`studio-media://poster/${A}/${B}`, { route: "poster", avatarId: A, videoId: B }],
    [`studio-media://track/${A}`, { route: "track", trackId: A }],
    [`studio-media://cover/${A}`, { route: "cover", trackId: A }],
    [`studio-media://sticker/heart-pulse`, { route: "sticker", stickerId: "heart-pulse" }],
    [`studio-media://text/${A}`, { route: "text", previewId: A }],
    [`studio-media://media/${A}`, { route: "media", mediaId: A }],
  ];
  for (const [url, expected] of accepted) {
    test(`accepts ${url}`, () => {
      expect(parseMediaRoute(url)).toEqual(expected as never);
    });
  }

  test("accepts ids at the 8 and 64 character limits", () => {
    const long = "a".repeat(64);
    expect(parseMediaRoute(`studio-media://track/${long}`)).toEqual({ route: "track", trackId: long });
    expect(parseMediaRoute("studio-media://track/abcdefgh")).toEqual({ route: "track", trackId: "abcdefgh" });
  });
});

describe("parseMediaRoute refuses everything else", () => {
  const rejected: [string, string][] = [
    ["an unknown route", `studio-media://audio/${A}`],
    ["a route in capitals", `studio-media://VIDEO/${A}/${B}`],
    ["a route with a trailing dot", `studio-media://video./${A}/${B}`],
    ["another scheme", `file://photo/${A}/${B}`],
    ["another scheme in capitals but the same path", `http://photo/${A}/${B}`],
    ["a single-id route with two ids", `studio-media://track/${A}/${B}`],
    ["a two-id route with one id", `studio-media://video/${A}`],
    ["a two-id route with three ids", `studio-media://video/${A}/${B}/${A}`],
    ["no id at all", "studio-media://video"],
    ["no id after the slash", "studio-media://video/"],
    ["a trailing slash", `studio-media://track/${A}/`],
    ["an empty segment", `studio-media://video/${A}//${B}`],
    ["a dot-dot walk", `studio-media://video/${A}/../../etc/passwd`],
    ["a dot-dot as an id", `studio-media://track/..`],
    ["a dot id", `studio-media://track/.`],
    ["an encoded dot-dot", `studio-media://track/%2e%2e`],
    ["an encoded slash in lower case", `studio-media://video/${A}%2f${B}`],
    ["an encoded slash in upper case", `studio-media://video/${A}%2F${B}`],
    ["an encoded backslash", `studio-media://video/${A}%5C${B}`],
    ["an encoded backslash in lower case", `studio-media://video/${A}%5c${B}`],
    ["an encoded dot", `studio-media://track/abc%2Edefgh`],
    ["a percent sign anywhere", `studio-media://track/abcdefg%41`],
    ["a double-encoded slash", `studio-media://track/${A}%252f${B}`],
    ["a raw backslash", `studio-media://video/${A}\\${B}`],
    ["a backslash walk", `studio-media://track/..\\..\\secret`],
    ["a drive letter", `studio-media://track/C:`],
    ["an absolute path as an id", `studio-media://track//etc/passwd`],
    ["a Windows device name with an extension", `studio-media://track/nul.txt`],
    ["upper case ids", `studio-media://track/AVATAR-0001`],
    ["a mixed-case id", `studio-media://track/Avatar-0001`],
    ["a short id", `studio-media://track/abc`],
    ["an id of 7 characters", `studio-media://track/abcdefg`],
    ["an id of 65 characters", `studio-media://track/${"a".repeat(65)}`],
    ["an extension in the id", `studio-media://track/${A}.m4a`],
    ["an underscore in the id", `studio-media://track/avatar_0001`],
    ["a non-ASCII id", `studio-media://track/аватар-0001`],
    ["a query", `studio-media://track/${A}?x=1`],
    ["an empty query", `studio-media://track/${A}?`],
    ["a fragment", `studio-media://track/${A}#x`],
    ["credentials", `studio-media://user:pw@track/${A}`],
    ["a user without a password", `studio-media://user@track/${A}`],
    ["a port", `studio-media://track:81/${A}`],
    ["a tab inside the URL", `studio-media://tr\tack/${A}`],
    ["a newline inside the URL", `studio-media://track/${A}\n`],
    ["a leading space", ` studio-media://track/${A}`],
    ["a trailing space", `studio-media://track/${A} `],
    ["a NUL byte", `studio-media://track/${A}\0`],
    ["an empty string", ""],
    ["garbage", "not a url"],
    ["a sticker id that is a path", `studio-media://sticker/heart-pulse.apng`],
  ];
  for (const [name, url] of rejected) {
    test(`rejects ${name}`, () => {
      expect(parseMediaRoute(url)).toBeNull();
    });
  }
});
