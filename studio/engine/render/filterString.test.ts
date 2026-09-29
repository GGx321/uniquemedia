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
    expect(() => assertSafeFilterGraph(`${good};[v]setsar=1[w]`)).not.toThrow();
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

  test.each([
    ["movie", "movie=/Users/alex/secret.png[v]"],
    ["amovie", "amovie=/Users/alex/secret.wav[a]"],
    ["drawtext", "[0:v]drawtext=textfile=/etc/passwd[v]"],
    ["lut3d", "[0:v]lut3d=file=/tmp/x.cube[v]"],
    ["subtitles", "[0:v]subtitles=/tmp/x.srt[v]"],
    ["a filter name in another case", "[0:v]Scale=1:1[v]"],
    ["a name that only starts like an allowed one", "[0:v]scalefile=1[v]"],
    ["a filter hidden after an allowed one in the same chain", "[0:v]scale=1:1,movie=x[v]"],
  ])("refuses %s, which is not a filter the builder emits", (_name, graph) => {
    expect(() => assertSafeFilterGraph(graph)).toThrow(RenderGraphError);
  });

  test.each(["scale", "format", "setparams", "crop", "loop", "settb", "setpts", "zoompan", "fade", "color", "overlay", "setsar", "trim", "fps", "anullsrc", "apad", "atrim"])(
    "accepts the filter %s, which the builder emits",
    (name) => {
      expect(() => assertSafeFilterGraph(`[0:v]${name}=1[v]`)).not.toThrow();
    },
  );

  test("refuses a slash outside a quoted expression, where a path would sit", () => {
    expect(() => assertSafeFilterGraph("[0:v]scale=w=/tmp/x[v]")).toThrow(RenderGraphError);
    expect(() => assertSafeFilterGraph("[0:v]scale=1/2:1[v]")).toThrow(RenderGraphError);
  });

  test("accepts the time base 1/N and a slash inside a quoted expression", () => {
    expect(() => assertSafeFilterGraph("[0:v]settb=1/30,zoompan=z='(1+on)/59000':d=1[v]")).not.toThrow();
  });

  test.each([
    ["a quoted key that starts with a slash (ffmpeg reads the value as a file)", "[0:v]zoompan='/z'='f'[v]"],
    ["a quoted key and value in one string", "[0:v]zoompan='/z=f'[v]"],
    ["a quoted value that starts with a slash", "[0:v]zoompan=z='/etc/passwd'[v]"],
    ["a quote after a colon, which makes it a key", "[0:v]zoompan=z='1':'x'='2'[v]"],
    ["a quote right after the filter name's comma", "[0:v]scale=w=1,'h'=2[v]"],
    ["a quoted value holding a double slash", "[0:v]zoompan=z='a//b'[v]"],
  ])("refuses %s", (_name, graph) => {
    expect(() => assertSafeFilterGraph(graph)).toThrow(RenderGraphError);
  });

  test("accepts a quoted value right after an equals sign, the only place a quote belongs", () => {
    expect(() => assertSafeFilterGraph("[0:v]zoompan=z='(1+on)/59':x='iw/2'[v]")).not.toThrow();
  });

  test("refuses an allowed filter name inside quotes being used to smuggle a second filter", () => {
    expect(() => assertSafeFilterGraph("[0:v]scale=w='1',movie=/x[v]")).toThrow(RenderGraphError);
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
