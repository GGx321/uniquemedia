import { expect, test } from "bun:test";
import { act } from "@testing-library/react";
import { callsOf, flush, setup } from "../testing";

// 3e.3 (K9): the window asks the engine to check the export folder when it comes back to the front, so an unplugged disk shows up
// live. The throttle itself is the store's (store.exportRecheck.test.ts); here is only what wakes it.

function focusWindow(): void {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

test("the window coming back to the front asks the engine to check the export folder", async () => {
  const { engine } = setup();
  await flush();
  expect(callsOf(engine, "export.check")).toHaveLength(0);

  focusWindow();
  await flush();

  expect(callsOf(engine, "export.check")).toHaveLength(1);
});

test("a second focus right after does not ask again", async () => {
  const { engine } = setup();
  await flush();

  focusWindow();
  await flush();
  focusWindow();
  await flush();

  expect(callsOf(engine, "export.check")).toHaveLength(1);
});

test("the window becoming visible again asks too", async () => {
  const { engine } = setup();
  await flush();

  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await flush();

  expect(callsOf(engine, "export.check")).toHaveLength(1);
});

test("a window that is gone asks nothing", async () => {
  const { engine, unmount } = setup();
  await flush();
  unmount();

  focusWindow();
  await flush();

  expect(callsOf(engine, "export.check")).toHaveLength(0);
});
