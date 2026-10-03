import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { domNodeMatcherUses } from "./domMatchers";

const STUDIO = resolve(import.meta.dir, "..");

function testFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name.startsWith(".") ? [] : testFilesUnder(join(dir, entry.name));
    return /\.test\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [];
  });
}

const uses = (code: string) => domNodeMatcherUses(code).map((use) => use.line);

describe("the detector", () => {
  test("flags a node handed to a matcher that prints its received value", () => {
    expect(uses('expect(screen.queryByText("x")).toBeNull();')).toEqual([1]);
    expect(uses('expect(screen.queryByRole("button", { name: "x" })).toBeUndefined();')).toEqual([1]);
    expect(uses('expect(document.querySelector(".a")).toBe(null);')).toEqual([1]);
    expect(uses("expect(document.activeElement).toBe(button);")).toEqual([1]);
    expect(uses('expect(screen.queryAllByText("x")).toEqual([]);')).toEqual([1]);
    expect(uses('expect(box.queryByText("x")).not.toBe(other);')).toEqual([1]);
    expect(uses('expect(await screen.findByText("x")).toBeNull();')).toEqual([1]);
    expect(uses('expect(el?.closest(".tile")).toBeNull();')).toEqual([1]);
    expect(uses('await waitFor(() => expect(screen.queryByText("x")).toBeNull());')).toEqual([1]);
  });

  test("follows a variable bound to a node in the same file, and flags .children and .body", () => {
    expect(uses('const again = screen.getByRole("button");\nexpect(again).toBe(button);')).toEqual([2]);
    expect(uses('const el = document.querySelector(".a");\nconst same = el;\nexpect(same).toBeNull();')).toEqual([3]);
    expect(uses("expect(list.children).toEqual([]);")).toEqual([1]);
    expect(uses("expect(document.body).toBe(x);")).toEqual([1]);
    expect(uses('const text = box.textContent;\nexpect(text).toBe("x");')).toEqual([]);
    expect(uses("const a = a;\nexpect(a).toBe(1);")).toEqual([]);
  });

  test("leaves a boolean, a text, an attribute and the matchers that never print a node alone", () => {
    expect(uses('expect(screen.queryByText("x") === null).toBe(true);')).toEqual([]);
    expect(uses('expect(screen.queryByText("x") !== null).toBe(true);')).toEqual([]);
    expect(uses('expect(document.querySelector(".a")?.textContent).toBeNull();')).toEqual([]);
    expect(uses('expect(document.querySelector(".a")?.getAttribute("x")).toBe("y");')).toEqual([]);
    expect(uses('expect(screen.getByText("x")).toBeDefined();')).toEqual([]);
    expect(uses('expect(screen.queryByText("x")).not.toBeNull();')).toEqual([]);
    expect(uses('expect(screen.queryByText("x")).toBeTruthy();')).toEqual([]);
    expect(uses('expect(screen.getAllByText("x")).toHaveLength(2);')).toEqual([]); // prints the two lengths, not the nodes
    expect(uses("expect(list.length).toBe(0);")).toEqual([]);
  });

  test("reports the line of each use", () => {
    expect(uses('const a = 1;\n\nexpect(screen.queryByText("x")).toBeNull();\nexpect(a).toBe(1);')).toEqual([3]);
  });
});

// A failing node matcher makes Bun print the node's whole graph without end, which hangs the shard (see domMatchers.ts).
describe("the renderer tests", () => {
  test("never hand a DOM node to a matcher that prints its received value", () => {
    const offenders: string[] = [];
    for (const file of testFilesUnder(STUDIO)) {
      if (file.endsWith("domMatchers.test.ts")) continue;
      for (const use of domNodeMatcherUses(readFileSync(file, "utf8"), file)) offenders.push(`${relative(STUDIO, file)}:${use.line}  ${use.text}`);
    }
    expect(offenders).toEqual([]);
  });
});
