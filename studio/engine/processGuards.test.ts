import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeError, installProcessGuards } from "./processGuards";
import { expectNoKeyFragment } from "../testing/keyLeaks";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// A key shaped like no real one, so a scan for its fragments cannot match anything else.
const KEY = "Zq7-fake-key-M4xk-91Bd-NotReal";
const SECRET = `/Users/owner/library/photo.jpg ${KEY}`;

function rig(role: "engine" | "main", log?: (line: string) => void, onRejection?: () => void) {
  const target = new EventEmitter();
  const on = (event: "unhandledRejection" | "uncaughtException", listener: (error: unknown) => void): unknown => target.on(event, listener);
  const lines: string[] = [];
  const exits: number[] = [];
  const write = log ?? ((line: string) => void lines.push(line));
  const base = { on, log: write, ...(onRejection === undefined ? {} : { onRejection }) };
  installProcessGuards(role === "engine" ? { ...base, role, exit: (code) => void exits.push(code) } : { ...base, role });
  return { target, lines, exits };
}

describe("describeError: the class and a plain code, never the text", () => {
  test("the class name, and the code when it is an upper-case token", () => {
    expect(describeError(new TypeError(SECRET))).toBe("TypeError");
    expect(describeError(Object.assign(new Error(SECRET), { code: "ENOENT" }))).toBe("Error (ENOENT)");
    expect(describeError(Object.assign(new RangeError("x"), { code: "ERR_OUT_OF_RANGE" }))).toBe("RangeError (ERR_OUT_OF_RANGE)");
  });

  test("a code that is not a plain token (it could carry text) and a hostile class name are dropped", () => {
    expect(describeError(Object.assign(new Error("x"), { code: `EACCES ${SECRET}` }))).toBe("Error");
    expect(describeError(Object.assign(new Error("x"), { code: 42 }))).toBe("Error");
    const named = new Error("x");
    named.name = SECRET;
    expect(describeError(named)).toBe("Error");
  });

  test("an error whose name or code getter throws is reported as unknown, and the handler still runs", () => {
    const hostile = new Error("x");
    Object.defineProperty(hostile, "name", {
      get() {
        throw new Error("no name for you");
      },
    });
    expect(describeError(hostile)).toBe("unknown");
    const codeless = Object.defineProperty(new Error("x"), "code", {
      get() {
        throw new Error("no code for you");
      },
    });
    expect(describeError(codeless)).toBe("unknown");
    const { target, lines, exits } = rig("engine");
    expect(() => target.emit("uncaughtException", hostile)).not.toThrow();
    expect(lines).toEqual(["studio engine: an uncaught exception (unknown); the engine exits so main restarts it"]);
    expect(exits).toEqual([1]);
  });

  test("anything that is not an Error is named by its type alone", () => {
    expect(describeError(SECRET)).toBe("string");
    expect(describeError(undefined)).toBe("undefined");
    expect(describeError({ message: SECRET })).toBe("object");
    expect(describeError(null)).toBe("object");
  });
});

describe("the engine's policy", () => {
  test("an unhandled rejection is logged by kind and the engine does not exit", () => {
    const { target, lines, exits } = rig("engine");
    target.emit("unhandledRejection", new Error(SECRET), Promise.resolve());
    expect(lines).toEqual(["studio engine: an unhandled promise rejection (Error); the engine keeps running"]);
    expect(exits).toEqual([]);
  });

  test("an uncaught exception is logged by kind and the engine exits with 1, once per event", () => {
    const { target, lines, exits } = rig("engine");
    target.emit("uncaughtException", Object.assign(new TypeError(SECRET), { code: "ERR_X" }), "uncaughtException");
    expect(lines).toEqual(["studio engine: an uncaught exception (TypeError (ERR_X)); the engine exits so main restarts it"]);
    expect(exits).toEqual([1]);
  });

  test("a throwing log still exits: the exit does not depend on the log", () => {
    const { target, exits } = rig("engine", () => {
      throw new Error("the log is broken");
    });
    expect(() => target.emit("uncaughtException", new Error("boom"))).not.toThrow();
    expect(exits).toEqual([1]);
  });

  test("a throwing log does not turn a rejection into another error", () => {
    const { target, exits } = rig("engine", () => {
      throw new Error("the log is broken");
    });
    expect(() => target.emit("unhandledRejection", new Error("boom"))).not.toThrow();
    expect(exits).toEqual([]);
  });

  test("no line carries the message, the stack or a path", () => {
    const { target, lines } = rig("engine");
    target.emit("unhandledRejection", new Error(SECRET));
    target.emit("uncaughtException", new Error(SECRET));
    target.emit("unhandledRejection", SECRET);
    for (const line of lines) {
      expectNoKeyFragment(line, KEY);
      expect(line).not.toContain("Users");
      expect(line).not.toContain("photo.jpg");
      expect(line).not.toContain(" at ");
    }
    expect(lines).toHaveLength(3);
  });
});

describe("telling the windows (the engine's rejection notice)", () => {
  test("a swallowed rejection calls onRejection once, after its log line, with no argument: nothing of the error can travel", () => {
    const order: string[] = [];
    const calls: unknown[][] = [];
    const { target } = rig("engine", (line) => order.push(line), (...args: unknown[]) => {
      order.push("notice");
      calls.push(args);
    });
    target.emit("unhandledRejection", new Error(SECRET));
    expect(order).toEqual(["studio engine: an unhandled promise rejection (Error); the engine keeps running", "notice"]);
    expect(calls).toEqual([[]]);
  });

  test("an uncaught exception does not call it: the engine exits and main's restart notice speaks", () => {
    let told = 0;
    const { target, exits } = rig("engine", undefined, () => void told++);
    target.emit("uncaughtException", new Error(SECRET));
    expect(told).toBe(0);
    expect(exits).toEqual([1]);
  });

  test("a throwing onRejection is swallowed: the rejection stays handled", () => {
    const { target, lines } = rig("engine", undefined, () => {
      throw new Error("the notice broke");
    });
    expect(() => target.emit("unhandledRejection", new Error("boom"))).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  test("without onRejection nothing else happens", () => {
    const { target, lines } = rig("main");
    target.emit("unhandledRejection", new Error("boom"));
    expect(lines).toHaveLength(1);
  });
});

describe("main's policy", () => {
  test("an unhandled rejection is logged by kind, nothing more", () => {
    const { target, lines } = rig("main");
    target.emit("unhandledRejection", new Error(SECRET));
    expect(lines).toEqual(["studio main: an unhandled promise rejection (Error); the main keeps running"]);
  });

  test("an uncaught exception is logged by kind and main goes on: it has no way to exit, and no dialog is raised from here", () => {
    const { target, lines } = rig("main");
    expect(() => target.emit("uncaughtException", new TypeError(SECRET))).not.toThrow();
    expect(lines).toEqual(["studio main: an uncaught exception (TypeError); main keeps running"]);
  });

  test("the handlers are installed once per event: no second listener appears", () => {
    const { target } = rig("main");
    expect(target.listenerCount("unhandledRejection")).toBe(1);
    expect(target.listenerCount("uncaughtException")).toBe(1);
  });
});

describe("in a real process", () => {
  const CHILD = join(import.meta.dirname, "testing", "processGuardsChild.ts");

  async function run(mode: string): Promise<{ code: number; stdout: string; stderr: string }> {
    const child = Bun.spawn([process.execPath, "--no-env-file", CHILD, mode], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { code, stdout, stderr };
  }

  test("an unhandled rejection is reported and the process carries on to a clean exit", async () => {
    const { code, stdout, stderr } = await run("reject");
    expect(code).toBe(0);
    expect(stdout).toContain("still running");
    expect(stderr).toContain("studio engine: an unhandled promise rejection (Error); the engine keeps running");
    expectNoKeyFragment(stderr, KEY);
    expect(stderr).not.toContain("photo.jpg");
  });

  test("an uncaught exception is reported and the process exits with 1 well before its own 3 s exit", async () => {
    const started = performance.now();
    const { code, stdout, stderr } = await run("throw");
    expect(code).toBe(1);
    expect(stdout).not.toContain("still running");
    expect(stderr).toContain("studio engine: an uncaught exception (TypeError (ERR_SOMETHING)); the engine exits so main restarts it");
    expectNoKeyFragment(stderr, KEY);
    expect(stderr).not.toContain("photo.jpg");
    expect(performance.now() - started).toBeLessThan(2_900);
  }, 30_000);
});

describe("both entries install the guards", () => {
  const read = (path: string): string => readFileSync(join(import.meta.dirname, "..", path), "utf8");

  test("the engine's entry installs them as the engine, with process.exit as its exit and the notice wired to the engine", () => {
    const source = read("engine/main.ts");
    expect(source).toMatch(/installProcessGuards\(\{ on: \(event, listener\) => \{ process\.on\(event, \(error\) => listener\(error\)\); \}, role: "engine", log: console\.error, exit: \(code\) => process\.exit\(code\), onRejection: \(\) => guardNotice\.notify\(\) \}\);/);
    expect(source).toContain("guardNotice.notify = () => engine.noteUnhandledRejection();");
  });

  test("main's entry installs them as main, with no exit", () => {
    const source = read("main/main.ts");
    expect(source).toMatch(/installProcessGuards\(\{ on: \(event, listener\) => \{ process\.on\(event, \(error\) => listener\(error\)\); \}, role: "main", log: console\.error \}\);/);
    expect(source).not.toMatch(/role: "main"[^)]*exit/);
  });
});
