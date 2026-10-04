import { describe, expect, test } from "bun:test";
import { DROP_TTL_MS, trustedDropGate } from "./dropGate";
import { droppedFiles, MAX_DROPPED_FILES } from "./dropped";

// 3f.6 round 2 (the drag-and-drop security review, MEDIUM-2): `importDropped` takes only the files of the LAST TRUSTED drop, once, within 10 s.
// Any `File` that has a path would otherwise do: a page with script could keep a dropped `File` and import it again later with no gesture,
// use a copy of it (the path survives `structuredClone`, a `MessageChannel`, `history.replaceState`), or walk a dropped folder
// (`webkitGetAsEntry`) and import what is inside. The gate lives in the isolated preload: it records `dataTransfer.files` of a drop the
// BROWSER made (`event.isTrusted`), on the window, in the capture phase, before any page handler; the page cannot fake one.

/** A drop event as the browser makes it: its transfer's files, trusted or not (the gate's `isTrusted` is injected: a test can only make untrusted ones). */
function dropEvent(files: File[], trusted = true): Event {
  return Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { files }, trusted });
}

function rig(start = 1_000) {
  let now = start;
  const target = new EventTarget();
  const gate = trustedDropGate(target, { now: () => now, isTrusted: (event) => Reflect.get(event, "trusted") === true });
  return {
    gate,
    drop: (files: File[], trusted = true) => target.dispatchEvent(dropEvent(files, trusted)),
    wait: (ms: number) => {
      now += ms;
    },
  };
}

const files = (...names: string[]): File[] => names.map((name) => new File(["x"], name, { type: "image/jpeg" }));

describe("the last trusted drop's files, once, within 10 s", () => {
  test("a real drop's files pass, as the very objects dropped", () => {
    const { gate, drop } = rig();
    const dropped = files("beach.jpg", "walk.mov");
    drop(dropped);
    const taken = gate.take([...dropped]);
    expect(taken).toHaveLength(2);
    expect(taken[0]).toBe(dropped[0]);
    expect(taken[1]).toBe(dropped[1]);
  });

  test("used once: the same files asked again (a kept File re-imported later) pass nothing", () => {
    const { gate, drop } = rig();
    const dropped = files("beach.jpg");
    drop(dropped);
    expect(gate.take(dropped)).toHaveLength(1);
    expect(gate.take(dropped)).toEqual([]);
  });

  test("a copy of a dropped File (structuredClone, a File made with the same name) is not that File", () => {
    const { gate, drop } = rig();
    const dropped = files("beach.jpg");
    drop(dropped);
    const clone = structuredClone(dropped[0]);
    const lookalike = new File(["x"], "beach.jpg", { type: "image/jpeg" });
    expect(gate.take([clone, lookalike])).toEqual([]);
  });

  test("a drop older than 10 s passes nothing; one just inside passes", () => {
    const stale = rig();
    const old = files("beach.jpg");
    stale.drop(old);
    stale.wait(DROP_TTL_MS + 1);
    expect(stale.gate.take(old)).toEqual([]);
    const fresh = rig();
    const recent = files("beach.jpg");
    fresh.drop(recent);
    fresh.wait(DROP_TTL_MS);
    expect(fresh.gate.take(recent)).toHaveLength(1);
    expect(DROP_TTL_MS).toBe(10_000);
  });

  test("a drop the page made (an untrusted event) is never recorded: its files pass nothing", () => {
    const { gate, drop } = rig();
    const forged = files("beach.jpg");
    drop(forged, false);
    expect(gate.take(forged)).toEqual([]);
  });

  test("only the dropped files pass: one the page adds beside them is left out, and a file asked twice is taken once", () => {
    const { gate, drop } = rig();
    const dropped = files("a.jpg", "b.jpg");
    drop(dropped);
    const other = new File(["y"], "c.jpg");
    const taken = gate.take([dropped[0], other, dropped[0], dropped[1], "a.jpg", null]);
    expect(taken.map((f) => f.name)).toEqual(["a.jpg", "b.jpg"]);
  });

  test("a later drop replaces the earlier one", () => {
    const { gate, drop } = rig();
    const first = files("a.jpg");
    const second = files("b.jpg");
    drop(first);
    drop(second);
    expect(gate.take([...first, ...second]).map((f) => f.name)).toEqual(["b.jpg"]);
  });

  test("the gate listens on the window in the capture phase, before any page handler", () => {
    const added: { type: string; capture: boolean }[] = [];
    trustedDropGate({ addEventListener: (type: string, _listener: unknown, options?: boolean | AddEventListenerOptions) => void added.push({ type, capture: options === true || (typeof options === "object" && options.capture === true) }) });
    expect(added).toEqual([{ type: "drop", capture: true }]);
  });

  test("a drop of more files than are looked at: the rest are counted from the drop's own files", () => {
    const { gate, drop } = rig();
    const many = Array.from({ length: MAX_DROPPED_FILES + 5 }, (_, i) => new File(["x"], `f${i}.jpg`));
    drop(many);
    const mapped = droppedFiles(gate.take(many), { getPathForFile: (file: File) => `/drop/${file.name}` });
    expect(mapped.paths).toHaveLength(MAX_DROPPED_FILES);
    expect(mapped.more).toBe(5);
  });
});
