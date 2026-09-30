import { describe, expect, test } from "bun:test";
import { captureConsole, expectNoKeyFragment, fragmentForms, keyFragments } from "./keyLeaks";
import { useNativeGlobals } from "./nativeGlobals";
useNativeGlobals();

// The leak checks are only worth having if they are shown to catch each way a key can get out.

const KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

/** What `expectNoKeyFragment` says about `text`: true when it passes. */
function passes(text: string, key = KEY): boolean {
  try {
    expectNoKeyFragment(text, key);
    return true;
  } catch {
    return false;
  }
}

/** Runs `print` with the console captured; true when the capture is clean of the key. */
function cleanAfter(print: () => void): boolean {
  const output = captureConsole();
  try {
    print();
    return passes(output.text());
  } finally {
    output.restore();
  }
}

describe("keyFragments", () => {
  test("covers the whole key, so a few chars plus the last four are still caught", () => {
    expect(passes(`detail ${KEY.slice(-9)}`)).toBe(false);
    expect(passes(`detail ${KEY.slice(0, 12)}`)).toBe(false);
    expect(passes(`detail ${KEY}`)).toBe(false);
  });

  test("lets the legitimate status through: the last four chars alone", () => {
    expect(passes('{"stored":true,"last4":"0000","rejected":false}')).toBe(true);
  });

  test("gives a fragment set for the shortest keys the contract allows", () => {
    expect(keyFragments("a1b2c3d4").length).toBeGreaterThan(0);
    expect(passes("leaked b2c3d4", "a1b2c3d4")).toBe(false);
  });

  test("throws for a key too short to check, so an assertion never passes by checking nothing", () => {
    expect(() => keyFragments("abc12")).toThrow();
  });

  test("every window holds at least two chars a status never shows", () => {
    for (const fragment of keyFragments(KEY)) expect(fragment.length).toBeGreaterThan(KEY.slice(-4).length);
  });
});

describe("captureConsole", () => {
  test("catches a key in a plain string", () => {
    expect(cleanAfter(() => console.warn(`stored ${KEY}`))).toBe(false);
  });

  test("catches an Error whose message holds the key, passed as an argument (JSON.stringify shows {})", () => {
    expect(JSON.stringify(new Error(KEY))).toBe("{}");
    expect(cleanAfter(() => console.error("a request failed", new Error(`disk full while writing ${KEY}`)))).toBe(false);
  });

  test("catches a Buffer and a Uint8Array of the key, in UTF-8 and UTF-16", () => {
    expect(cleanAfter(() => console.log(Buffer.from(KEY)))).toBe(false);
    expect(cleanAfter(() => console.log(new Uint8Array(Buffer.from(KEY, "utf16le"))))).toBe(false);
  });

  test("catches the key nested in an object, a Map and an Error's own property", () => {
    expect(cleanAfter(() => console.info({ outer: { inner: [KEY] } }))).toBe(false);
    expect(cleanAfter(() => console.info(new Map([["k", KEY]])))).toBe(false);
    expect(cleanAfter(() => console.error(Object.assign(new Error("boom"), { key: KEY })))).toBe(false);
  });

  test("catches the key printed as base64 or hex text, at every alignment inside a longer string", () => {
    const base64 = Buffer.from(KEY).toString("base64");
    expect(cleanAfter(() => console.warn(base64))).toBe(false);
    expect(cleanAfter(() => console.warn(Buffer.from(`k=${KEY}`).toString("base64")))).toBe(false);
    expect(cleanAfter(() => console.warn(Buffer.from(`ke=${KEY}`).toString("base64")))).toBe(false);
    expect(cleanAfter(() => console.warn(Buffer.from(`key=${KEY}`).toString("base64")))).toBe(false);
    expect(cleanAfter(() => console.warn(Buffer.from(KEY).toString("hex")))).toBe(false);
    expect(cleanAfter(() => console.warn(Buffer.from(KEY).toString("base64url")))).toBe(false);
  });

  test("catches an ArrayBuffer holding the key", () => {
    const bytes = new Uint8Array(Buffer.from(KEY));
    expect(cleanAfter(() => console.log(bytes.buffer))).toBe(false);
  });

  test("catches an object that prints as the key through its own toString", () => {
    const sneaky = { toString: () => KEY };
    expect(cleanAfter(() => console.log("%s", sneaky))).toBe(false);
    expect(cleanAfter(() => console.log(`${sneaky}`))).toBe(false);
  });

  test("does not flag a base64 of unrelated bytes", () => {
    expect(cleanAfter(() => console.log(Buffer.from("engine started, nothing to see here").toString("base64")))).toBe(true);
  });

  test.each(["log", "info", "warn", "error", "debug", "trace", "dir", "table"] as const)("captures console.%s", (level) => {
    expect(cleanAfter(() => console[level](KEY))).toBe(false);
  });

  test("passes benign output, and survives a circular value", () => {
    const loop: Record<string, unknown> = { name: "loop" };
    loop.self = loop;
    expect(cleanAfter(() => console.log("engine started", loop, new Error("the engine exited")))).toBe(true);
  });

  test("restores the console", () => {
    const before = console.warn;
    captureConsole().restore();
    expect(console.warn).toBe(before);
  });
});

describe("fragmentForms", () => {
  test("holds each fragment as UTF-8, UTF-16 and hex bytes", () => {
    const names = new Set(fragmentForms(KEY).map((f) => f.name));
    expect([...names].sort()).toEqual(["base64", "hex", "utf16be", "utf16le", "utf8"]);
  });
});
