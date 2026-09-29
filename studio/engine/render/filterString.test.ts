import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertAbsolutePath, assertSafeFilterGraph, quoteExpression } from "./filterString";
import { RenderGraphError } from "./types";
useNativeGlobals();

describe("quoteExpression", () => {
  test("wraps an arithmetic expression in single quotes", () => {
    expect(quoteExpression("(1000*59+100*on)/59000")).toBe("'(1000*59+100*on)/59000'");
  });

  test("keeps commas, which are legal inside a quoted expression", () => {
    expect(quoteExpression("between(n,30,59)")).toBe("'between(n,30,59)'");
  });

  test.each(["a'b", "a\\b", "a;b", "a[b]", "a=b", "a:b", "/tmp/photo", "a//b", "a b", "a\nb", "a$b", "a`b", 'a"b', "a~b"])("refuses %j, which no expression needs", (bad) => {
    expect(() => quoteExpression(bad)).toThrow(RenderGraphError);
  });

  test("refuses an empty expression", () => {
    expect(() => quoteExpression("")).toThrow(RenderGraphError);
  });
});

describe("assertSafeFilterGraph", () => {
  const good =
    "[0:v]scale=in_range=pc:in_color_matrix=bt601:out_range=tv,crop=720:1280:0:0:exact=1,zoompan=z='(1000*59+100*on)/59000':d=60:s=1080x1920:fps=30,setsar=1[v]";

  test("accepts a graph made of numbers, filter names, labels and option names", () => {
    expect(() => assertSafeFilterGraph(good)).not.toThrow();
  });

  test("accepts several chains joined by semicolons", () => {
    expect(() => assertSafeFilterGraph(`${good};[v]null[w]`)).not.toThrow();
  });

  test.each([
    ["a backslash", "[0:v]null\\[v]"],
    ["a double quote", '[0:v]drawtext=text="hi"[v]'],
    ["a dollar sign", "[0:v]null$HOME[v]"],
    ["a backtick", "[0:v]null`id`[v]"],
    ["a newline", "[0:v]null\n[v]"],
    ["a tilde", "[0:v]null~[v]"],
    ["a percent sign", "[0:v]drawtext=text=%{localtime}[v]"],
    ["a non-ASCII letter", "[0:v]nullé[v]"],
    ["a curly brace", "[0:v]drawtext=text={x}[v]"],
  ])("refuses %s", (_name, graph) => {
    expect(() => assertSafeFilterGraph(graph)).toThrow(RenderGraphError);
  });

  test("refuses an empty graph", () => {
    expect(() => assertSafeFilterGraph("")).toThrow(RenderGraphError);
  });

  test("reports the refusal as UNSAFE_GRAPH", () => {
    try {
      assertSafeFilterGraph("a\\b");
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RenderGraphError);
      expect(e instanceof RenderGraphError && e.code).toBe("UNSAFE_GRAPH");
    }
  });
});

describe("assertAbsolutePath", () => {
  test("accepts an absolute posix path", () => {
    expect(() => assertAbsolutePath("/var/tmp/render/clip-00.mkv", "output")).not.toThrow();
  });

  test.each(["clip-00.mkv", "./clip-00.mkv", "../x/clip.mkv", ""])("refuses the relative path %j", (p) => {
    expect(() => assertAbsolutePath(p, "output")).toThrow(RenderGraphError);
  });

  test("refuses a path that would read as an ffmpeg option", () => {
    expect(() => assertAbsolutePath("-i", "input")).toThrow(RenderGraphError);
  });

  test("names what was wrong in the message", () => {
    expect(() => assertAbsolutePath("x.jpg", "the photo path")).toThrow(/the photo path/);
  });

  test("refuses a path holding a NUL byte", () => {
    expect(() => assertAbsolutePath("/tmp/a\0b.jpg", "input")).toThrow(RenderGraphError);
  });
});
