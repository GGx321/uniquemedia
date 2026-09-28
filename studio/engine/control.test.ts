import { describe, expect, test } from "bun:test";
import { EngineCall, HostCall, MainReply, MAX_DECODE_IMAGE_BYTES, MAX_IMPORT_PHOTO_BYTES } from "./control";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T6c review round 2, L3: bytes crossing this boundary must never be
// unbounded — main already caps its own read at the very same number
// (importFlow.ts), but the contract does not trust that it is the only
// possible sender, or that it never regresses.
describe("HostCall: import.stagePhoto's bytes are bounded (L3)", () => {
  const base = { kind: "control" as const, type: "import.stagePhoto" as const, callId: "call-00000001" };

  test("exactly at the cap parses", () => {
    expect(HostCall.safeParse({ ...base, bytes: new Uint8Array(MAX_IMPORT_PHOTO_BYTES) }).success).toBe(true);
  });

  test("one byte over the cap is rejected", () => {
    expect(HostCall.safeParse({ ...base, bytes: new Uint8Array(MAX_IMPORT_PHOTO_BYTES + 1) }).success).toBe(false);
  });
});

// T7b: the one call that goes the OTHER way — engine to main — because the
// face gate needs Electron's nativeImage, which only main has (qa.ts's own
// comment on QaInput.decodeImage has the full reasoning).
describe("EngineCall: image.decode's bytes are bounded, MainReply carries the decoded image or an error", () => {
  const base = { kind: "control" as const, type: "image.decode" as const, callId: "call-00000001" };

  test("exactly at the cap parses", () => {
    expect(EngineCall.safeParse({ ...base, bytes: new Uint8Array(MAX_DECODE_IMAGE_BYTES) }).success).toBe(true);
  });

  test("one byte over the cap is rejected", () => {
    expect(EngineCall.safeParse({ ...base, bytes: new Uint8Array(MAX_DECODE_IMAGE_BYTES + 1) }).success).toBe(false);
  });

  test("rejects any other type on the same discriminant", () => {
    expect(EngineCall.safeParse({ ...base, type: "image.decodeSomethingElse", bytes: new Uint8Array(0) }).success).toBe(false);
  });

  test("MainReply: a successful decode carries the tagged image, no error", () => {
    const reply = { kind: "control" as const, type: "mainReply" as const, callId: "call-00000001", image: { format: "bgra" as const, width: 4, height: 4, data: new Uint8Array(64) } };
    expect(MainReply.safeParse(reply).success).toBe(true);
  });

  test("MainReply: a failed decode carries an error, no image", () => {
    const reply = { kind: "control" as const, type: "mainReply" as const, callId: "call-00000001", error: { code: "VALIDATION" as const, detail: "not a supported image" } };
    expect(MainReply.safeParse(reply).success).toBe(true);
  });
});
