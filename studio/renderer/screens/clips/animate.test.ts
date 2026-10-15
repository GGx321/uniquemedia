import { describe, expect, test } from "bun:test";
import { CLIP_REASONS_RU } from "../../../shared/engine";
import type { ClipJobInfo, EngineView, JobView } from "../../engine/store";
import { animateBlock, batchHoldsUnit } from "./animate";

// 5b.2, S5.WB4 (mockup 37e, plan s5b2 I5.61): while a batch holds the clip money unit — from its start until its last member's money closes — «Оживить» and «Оживить выбранные» wait with `batch-running`'s
// words; a single clip holding it still says `one-at-a-time`. The engine refuses the same (IN_FLIGHT); this keeps the window from offering what it would refuse.

let n = 0;
function clip(info: Partial<ClipJobInfo>, patch: Partial<JobView> = {}): JobView {
  const jobId = `job-${String(++n).padStart(8, "0")}`;
  return {
    jobId,
    kind: "clip",
    avatarId: "avatar-nini-0001",
    runId: null,
    montageId: null,
    videoId: null,
    status: "running",
    saving: false,
    done: 0,
    total: 4,
    result: null,
    error: null,
    clip: { clipId: jobId, phase: "preparing", model: null, submittedAt: null, proveUntil: null, recovery: false, export: false, ...info },
    ...patch,
  };
}
const member = (index: number, info: Partial<ClipJobInfo>, patch: Partial<JobView> = {}): JobView => clip({ ...info, batch: { batchId: "batch-0000001", index, size: 4 } }, patch);
const viewOf = (jobs: readonly JobView[]): EngineView => ({ phase: "ready", jobs, settings: null, money: null, engineError: null, notices: [] }) as unknown as EngineView;

describe("a batch holds the clip money unit", () => {
  test("while a member waits its turn, or one is between its dispatch and its money's close", () => {
    expect(batchHoldsUnit(viewOf([member(1, { phase: "rendering", model: "kling" }), member(2, { phase: "queued", waitReason: "turn" })]))).toBe(true);
    expect(batchHoldsUnit(viewOf([member(1, { phase: "downloading" }, { done: 1 }), member(2, { phase: "queued", waitReason: "turn" })]))).toBe(true);
    expect(batchHoldsUnit(viewOf([member(4, { phase: "proving", model: "kling" })]))).toBe(true);
  });

  test("not once its last member's money closed (the download and the save hold no unit), nor after it ended", () => {
    expect(batchHoldsUnit(viewOf([member(4, { phase: "downloading" }, { done: 1 })]))).toBe(false);
    expect(batchHoldsUnit(viewOf([member(4, { phase: "saving" }, { status: "done", done: 4 }), member(3, { phase: "queued", detail: "cancelled" }, { status: "cancelled" })]))).toBe(false);
  });

  test("a single clip is not a batch", () => {
    expect(batchHoldsUnit(viewOf([clip({ phase: "rendering", model: "kling" })]))).toBe(false);
  });
});

describe("why «Оживить» waits", () => {
  test("37e: a batch is running — «Сейчас снимаются клипы пакета — дождитесь окончания или отмените оставшиеся.»", () => {
    expect(animateBlock(viewOf([member(1, { phase: "submitting", model: "kling" }), member(2, { phase: "queued" })]), true)).toEqual({ kind: "batch", text: CLIP_REASONS_RU["batch-running"] });
  });

  test("37b: a single clip still says «Сейчас снимается другой клип…»", () => {
    expect(animateBlock(viewOf([clip({ phase: "submitting", model: "kling" })]), true)).toEqual({ kind: "text", text: CLIP_REASONS_RU["one-at-a-time"] });
  });

  test("nothing holds the unit: no block", () => {
    expect(animateBlock(viewOf([member(4, { phase: "downloading" }, { done: 1 })]), true)).toBeNull();
  });
});
