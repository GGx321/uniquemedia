import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relativePosix } from "../../testing/posixPath";
import { BANKS } from "./banks";
import { BANK_CATEGORIES } from "./banks/types";
import * as template from "./template";

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.4 step 3, I5.56): a clip finds the bank moment of its photo's slot with the template's own lookup. `momentOfSlot` is exported once
// from the template, and the template and the plain sentence call it, so there is one lookup: a clip never reads a moment the photo's sentence did not.

type Lookup = (slot: { category: string; location: string; activity: string }) => unknown;

/** The export, read off the module object so a missing export fails an assertion, not the import. */
const momentOfSlot = (slot: { category: string; location: string; activity: string }): unknown => {
  const lookup = (template as Record<string, unknown>).momentOfSlot;
  if (typeof lookup !== "function") throw new Error("shared/scenes/template.ts exports no momentOfSlot");
  return (lookup as Lookup)(slot);
};

describe("momentOfSlot: the template's own lookup (S5.V5)", () => {
  test("is exported by the template", () => {
    expect(typeof (template as Record<string, unknown>).momentOfSlot).toBe("function");
  });

  test("finds every moment of every bank by its category, place name and text", () => {
    let seen = 0;
    for (const category of BANK_CATEGORIES) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments) {
          expect(momentOfSlot({ category, location: place.name, activity: moment.text })).toBe(moment);
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(250);
  });

  test("finds nothing for a place the bank no longer has (a renamed place)", () => {
    const place = BANKS.home.places[0];
    const moment = place?.moments[0];
    if (place === undefined || moment === undefined) throw new Error("the home bank has no place");
    expect(momentOfSlot({ category: "home", location: `${place.name} renamed`, activity: moment.text })).toBeUndefined();
  });

  test("finds nothing for a moment the place no longer has (a renamed moment)", () => {
    const place = BANKS.home.places[0];
    const moment = place?.moments[0];
    if (place === undefined || moment === undefined) throw new Error("the home bank has no place");
    expect(momentOfSlot({ category: "home", location: place.name, activity: `${moment.text} slowly` })).toBeUndefined();
  });

  test("finds nothing for a custom category or an own scene: neither has a bank", () => {
    const place = BANKS.home.places[0];
    const moment = place?.moments[0];
    if (place === undefined || moment === undefined) throw new Error("the home bank has no place");
    expect(momentOfSlot({ category: "cat-paris-cafes-0001", location: place.name, activity: moment.text })).toBeUndefined();
    expect(momentOfSlot({ category: "own", location: place.name, activity: moment.text })).toBeUndefined();
  });

  test("a moment is looked up only by the category the slot names: the same text in another bank is not found", () => {
    // «lies on her stomach, one arm out» is in «Дом» and in «Ночнушки и бельё»; the place names differ, so a slot of one never finds the other's.
    for (const category of BANK_CATEGORIES) {
      const place = BANKS[category].places[0];
      const moment = place?.moments[0];
      if (place === undefined || moment === undefined) continue;
      const others = BANK_CATEGORIES.filter((other) => other !== category && !BANKS[other].places.some((p) => p.name === place.name && p.moments.some((m) => m.text === moment.text)));
      for (const other of others) expect(momentOfSlot({ category: other, location: place.name, activity: moment.text })).toBeUndefined();
    }
  });
});

/** The production sources of the studio, tests and test kits left out. */
function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testing" || entry.name === "fixtures" ? [] : productionSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/testkit\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("one lookup: no production module walks a bank's moments by text but the template (S5.V5)", () => {
  const studio = join(import.meta.dir, "..", "..");
  const sources = productionSources(studio).map((path) => ({ path: relativePosix(studio, path), text: readFileSync(path, "utf8") }));

  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 I5.73, H1): the same invariant, the one lookup, with its home moved: a moment is found by its text in `bankLookup.ts`, the marker-aware lookup the
  // template's `momentOfSlot` calls, so that the five on the route read their companion. Still exactly one production module.
  test("a moment is found by its text in exactly one production module, the bank lookup the template's momentOfSlot calls", () => {
    const finders = sources.filter((s) => /\.moments\.find\(\s*\(\w+\)\s*=>\s*\w+\.text\s*===/.test(s.text)).map((s) => s.path);
    expect(finders).toEqual(["shared/scenes/bankLookup.ts"]);
    const template = sources.find((s) => s.path === "shared/scenes/template.ts")?.text ?? "";
    expect(template).toMatch(/\bbankPlaceOf\(/);
  });

  // 5a.4 (S5.BA3, 2026-10-26): the plain sentence calls the bank lookup itself (it needs the bank's outfits for the coverage), the very function `momentOfSlot` calls.
  test("the plain sentence calls the bank lookup the template's momentOfSlot calls", () => {
    const plain = sources.find((s) => s.path === "shared/scenes/plain.ts")?.text ?? "";
    expect(plain).toMatch(/\bbankPlaceOf\(/);
  });
});
