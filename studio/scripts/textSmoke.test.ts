import { describe, expect, test } from "bun:test";
import { EMOJI_FONT, TEXT_FONTS } from "../engine/text/fonts";
import { TEXT_RASTERISER_READY_PREFIX } from "../engine/text/load";
import { SELF_TEST_FINGERPRINT } from "../engine/text/selfTest";
import { textAssetPackageProblems, textRasteriserOutputProblems } from "./textSmoke";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

const READY = `${TEXT_RASTERISER_READY_PREFIX}${SELF_TEST_FINGERPRINT}`;

describe("textRasteriserOutputProblems", () => {
  test("finds none when the engine reported the pinned fingerprint", () => {
    expect(textRasteriserOutputProblems(`noise\n${READY}\nmore noise\n`)).toEqual([]);
  });

  test("finds none when a CRLF line ending follows the fingerprint (Windows)", () => {
    expect(textRasteriserOutputProblems(`${READY}\r\n`)).toEqual([]);
  });

  test("reports a missing ready line", () => {
    expect(textRasteriserOutputProblems("studio: something else\n")).toEqual(["the engine never reported the text rasteriser as ready"]);
  });

  test("reports a fingerprint that is not the pinned one, naming both", () => {
    const problems = textRasteriserOutputProblems(`${TEXT_RASTERISER_READY_PREFIX}0123456789abcdef\n`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("0123456789abcdef");
    expect(problems[0]).toContain(SELF_TEST_FINGERPRINT);
  });

  test("reports the engine's own load failure line even beside a ready line", () => {
    const failure = "studio engine: the text rasteriser could not be loaded (WASM_UNAVAILABLE: x); text rendering is unavailable until this is fixed";
    const problems = textRasteriserOutputProblems(`${READY}\n${failure}\n`);
    expect(problems.some((p) => p.includes("could not be loaded"))).toBe(true);
  });

  test("does not accept a fingerprint that only starts with the pinned one", () => {
    expect(textRasteriserOutputProblems(`${READY}ff\n`)).toHaveLength(1);
  });

  test("reads the ready line of the last engine start when the engine restarted", () => {
    expect(textRasteriserOutputProblems(`${TEXT_RASTERISER_READY_PREFIX}0123456789abcdef\n${READY}\n`)).toEqual([]);
  });
});

describe("textAssetPackageProblems", () => {
  const wanted = [
    "/out-studio/engine/wasm/index_bg.wasm",
    ...[...Object.values(TEXT_FONTS), EMOJI_FONT].flatMap((f) => [`/out-studio/engine/fonts/${f.file}`, `/out-studio/engine/fonts/${f.license}`]),
  ];

  test("finds none when the asar holds the wasm, the six fonts and the six licences", () => {
    expect(textAssetPackageProblems(wanted)).toEqual([]);
  });

  test("names each missing file", () => {
    const problems = textAssetPackageProblems(wanted.filter((p) => !p.endsWith("Oswald-OFL.txt") && !p.endsWith("index_bg.wasm")));
    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("Oswald-OFL.txt");
    expect(problems.join("\n")).toContain("index_bg.wasm");
  });

  test("counts a lookalike path as missing", () => {
    expect(textAssetPackageProblems([...wanted.slice(1), "/out-studio/engine/index_bg.wasm"])).toHaveLength(1);
  });
});
