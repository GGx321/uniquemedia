import { test, expect } from "bun:test";
import { arg, flag, parseStartOptions } from "./cliArgs";
import { createBackends, routeForKind } from "./node/mediaRoute";

/**
 * A bare switch takes no value, so the token after it is whatever comes next
 * on the line — or nothing, when it comes last. A parser that reads "the next
 * token" as the switch's value sees nothing there and treats the switch as
 * absent. `--no-spoof` last on the line spoofed anyway, in silence; every
 * switch is checked in that position here because it is the one that failed.
 */

const route = routeForKind("video", createBackends());

/** argv as the process sees it: runtime, script, input, then the options. */
const line = (...rest: string[]): string[] => ["bun", "cli.ts", "in.mp4", ...rest];

test("--no-spoof last on the line turns spoofing off", () => {
  expect(parseStartOptions(line("--count", "1", "--no-spoof"), route).identity).toBe("engine");
});

test("--keep-audio last on the line keeps the audio", () => {
  expect(parseStartOptions(line("--count", "1", "--keep-audio"), route).keepTrendAudio).toBe(true);
});

test("--mirror last on the line allows the mirror", () => {
  expect(parseStartOptions(line("--count", "1", "--mirror"), route).allowMirror).toBe(true);
});

test("--black-first-frame last on the line turns the black frame on", () => {
  expect(parseStartOptions(line("--count", "1", "--black-first-frame"), route).firstFrame).toBe("black");
});

test("a switch followed by another option is still seen", () => {
  const opts = parseStartOptions(
    line("--no-spoof", "--keep-audio", "--mirror", "--black-first-frame", "--count", "1"),
    route
  );
  expect(opts.identity).toBe("engine");
  expect(opts.keepTrendAudio).toBe(true);
  expect(opts.allowMirror).toBe(true);
  expect(opts.firstFrame).toBe("black");
});

test("switches that are absent take their defaults", () => {
  const opts = parseStartOptions(line("--count", "1"), route);
  expect(opts.identity).toBe("iphone");
  expect(opts.keepTrendAudio).toBe(false);
  expect(opts.allowMirror).toBe(false);
  expect(opts.firstFrame).toBe("off");
  expect(opts.coverPath).toBeNull();
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

/**
 * `--identity` names one of the three modes outright. `--no-spoof` predates
 * it and meant "leave the encoder's signature", which is now `engine`; it
 * stays as an alias so an existing invocation does not break.
 */

test.each(["engine", "iphone", "clean"] as const)("--identity %s asks for that mode", (mode) => {
  expect(parseStartOptions(line("--count", "1", "--identity", mode), route).identity).toBe(mode);
});

test("an absent --identity defaults to iphone, as the switch defaulted to on", () => {
  expect(parseStartOptions(line("--count", "1"), route).identity).toBe("iphone");
});

test("--no-spoof is an alias for --identity engine", () => {
  expect(parseStartOptions(line("--no-spoof"), route).identity).toBe("engine");
});

test("an explicit --identity wins over the --no-spoof alias", () => {
  // The alias is a default for the old spelling, not a veto: a line that
  // names a mode gets that mode.
  expect(parseStartOptions(line("--no-spoof", "--identity", "clean"), route).identity).toBe("clean");
  expect(parseStartOptions(line("--identity", "iphone", "--no-spoof"), route).identity).toBe("iphone");
});

test("--identity rejects a mode it does not know, naming the valid ones", () => {
  const err = (() => {
    try {
      parseStartOptions(line("--identity", "apple"), route);
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  const message = err instanceof Error ? err.message : "";
  expect(message).toContain("apple");
  for (const mode of ["engine", "iphone", "clean"]) expect(message).toContain(mode);
});

/**
 * `--first-frame` names one of the three modes outright. `--black-first-frame`
 * predates it and meant the middle one; it stays as an alias so an existing
 * invocation does not break. `photo` needs a file, and the parser is where a
 * line that asks for one without naming it is refused — before a route is
 * chosen, with the flag to add.
 */

const parseError = (argv: string[]): string => {
  try {
    parseStartOptions(argv, route);
    return "";
  } catch (e: unknown) {
    return e instanceof Error ? e.message : String(e);
  }
};

test.each(["off", "black"] as const)("--first-frame %s asks for that mode", (mode) => {
  const opts = parseStartOptions(line("--count", "1", "--first-frame", mode), route);
  expect(opts.firstFrame).toBe(mode);
  expect(opts.coverPath).toBeNull();
});

test("--first-frame photo with --cover asks for the photo and carries its path", () => {
  const opts = parseStartOptions(line("--first-frame", "photo", "--cover", "/pics/cover.jpg"), route);
  expect(opts.firstFrame).toBe("photo");
  expect(opts.coverPath).toBe("/pics/cover.jpg");
});

test("--cover may come before --first-frame", () => {
  const opts = parseStartOptions(line("--cover", "/pics/cover.jpg", "--first-frame", "photo"), route);
  expect(opts.firstFrame).toBe("photo");
  expect(opts.coverPath).toBe("/pics/cover.jpg");
});

test("--first-frame photo without --cover is refused, naming the flag to add", () => {
  const message = parseError(line("--first-frame", "photo"));
  expect(message).toContain("--cover");
  expect(message).toContain("photo");
});

test("--first-frame photo with --cover last and bare is refused the same way", () => {
  // `arg` reads the token after the flag; a trailing `--cover` has none.
  const message = parseError(line("--first-frame", "photo", "--cover"));
  expect(message).toContain("--cover");
});

test("--cover without --first-frame photo is refused rather than silently ignored", () => {
  // A cover that arrives with no mode to use it would be a flag that does
  // nothing, in silence — the failure every switch test in this file guards.
  const message = parseError(line("--cover", "/pics/cover.jpg"));
  expect(message).toContain("--first-frame photo");
  expect(parseError(line("--black-first-frame", "--cover", "/pics/cover.jpg"))).toContain("--first-frame photo");
});

test("--black-first-frame is an alias for --first-frame black", () => {
  expect(parseStartOptions(line("--black-first-frame"), route).firstFrame).toBe("black");
});

test("an explicit --first-frame wins over the --black-first-frame alias", () => {
  // The alias is a default for the old spelling, not a veto: a line that
  // names a mode gets that mode.
  expect(parseStartOptions(line("--black-first-frame", "--first-frame", "off"), route).firstFrame).toBe("off");
  expect(
    parseStartOptions(line("--first-frame", "photo", "--cover", "/c.jpg", "--black-first-frame"), route).firstFrame
  ).toBe("photo");
});

test("--first-frame rejects a mode it does not know, naming the valid ones", () => {
  const message = parseError(line("--first-frame", "cover"));
  expect(message).toContain("cover");
  for (const mode of ["off", "black", "photo"]) expect(message).toContain(mode);
});
