import { test, expect } from "bun:test";
import { cachedFilters } from "./ffmpegExecutor";

/**
 * Which filters ffmpeg has decides how a non-BT.709 source is converted, and
 * an HDR source with no zscale fails the batch. The list is asked once per
 * process — but only an answer is remembered: a spawn that failed once (a
 * busy machine, an antivirus holding the binary) must not leave the whole
 * session believing zscale is missing.
 */

const LISTING = Buffer.from(
  "Filters:\n  T.. = Timeline support\n ---\n .SC zscale            V->V       Apply resizing, colorspace and bit depth conversion.\n" +
    " .S. tonemap           V->V       Conversion to/from different dynamic ranges.\n"
);

test("reads the filter names off the listing", async () => {
  const filters = await cachedFilters(async () => LISTING)();
  expect(filters.has("zscale")).toBe(true);
  expect(filters.has("tonemap")).toBe(true);
  expect(filters.has("colorspace")).toBe(false);
});

test("an answer is remembered: the binary is asked once", async () => {
  let calls = 0;
  const filters = cachedFilters(async () => {
    calls++;
    return LISTING;
  });
  await filters();
  await filters();
  expect(calls).toBe(1);
});

test("a failed listing reports no filters but is asked again next time", async () => {
  let calls = 0;
  const filters = cachedFilters(async () => {
    calls++;
    if (calls === 1) throw new Error("spawn EAGAIN");
    return LISTING;
  });
  expect((await filters()).size).toBe(0);
  expect((await filters()).has("zscale")).toBe(true);
  expect(calls).toBe(2);
});
