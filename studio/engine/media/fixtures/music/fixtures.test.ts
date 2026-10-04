import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, test } from "bun:test";
import { formatOf } from "../../sniff";
import { ENTRIES } from "./generate";
import { FIXTURE_TAGS, fixtureBytes, musicFixtures } from "./index";

// The own-music fixtures are byte-exact inputs: pinned by size and sha256 (a new encoder build that changes a byte must be a deliberate regeneration),
// small (a few KB, never a real recording), and each is the container it is pinned as.

describe("the music fixtures", () => {
  test.each(Object.entries(musicFixtures))("%s is the file that is pinned: its size and sha256", (_name, fixture) => {
    const bytes = readFileSync(fixture.file);
    expect(bytes.length).toBe(fixture.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(fixture.sha256);
  });

  test.each(Object.entries(musicFixtures))("%s is small: a tone of a few KB, not a recording", (_name, fixture) => {
    expect(statSync(fixture.file).size).toBeLessThan(16 * 1024);
  });

  test.each(Object.entries(musicFixtures))("%s is the container the boundary's sniff names it", (_name, fixture) => {
    expect(formatOf(fixtureBytes(_name as keyof typeof musicFixtures).subarray(0, 64 * 1024))).toBe(fixture.format);
  });

  test("the generator makes exactly the files that are pinned, and the folder holds nothing else of audio", () => {
    expect(ENTRIES.map((entry) => entry.file).sort()).toEqual(Object.values(musicFixtures).map((f) => basename(f.file)).sort());
    const audio = readdirSync(new URL(".", import.meta.url)).filter((name) => !/\.(ts|md)$/.test(name) && name !== ".gitattributes");
    expect(audio.sort()).toEqual(Object.values(musicFixtures).map((f) => basename(f.file)).sort());
  });

  test("the tagged fixtures carry the tag text the importer tests look for, in the bytes", () => {
    for (const name of ["taggedMp3", "taggedM4a"] as const) {
      const text = Buffer.from(fixtureBytes(name)).toString("latin1");
      expect(text).toContain(FIXTURE_TAGS.title);
      expect(text).toContain(FIXTURE_TAGS.artist);
    }
  });
});
