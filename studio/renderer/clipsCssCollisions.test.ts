import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// S5.V8 fix round 1: clips.css is imported last, so a class it defines that another stylesheet already defines restyles that other screen (the clips tile's
// `.clip-poster` once repainted the montage's video cards and the drafts' thumbnails). A static guard: no selector of it may be made ONLY of classes another renderer stylesheet names (a selector with one class of its own is scoped by it).

const RENDERER = import.meta.dir;
const OWN = "clips.css";

/** Selectors of clips.css that are MEANT to restyle a class another stylesheet owns. Empty on purpose: add a name here only with the reason next to it. */
const SHARED_ON_PURPOSE = new Set<string>([]);

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** The selector text of every style rule in `css` (at-rule preludes and declaration blocks left out). */
function selectors(css: string): string[] {
  const out: string[] = [];
  const code = stripComments(css);
  const re = /([^{}]+)\{/g;
  for (const match of code.matchAll(re)) {
    const prelude = (match[1] ?? "").trim();
    if (prelude === "" || prelude.startsWith("@")) continue;
    out.push(prelude);
  }
  return out;
}

/** Every class named anywhere in `css`'s selectors. */
export function classesNamed(css: string): Set<string> {
  const names = new Set<string>();
  for (const selector of selectors(css)) for (const m of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) if (m[1]) names.add(m[1]);
  return names;
}

/**
 * The selectors of `css` made of classes that `others` already names, and nothing of their own: such a rule restyles the other stylesheet's element
 * (`.clip-poster { }`). A selector with one class of its own is scoped by it (`.notice-text .notice-clip`, `.clip-sheet-photo > .portrait`).
 */
export function restylingSelectors(css: string, others: Set<string>): string[] {
  const found: string[] = [];
  for (const selector of selectors(css)) {
    for (const part of selector.split(",")) {
      const names = [...part.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? "");
      if (names.length > 0 && names.every((name) => others.has(name))) found.push(part.trim());
    }
  }
  return found;
}

function cssFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...cssFiles(path));
    else if (entry.name.endsWith(".css")) found.push(path);
  }
  return found;
}

describe("the helpers read selectors", () => {
  test("flags a selector made only of classes the other stylesheet names", () => {
    const css = "/* .ghost { } */ .a .b, .c:hover > .d { color: red; } .shared > .x { top: 0 }";
    expect(restylingSelectors(css, new Set(["a", "b", "shared"]))).toEqual([".a .b"]);
  });
  test("leaves a selector scoped by a class of its own", () => {
    expect(restylingSelectors(".mine .shared { x: y }", new Set(["shared"]))).toEqual([]);
  });
  test("names every class of every selector, comments and at-rule preludes left out", () => {
    expect([...classesNamed("@media (x) { .a .b, .c:has(> .d) { x: y } } /* .z {} */")].sort()).toEqual(["a", "b", "c", "d"]);
  });
});

describe("clips.css does not restyle another screen", () => {
  test("no selector of it is made only of classes another renderer stylesheet names", () => {
    const own = readFileSync(join(RENDERER, OWN), "utf8");
    const others = new Set<string>();
    for (const file of cssFiles(RENDERER)) {
      if (file !== join(RENDERER, OWN)) for (const name of classesNamed(readFileSync(file, "utf8"))) others.add(name);
    }
    const clashes = restylingSelectors(own, others).filter((selector) => !SHARED_ON_PURPOSE.has(selector));
    expect(clashes).toEqual([]);
  });
});
