import { describe, expect, test } from "bun:test";
import { TrimPeekStore, trimPeekFrame } from "./trimPeek";

// 3f.3b fix round 1 (L8): while «Обрезка» is dragged, the preview shows the stored frame at the edge being dragged (the first frame for the window and
// the left edge, the last for the right edge), from what the drag holds, and nothing is written to the draft until it is let go. The strip tells the
// preview through a small store of its own, so the editor does not re-render on every pointer move.

describe("trimPeekFrame", () => {
  test("the window and the left edge show the clip's first frame; the right edge its last", () => {
    expect(trimPeekFrame("start", { startMs: 1_800, durationMs: 2_000 }, 420)).toBe(54);
    expect(trimPeekFrame("end", { startMs: 1_800, durationMs: 2_000 }, 420)).toBe(113);
  });

  test("never past the video's last frame (a clip asking past its end), never before its first", () => {
    expect(trimPeekFrame("end", { startMs: 13_000, durationMs: 2_000 }, 420)).toBe(419);
    expect(trimPeekFrame("start", { startMs: 15_000, durationMs: 500 }, 420)).toBe(419);
    expect(trimPeekFrame("start", { startMs: 0, durationMs: 500 }, 0)).toBe(0);
  });
});

describe("TrimPeekStore", () => {
  test("tells its listeners of a new peek and of its end, not of the same peek again", () => {
    const store = new TrimPeekStore();
    let heard = 0;
    const stop = store.subscribe(() => void (heard += 1));
    expect(store.get()).toBe(null);
    store.set({ clipId: "clip-002", frame: 54 });
    store.set({ clipId: "clip-002", frame: 54 });
    expect(heard).toBe(1);
    expect(store.get()).toEqual({ clipId: "clip-002", frame: 54 });
    store.set({ clipId: "clip-002", frame: 57 });
    store.set(null);
    store.set(null);
    expect(heard).toBe(3);
    stop();
    store.set({ clipId: "clip-002", frame: 1 });
    expect(heard).toBe(3);
  });
});
