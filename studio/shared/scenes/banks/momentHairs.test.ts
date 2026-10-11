import { describe, expect, test } from "bun:test";
import { MOMENT_HAIRS } from "./types";

// S5.6R (round D): the hair tags of a moment were listed three times (the type, the bank schema, the engine's pool schema). One constant now.

const SOURCES = ["shared/scenes/banks/types.ts", "shared/scenes/banks/schema.ts", "engine/scenes/pools.ts"];

describe("MOMENT_HAIRS", () => {
  test("lists the four hair tags of a moment", () => {
    expect([...MOMENT_HAIRS]).toEqual(["tied", "sport", "loose", "own"]);
  });

  test("is the only place the tags are listed: the schemas read the constant", async () => {
    const listings: string[] = [];
    for (const path of SOURCES) {
      const text = await Bun.file(new URL(`../../../${path}`, import.meta.url)).text();
      if (/["']tied["'],\s*["']sport["']/.test(text)) listings.push(path);
    }
    expect(listings).toEqual(["shared/scenes/banks/types.ts"]);
  });
});
