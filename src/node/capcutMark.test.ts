import { test, expect } from "bun:test";
import { capcutArtworkJson, capcutVideoId } from "./capcutMark";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test("the video id has the shape of a UUID v4", () => {
  expect(capcutVideoId(1_748_000_000_000)).toMatch(UUID_V4);
});

test("the same creation time always yields the same video id", () => {
  expect(capcutVideoId(1_748_000_000_000)).toBe(capcutVideoId(1_748_000_000_000));
});

test("different creation times yield different video ids", () => {
  expect(capcutVideoId(1_748_000_000_000)).not.toBe(capcutVideoId(1_748_000_123_000));
});

test("the artwork JSON is a CapCut-on-mac mark carrying the given video id", () => {
  const parsed: unknown = JSON.parse(capcutArtworkJson("abc"));
  expect(parsed).toMatchObject({
    source_platform: "desktop",
    source_type: "vicut",
    data: { product: "vicut", os: "mac", videoId: "abc", is_use_voice_clone: "0" },
  });
});
