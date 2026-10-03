import { isAbsolute } from "node:path";
import { RenderGraphError } from "./types";

// Invariant 16: no text or path in `-filter_complex`. The graph string has a
// strict charset (numbers, filter names, labels, fixed option names and the
// arithmetic of an expression), and photos, stickers and text PNGs reach
// ffmpeg as `-i` inputs addressed by index, never by name inside a filter.
//
// So there is no path escaping here, on purpose: a path in a filter string is
// refused, not escaped. ffmpeg's filter syntax has two nested levels of
// escaping (option values, then the graph), and a refusal cannot be got wrong.

/** What an expression may hold: names, numbers, operators, parentheses, commas. No quote, colon, semicolon, bracket, equals sign, backslash or space. */
const EXPRESSION = /^[A-Za-z0-9_+\-*/().,]+$/;
/** Everything a whole graph may hold: an expression's characters, plus the syntax around it (`[`, `]`, `:`, `;`, `=`, and the quote pair of a quoted expression). */
const GRAPH = /^[A-Za-z0-9_=:;,.+\-*/()[\]']+$/;

/**
 * An expression as a filter option value: single-quoted, so its commas do not
 * end the option. Refuses anything outside the expression charset, a leading
 * `/` and a `//` (which read as a path).
 */
export function quoteExpression(expression: string): string {
  if (!EXPRESSION.test(expression) || expression.startsWith("/") || expression.includes("//")) {
    throw new RenderGraphError("UNSAFE_GRAPH", `an expression may hold only names, numbers, operators, parentheses and commas, got ${JSON.stringify(expression)}`);
  }
  return `'${expression}'`;
}

/**
 * The filters the builder emits, and no others. Anything that can read a file
 * (`movie`, `amovie`, `drawtext` with `textfile`, `lut3d`, `subtitles`, ...)
 * is missing on purpose: a charset alone would let `movie=/etc/passwd` through.
 */
export const ALLOWED_FILTERS: ReadonlySet<string> = new Set([
  "scale", "format", "setparams", "crop", "loop", "settb", "setpts", "zoompan", "fade", "color", "overlay", "setsar", "trim", "fps", "anullsrc", "apad", "atrim",
]);

/** The audio filters of the music chain (3c.5): the same allowlist rule, kept apart from the video list. */
export const ALLOWED_AUDIO_FILTERS: ReadonlySet<string> = new Set(["aresample", "aformat", "asetpts", "volume", "ebur128"]);

const fail = (message: string): never => {
  throw new RenderGraphError("UNSAFE_GRAPH", message);
};

/**
 * Refuses a filter graph that is not the builder's kind: a character outside
 * the strict set, a filter that is not on the allowlist, or a `/` anywhere but
 * inside a quoted expression or in a `settb=1/N` time base.
 */
export function assertSafeFilterGraph(graph: string): void {
  if (!GRAPH.test(graph)) {
    const bad = [...graph].find((c) => !GRAPH.test(c));
    fail(`the filter graph holds a character outside the allowed set: ${JSON.stringify(bad ?? graph)}`);
  }
  // A quote opens an option VALUE and nothing else: it must follow `=` directly (never a key, where ffmpeg
  // would read the value as a file: `zoompan='/z'='f'`), and its body must be a plain expression.
  for (const m of graph.matchAll(/(.?)'([^']*)'/g)) {
    const [, before = "", body = ""] = m;
    if (before !== "=") fail("a quote in the filter graph must follow `=`: a quoted string is an option value, never a key");
    if (!EXPRESSION.test(body) || body.startsWith("/") || body.includes("//")) fail(`a quoted expression holds more than names, numbers, operators and commas: ${JSON.stringify(body)}`);
  }
  // Quoted expressions may hold `,` and `/`; take them out, and the pad labels, before reading the structure.
  const bare = graph.replace(/'[^']*'/g, "Q").replace(/\[[^\]]*\]/g, "");
  for (const filter of bare.split(/[;,]/)) {
    if (filter === "") continue;
    const name = filter.split("=")[0] ?? "";
    if (!ALLOWED_FILTERS.has(name) && !ALLOWED_AUDIO_FILTERS.has(name)) fail(`the filter graph uses a filter the builder does not emit: ${JSON.stringify(name)}`);
  }
  if (bare.replace(/settb=1\/\d+/g, "").includes("/")) fail("the filter graph holds a `/` outside a quoted expression and a settb time base");
}

/** A path handed to ffmpeg must be absolute (so it can never read as an option, and never depends on `cwd`) and free of NUL. */
export function assertAbsolutePath(path: string, what: string): void {
  if (path === "" || path.includes("\0") || path.startsWith("-") || !isAbsolute(path)) {
    throw new RenderGraphError("PATH_NOT_ABSOLUTE", `${what} must be an absolute path`);
  }
}
