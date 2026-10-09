import { describe, expect, test } from "bun:test";
import type { ExportUnavailableReason } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { within } from "../testing/within";
import { exportGateOf } from "./exportGate";
useNativeGlobals();

// S4.6c2 (plan §4.6, §8.1): the free steps ask one question before a render, «can the export folder take a video of this size?». The answer is the engine's own export check
// (`checkExportRoot` with `requiredBytes`, which refuses `not-enough-space` below 2 x the estimate), told in the shape of `freeHold { export }`.

const gate = (check: () => Promise<{ ok: true } | { ok: false; reason: ExportUnavailableReason }>, freeBytes: () => Promise<number | null> = async () => null) => exportGateOf({ check, freeBytes });

describe("exportGateOf", () => {
  test("a folder that answers ok lets the render go", async () => {
    expect(await gate(async () => ({ ok: true }))({ requiredBytes: 4_500_000 })).toEqual({ ok: true });
  });

  test("the check is asked for the bytes the render needs", async () => {
    const asked: number[] = [];
    await exportGateOf({
      check: async (requiredBytes) => {
        asked.push(requiredBytes);
        return { ok: true };
      },
      freeBytes: async () => null,
    })({ requiredBytes: 4_500_000 });
    expect(asked).toEqual([4_500_000]);
  });

  test.each(["missing", "not-a-directory", "not-writable", "overlaps-library"] as const)("%s refuses with that reason and no figures", async (reason) => {
    expect(await gate(async () => ({ ok: false, reason }), async () => 123)({ requiredBytes: 4_500_000 })).toEqual({ ok: false, exportReason: reason, neededBytes: null, freeBytes: null });
  });

  test("not-enough-space names what the disk must have (twice the estimate, the engine's own floor) and what it has", async () => {
    expect(await gate(async () => ({ ok: false, reason: "not-enough-space" }), async () => 7_000_000)({ requiredBytes: 4_500_000 })).toEqual({
      ok: false,
      exportReason: "not-enough-space",
      neededBytes: 9_000_000,
      freeBytes: 7_000_000,
    });
  });

  test("not-enough-space with a volume that cannot say how much is free keeps the need and leaves the free figure null", async () => {
    expect(await gate(async () => ({ ok: false, reason: "not-enough-space" }), async () => null)({ requiredBytes: 100 })).toMatchObject({ neededBytes: 200, freeBytes: null });
  });

  test("a free-bytes probe that throws is a volume that cannot say", async () => {
    const probe = async (): Promise<number | null> => {
      throw new Error("EIO");
    };
    expect(await gate(async () => ({ ok: false, reason: "not-enough-space" }), probe)({ requiredBytes: 100 })).toMatchObject({ ok: false, freeBytes: null });
  });

  test("M3: a folder that never answers is not-writable after the deadline, as the engine reads it", async () => {
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    const answer = await within(exportGateOf({ check: never, freeBytes: async () => null, timeoutMs: 30 })({ requiredBytes: 100 }), 2_000, "the gate");
    expect(answer).toEqual({ ok: false, exportReason: "not-writable", neededBytes: null, freeBytes: null });
  });

  test("M3: a free-bytes probe that never answers is a volume that cannot say", async () => {
    const never = (): Promise<never> => new Promise<never>(() => undefined);
    const answer = await within(exportGateOf({ check: async () => ({ ok: false, reason: "not-enough-space" }), freeBytes: never, timeoutMs: 30 })({ requiredBytes: 100 }), 2_000, "the gate");
    expect(answer).toEqual({ ok: false, exportReason: "not-enough-space", neededBytes: 200, freeBytes: null });
  });

  test("a check that throws is not an answer: the render is left to the engine's own refusal", async () => {
    const broken = async (): Promise<never> => {
      throw new Error("EIO");
    };
    expect(await gate(broken)({ requiredBytes: 100 })).toEqual({ ok: true });
  });
});
