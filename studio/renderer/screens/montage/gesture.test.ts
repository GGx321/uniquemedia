import { describe, expect, test } from "bun:test";
import { trackPointer } from "./gesture";

// The timeline's (and since 3d.4 the preview's) window-wide pointer gestures. 3d.5 review LOW: the system can swallow the release
// (⌘Tab while dragging, a menu opening over the window); the next move then arrives with no primary button held, and the gesture
// must end there as cancelled instead of following a pointer the owner already let go.

function moves(): { moved: number[]; ended: (number | null)[]; stop: () => void } {
  const moved: number[] = [];
  const ended: (number | null)[] = [];
  const stop = trackPointer(
    { pointerId: 7 },
    (event) => moved.push(event.clientX),
    (event) => ended.push(event === null ? null : event.clientX),
  );
  return { moved, ended, stop };
}

const send = (type: string, init: PointerEventInit): void => {
  window.dispatchEvent(new PointerEvent(type, { pointerId: 7, ...init }));
};

describe("trackPointer", () => {
  test("a move with the primary button held is the gesture's; the release ends it", () => {
    const { moved, ended } = moves();
    send("pointermove", { clientX: 10, buttons: 1 });
    send("pointermove", { clientX: 20, buttons: 1 });
    send("pointerup", { clientX: 20, buttons: 0 });
    expect(moved).toEqual([10, 20]);
    expect(ended).toEqual([20]);
  });

  test("a move with no primary button held cancels the gesture: the release was swallowed", () => {
    const { moved, ended } = moves();
    send("pointermove", { clientX: 10, buttons: 1 });
    send("pointermove", { clientX: 30, buttons: 0 });
    // Nothing after the cancel reaches the gesture, a late release included.
    send("pointermove", { clientX: 40, buttons: 1 });
    send("pointerup", { clientX: 40 });
    expect(moved).toEqual([10]);
    expect(ended).toEqual([null]);
  });

  test("a move holding only another button is not a drag of the primary one", () => {
    const { moved, ended } = moves();
    send("pointermove", { clientX: 10, buttons: 2 });
    expect(moved).toEqual([]);
    expect(ended).toEqual([null]);
  });

  test("another pointer's moves and releases are not the gesture's", () => {
    const { moved, ended, stop } = moves();
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 8, clientX: 5, buttons: 0 }));
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8, clientX: 5 }));
    expect([moved, ended]).toEqual([[], []]);
    stop();
    expect(ended).toEqual([null]);
  });

  test("pointercancel ends it as cancelled", () => {
    const { ended } = moves();
    send("pointercancel", { clientX: 3 });
    send("pointerup", { clientX: 3 });
    expect(ended).toEqual([null]);
  });
});
