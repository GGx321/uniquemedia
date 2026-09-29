import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { removeDir } from "../render/render.testkit";
import { Findings } from "./boxes";
import { checkEngineLayout } from "./engineLayout";
import { locate, patched, renderFixture, setU32, type Fixture } from "./verify.testkit";
useNativeGlobals();

// The uniquifier's MOV walker as a second opinion (`src/node/movSignature.ts`,
// used read-only), on the ftyp and moov of a real render.

let fx: Fixture;
beforeAll(async () => {
  fx = await renderFixture("verify-layout");
}, 120_000);
afterAll(() => removeDir(fx.dir));

const boxBytes = (bytes: Uint8Array, path: string): Uint8Array => {
  const box = locate(bytes, path);
  return bytes.slice(box.start, box.end);
};
const run = (ftyp: Uint8Array, moov: Uint8Array) => {
  const findings = new Findings();
  checkEngineLayout(ftyp, moov, findings);
  return findings.list;
};

describe("checkEngineLayout", () => {
  test("has nothing to say about the ftyp and moov of a real render", () => {
    expect(run(boxBytes(fx.bytes, "ftyp"), boxBytes(fx.bytes, "moov"))).toEqual([]);
  });

  test("refuses a major brand the muxer never writes, with STRUCTURE_UNRECOGNISED", () => {
    const ftyp = patched(boxBytes(fx.bytes, "ftyp"), (b) => b.set([0x68, 0x65, 0x69, 0x63], 8)); // "heic"
    const [reason] = run(ftyp, boxBytes(fx.bytes, "moov"));
    expect(reason?.code).toBe("STRUCTURE_UNRECOGNISED");
    expect(reason?.message).toContain("brand");
  });

  test("refuses a video sample entry too short to hold its compressor name, with STRUCTURE_UNRECOGNISED", () => {
    const moov = boxBytes(fx.bytes, "moov");
    const stsdAt = locate(fx.bytes, "moov/trak/mdia/minf/stbl/stsd").start - locate(fx.bytes, "moov").start;
    const short = patched(moov, (b) => setU32(b, stsdAt + 16, 40));
    const [reason] = run(boxBytes(fx.bytes, "ftyp"), short);
    expect(reason?.code).toBe("STRUCTURE_UNRECOGNISED");
  });

  test("refuses a moov box that is not there, with STRUCTURE_UNRECOGNISED", () => {
    expect(run(boxBytes(fx.bytes, "ftyp"), new Uint8Array(0))[0]?.code).toBe("STRUCTURE_UNRECOGNISED");
  });
});
