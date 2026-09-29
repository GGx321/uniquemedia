import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { parseMaxRssBytes } from "./measureStickerRss";
useNativeGlobals();

describe("parseMaxRssBytes", () => {
  test("reads macOS `time -l` output, which reports bytes", () => {
    const stderr = "        3.21 real         5.10 user         0.40 sys\n   581144576  maximum resident set size\n           0  average shared memory size\n";
    expect(parseMaxRssBytes(stderr)).toBe(581144576);
  });
  test("reads Linux `time -v` output, which reports kilobytes", () => {
    const stderr = "\tElapsed (wall clock) time (h:mm:ss or m:ss): 0:03.21\n\tMaximum resident set size (kbytes): 567400\n";
    expect(parseMaxRssBytes(stderr)).toBe(567400 * 1024);
  });
  test("ignores ffmpeg's own stderr lines around it", () => {
    const stderr = "frame=  450 fps=90 q=-1.0 size=6000kB\nvideo:5800kB audio:0kB\n   123  maximum resident set size\n";
    expect(parseMaxRssBytes(stderr)).toBe(123);
  });
  test("returns undefined when there is no such line", () => {
    expect(parseMaxRssBytes("ffmpeg version 6.0\n")).toBeUndefined();
  });
  test("returns undefined for an empty string", () => {
    expect(parseMaxRssBytes("")).toBeUndefined();
  });
});
