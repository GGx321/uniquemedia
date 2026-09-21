import { test, expect } from "bun:test";
import { arg, flag, parseStartOptions } from "./cliArgs";
import { createBackends, routeForKind } from "./node/mediaRoute";


const route = routeForKind("video", createBackends());

/** argv as the process sees it: runtime, script, input, then the options. */
const line = (...rest: string[]): string[] => ["bun", "cli.ts", "in.mp4", ...rest];

test("--black-first-frame last on the line turns the black frame on", () => {
  expect(parseStartOptions(line("--count", "1", "--black-first-frame"), route).blackFirstFrame).toBe(true);
});

test("a switch followed by another option is still seen", () => {
  const opts = parseStartOptions(
    line("--no-spoof", "--keep-audio", "--mirror", "--black-first-frame", "--count", "1"),
    route
  );
  expect(opts.spoofMetadata).toBe(false);
  expect(opts.keepTrendAudio).toBe(true);
  expect(opts.allowMirror).toBe(true);
  expect(opts.blackFirstFrame).toBe(true);
});

test("switches that are absent take their defaults", () => {
  const opts = parseStartOptions(line("--count", "1"), route);
  expect(opts.spoofMetadata).toBe(true);
  expect(opts.keepTrendAudio).toBe(false);
  expect(opts.allowMirror).toBe(false);
  expect(opts.blackFirstFrame).toBe(false);
});

test("valued options keep reading the token after them", () => {
  const opts = parseStartOptions(
    line("--strength", "1.4", "--format", "square", "--target", "45", "--edges", "fit"),
    route
  );
  expect(opts.strength).toBe(1.4);
  expect(opts.exportFormat).toBe("square");
  expect(opts.targetDistance).toBe(45);
  expect(opts.edgeMode).toBe("fit");
});

test("a valued option that is absent takes its fallback", () => {
  expect(arg(line(), "count", "5")).toBe("5");
  expect(arg(line(), "format")).toBeUndefined();
});

test("flag reads presence alone", () => {
  expect(flag(line("--mirror"), "mirror")).toBe(true);
  expect(flag(line("--mirror", "x"), "mirror")).toBe(true);
  expect(flag(line(), "mirror")).toBe(false);
});
