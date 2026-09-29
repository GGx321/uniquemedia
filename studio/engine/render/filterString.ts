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

/** Refuses a filter graph string with any character outside the strict set. */
export function assertSafeFilterGraph(graph: string): void {
  if (!GRAPH.test(graph)) {
    const bad = [...graph].find((c) => !GRAPH.test(c));
    throw new RenderGraphError("UNSAFE_GRAPH", `the filter graph holds a character outside the allowed set: ${JSON.stringify(bad ?? graph)}`);
  }
}

/** A path handed to ffmpeg must be absolute (so it can never read as an option, and never depends on `cwd`) and free of NUL. */
export function assertAbsolutePath(path: string, what: string): void {
  if (path === "" || path.includes("\0") || path.startsWith("-") || !isAbsolute(path)) {
    throw new RenderGraphError("PATH_NOT_ABSOLUTE", `${what} must be an absolute path, got ${JSON.stringify(path)}`);
  }
}
