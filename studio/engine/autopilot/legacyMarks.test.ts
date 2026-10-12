import { describe, expect, test } from "bun:test";
import { PhotoSidecarSchema, type PhotoSidecar } from "../library/schemas";
import { SAMPLE_SOURCE } from "../library/testing/sampleData";
import { legacyMarkedIds, runIdOfAttempt } from "./legacyMarks";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.7b/S5.8a: a photo stored before the face gate wrote `qa.faceMarked` carries a likeness the gate never judged. The mark is restored from the slot the photo was made for, in
// its run's plan: a frame whose face does not show (the phone over it, her legs, a back pose) is marked; a photo with a mark of its own, an imported one and one whose plan is gone are not.

const RUN = "run-aaaa-0001";

function photo(id: string, over: { slot?: string; faceMarked?: true; kind?: "generated" | "imported" } = {}): PhotoSidecar {
  return PhotoSidecarSchema.parse({
    schemaVersion: 1,
    id,
    avatarId: "avatar-aaaa-0001",
    file: `${id}.png`,
    mediaType: "image/png",
    width: 1,
    height: 1,
    bytes: 1,
    sha256: "b".repeat(64),
    source: over.kind === "imported" ? { kind: "imported", importedAt: "2026-09-27T10:00:00.000Z" } : { ...SAMPLE_SOURCE, attemptId: `${RUN}:slot-1#1`, ...(over.slot === undefined ? {} : { slot: over.slot }) },
    qa: over.faceMarked === true ? { faceMarked: true, faceCos: 0.4 } : { faceCos: 0.82 },
    createdAt: "2026-09-27T10:00:00.000Z",
  });
}

const slot = (attemptIdBase: string, over: Record<string, unknown>) => ({ attemptIdBase, shot: "selfie", pose: "front", ...over });
const plansOf = (slots: readonly Record<string, unknown>[]) => (runId: string) => (runId === RUN ? new Map(slots.map((s) => [String(s.attemptIdBase), s as never] as const)) : null);

describe("runIdOfAttempt", () => {
  test("reads the run from a slot's attempt id", () => {
    expect(runIdOfAttempt("run-aaaa-0001:slot-12#3")).toBe("run-aaaa-0001");
    expect(runIdOfAttempt("set-aaaa-0001:writer-1#1")).toBeNull();
  });
});

describe("the marks restored from a plan (S5.7b)", () => {
  test("a photo of a face-hidden frame is marked, one of a frame that shows her face is not", () => {
    const slots = [slot("slot-1", { shot: "mirror", capture: "mirror-hidden" }), slot("slot-2", { shot: "friend" }), slot("slot-3", { pose: "back", shot: "friend" })];
    const photos = [photo("photo-aaaa-0001", { slot: "slot-1" }), photo("photo-aaaa-0002", { slot: "slot-2" }), photo("photo-aaaa-0003", { slot: "slot-3" })];
    expect([...legacyMarkedIds(photos, plansOf(slots))].sort()).toEqual(["photo-aaaa-0001", "photo-aaaa-0003"]);
  });

  test("a photo with a mark of its own, an imported photo, a photo with no slot and one whose plan is gone are left as they were", () => {
    const slots = [slot("slot-1", { shot: "mirror", capture: "mirror-hidden" })];
    const photos = [photo("photo-aaaa-0001", { slot: "slot-1", faceMarked: true }), photo("photo-aaaa-0002", { kind: "imported" }), photo("photo-aaaa-0003"), photo("photo-aaaa-0004", { slot: "slot-1" })];
    expect([...legacyMarkedIds(photos, plansOf(slots))]).toEqual(["photo-aaaa-0004"]);
    expect([...legacyMarkedIds(photos, () => null)]).toEqual([]);
  });

  test("a slot of a shape the planner never wrote marks nothing", () => {
    const photos = [photo("photo-aaaa-0001", { slot: "slot-1" })];
    expect([...legacyMarkedIds(photos, plansOf([slot("slot-1", { shot: "drone", capture: "mirror-hidden" })]))]).toEqual([]);
  });
});

describe("the marks of a legs frame (S5.8a)", () => {
  test.each([
    ["pov-legs", "selfie"],
    ["low-feet", "friend"],
    ["mirror-hidden", "mirror"],
  ])("a photo of a %s legs slot is marked: her face is hidden or may be out of frame", (capture, shot) => {
    const slots = [slot("slot-1", { shot, capture, framing: "legs" })];
    expect([...legacyMarkedIds([photo("photo-aaaa-0001", { slot: "slot-1" })], plansOf(slots))]).toEqual(["photo-aaaa-0001"]);
  });

  test("a legs slot is marked by its framing alone, whatever the capture it is stored with", () => {
    const slots = [slot("slot-1", { shot: "friend", framing: "legs" })];
    expect([...legacyMarkedIds([photo("photo-aaaa-0001", { slot: "slot-1" })], plansOf(slots))]).toEqual(["photo-aaaa-0001"]);
  });

  test("the same slot without the framing and a face-showing capture is not marked", () => {
    const slots = [slot("slot-1", { shot: "friend" })];
    expect([...legacyMarkedIds([photo("photo-aaaa-0001", { slot: "slot-1" })], plansOf(slots))]).toEqual([]);
  });
});
