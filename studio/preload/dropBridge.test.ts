import { describe, expect, test } from "bun:test";
import { CH } from "./api";
import { dropBridge } from "./dropBridge";
import { type DropGate, trustedDropGate } from "./dropGate";

// 3f.6 round 3 (the drag-and-drop security review, LOW): the preload's `importDropped` must send its files through the drop gate. Without the
// gate, any `File` that has a path would reach main: a kept one re-imported later with no gesture, a copy, a file walked out of a dropped
// folder. The bridge is built here exactly as preload.ts builds it (`dropBridge(ipcRenderer, dropGate, webUtils)`, pinned by preload.test.ts),
// with a fake `ipcRenderer`, a fake `webUtils` and a gate (fake or real over a fake window).

/** A fake `ipcRenderer`: every `invoke` is kept, answered `{ok: true}`. */
function fakeIpc() {
  const calls: { channel: string; args: unknown[] }[] = [];
  return {
    calls,
    invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args });
      return Promise.resolve({ ok: true });
    },
  };
}

/** A fake `webUtils`: the path the OS gave each known `File` (`/Users/me/<name>`); every file it was asked about is kept. */
function fakeWebUtils(known: readonly File[]) {
  const asked: File[] = [];
  return {
    asked,
    getPathForFile(file: File): string {
      asked.push(file);
      return known.includes(file) ? `/Users/me/${file.name}` : "";
    },
  };
}

const files = (...names: string[]): File[] => names.map((name) => new File(["x"], name, { type: "image/jpeg" }));

/** Every path the fake `ipcRenderer` was sent, over all its calls. */
const sentPaths = (ipc: ReturnType<typeof fakeIpc>): unknown[] =>
  ipc.calls.flatMap((call) => call.args.flatMap((arg) => (typeof arg === "object" && arg !== null ? [Reflect.get(arg, "paths")] : []))).flat();

describe("the preload's importDropped sends its files through the drop gate", () => {
  test("the files go to the gate as asked, and only what the gate gives back reaches webUtils and ipcRenderer.invoke", async () => {
    const [kept, stranger] = files("kept.jpg", "stranger.jpg");
    if (kept === undefined || stranger === undefined) throw new Error("no files");
    const asked: unknown[] = [];
    const gate: DropGate = {
      take(given) {
        asked.push(given);
        return [kept];
      },
    };
    const ipc = fakeIpc();
    const webUtils = fakeWebUtils([kept, stranger]);
    const importDropped = dropBridge(ipc, gate, webUtils);
    const given = [kept, stranger];
    await importDropped(given);
    expect(asked).toHaveLength(1);
    expect(asked[0] === given).toBe(true);
    expect(webUtils.asked.includes(stranger)).toBe(false);
    expect(ipc.calls).toEqual([{ channel: CH.importDropped, args: [{ paths: ["/Users/me/kept.jpg"], more: 0 }] }]);
  });

  test("a gate that gives nothing back: main is still answered, with no path at all", async () => {
    const ipc = fakeIpc();
    const webUtils = fakeWebUtils(files("any.jpg"));
    await dropBridge(ipc, { take: () => [] }, webUtils)(files("a.jpg", "b.jpg"));
    expect(webUtils.asked).toHaveLength(0);
    expect(ipc.calls).toEqual([{ channel: CH.importDropped, args: [{ paths: [], more: 0 }] }]);
  });
});

describe("with the real gate over a window: a File not from the last trusted drop never reaches ipcRenderer.invoke", () => {
  /** The real gate over a fake window; a test can only make untrusted events, so the gate's `isTrusted` reads a flag the test sets. */
  function rig() {
    const target = new EventTarget();
    const gate = trustedDropGate(target, { now: () => 1_000, isTrusted: (event) => Reflect.get(event, "trusted") === true });
    const drop = (dropped: File[], trusted = true): void => {
      target.dispatchEvent(Object.assign(new Event("drop", { bubbles: true, cancelable: true }), { dataTransfer: { files: dropped }, trusted }));
    };
    return { gate, drop };
  }

  test("a real drop's files pass; a file the drop did not carry, asked along with them, never does", async () => {
    const { gate, drop } = rig();
    const dropped = files("beach.jpg", "walk.mov");
    const [stranger] = files("secret.pdf");
    if (stranger === undefined) throw new Error("no file");
    const ipc = fakeIpc();
    const webUtils = fakeWebUtils([...dropped, stranger]);
    drop(dropped);
    await dropBridge(ipc, gate, webUtils)([...dropped, stranger]);
    expect(sentPaths(ipc)).toEqual(["/Users/me/beach.jpg", "/Users/me/walk.mov"]);
    expect(webUtils.asked.includes(stranger)).toBe(false);
  });

  test("a kept File re-imported, a copy of it, a file only an untrusted drop carried: none reaches ipcRenderer.invoke", async () => {
    const { gate, drop } = rig();
    const [photo] = files("beach.jpg");
    const [planted] = files("planted.jpg");
    if (photo === undefined || planted === undefined) throw new Error("no files");
    const clone = structuredClone(photo);
    const ipc = fakeIpc();
    const webUtils = fakeWebUtils([photo, planted, clone]);
    const importDropped = dropBridge(ipc, gate, webUtils);
    drop([photo]);
    await importDropped([photo]);
    // The same File again, with no new drop (one-shot); a structured clone of it; a file a page's own (untrusted) drop event carried.
    await importDropped([photo]);
    await importDropped([clone]);
    drop([planted], false);
    await importDropped([planted]);
    expect(ipc.calls).toHaveLength(4);
    expect(sentPaths(ipc)).toEqual(["/Users/me/beach.jpg"]);
    expect(webUtils.asked.every((file) => file === photo)).toBe(true);
  });
});
