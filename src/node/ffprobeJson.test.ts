import { test, expect } from "bun:test";
import { longestDuration, parseFfprobeJson } from "./ffprobeJson";

const REAL_JPEG = JSON.stringify({
  streams: [
    {
      codec_name: "mjpeg",
      codec_type: "video",
      width: 640,
      height: 480,
      duration: "0.040000",
    },
  ],
  format: { format_name: "image2", duration: "0.040000" },
});

const REAL_CLIP = JSON.stringify({
  streams: [
    { codec_name: "h264", codec_type: "video", width: 320, height: 240, duration: "2.000000" },
    { codec_name: "aac", codec_type: "audio", duration: "2.008000" },
  ],
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "2.008000" },
});

test("reads codec, type and dimensions off a still", () => {
  const { streams } = parseFfprobeJson(REAL_JPEG);
  expect(streams.length).toBe(1);
  expect(streams[0].codecType).toBe("video");
  expect(streams[0].codecName).toBe("mjpeg");
  expect(streams[0].width).toBe(640);
  expect(streams[0].height).toBe(480);
});

test("reads every stream of a clip, audio included", () => {
  const { streams } = parseFfprobeJson(REAL_CLIP);
  expect(streams.map((s) => s.codecType)).toEqual(["video", "audio"]);
});

test("converts ffprobe's string durations to numbers", () => {
  expect(longestDuration(parseFfprobeJson(REAL_CLIP))).toBeCloseTo(2.008, 3);
  expect(longestDuration(parseFfprobeJson(REAL_JPEG))).toBeCloseTo(0.04, 3);
});

// Everything below is the trust boundary: ffprobe output is JSON from another
// process, so none of these may throw or produce a half-built value.

test("returns no streams for output that is not JSON at all", () => {
  expect(parseFfprobeJson("").streams).toEqual([]);
  expect(parseFfprobeJson("not json").streams).toEqual([]);
  expect(parseFfprobeJson("{ truncated").streams).toEqual([]);
});

test("returns no streams for JSON that is not an object", () => {
  expect(parseFfprobeJson("null").streams).toEqual([]);
  expect(parseFfprobeJson("[1,2,3]").streams).toEqual([]);
  expect(parseFfprobeJson('"a string"').streams).toEqual([]);
  expect(parseFfprobeJson("42").streams).toEqual([]);
});

test("returns no streams when the streams key is missing or the wrong shape", () => {
  expect(parseFfprobeJson("{}").streams).toEqual([]);
  expect(parseFfprobeJson('{"streams":null}').streams).toEqual([]);
  expect(parseFfprobeJson('{"streams":"nope"}').streams).toEqual([]);
  expect(parseFfprobeJson('{"streams":{"0":{}}}').streams).toEqual([]);
});

test("survives stream entries that are not objects", () => {
  const { streams } = parseFfprobeJson('{"streams":[null,42,"x",{"codec_type":"video"}]}');
  expect(streams.length).toBe(4);
  expect(streams[0].codecType).toBe("");
  expect(streams[3].codecType).toBe("video");
});

test("reports absent dimensions as null rather than NaN or zero", () => {
  // Zero would read as a real 0x0 image; NaN would poison arithmetic downstream.
  const { streams } = parseFfprobeJson('{"streams":[{"codec_type":"video"}]}');
  expect(streams[0].width).toBeNull();
  expect(streams[0].height).toBeNull();
});

test("rejects dimensions that are not finite numbers", () => {
  const { streams } = parseFfprobeJson(
    '{"streams":[{"codec_type":"video","width":"wide","height":[]}]}'
  );
  expect(streams[0].width).toBeNull();
  expect(streams[0].height).toBeNull();
});

test("reports no duration as zero rather than NaN", () => {
  // A png_pipe input states no duration anywhere.
  const png = '{"streams":[{"codec_name":"png","codec_type":"video","width":8,"height":8}],"format":{"format_name":"png_pipe"}}';
  expect(longestDuration(parseFfprobeJson(png))).toBe(0);
  expect(longestDuration(parseFfprobeJson("garbage"))).toBe(0);
});

test("ignores a non-numeric duration instead of propagating NaN", () => {
  const weird = '{"format":{"duration":"N/A"},"streams":[{"codec_type":"video","duration":"N/A"}]}';
  expect(longestDuration(parseFfprobeJson(weird))).toBe(0);
});

test("takes the longest duration stated anywhere", () => {
  const mixed =
    '{"format":{"duration":"1.0"},"streams":[{"codec_type":"video","duration":"3.5"},{"codec_type":"audio","duration":"2.0"}]}';
  expect(longestDuration(parseFfprobeJson(mixed))).toBeCloseTo(3.5, 3);
});

test("does not inherit properties from the prototype chain", () => {
  // A payload naming __proto__ must not be able to fake a codec type.
  const hostile = '{"streams":[{"__proto__":{"codec_type":"video"}}]}';
  expect(parseFfprobeJson(hostile).streams[0].codecType).toBe("");
});
