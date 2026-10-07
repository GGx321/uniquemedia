import { describe, expect, test } from "bun:test";
import { MAX_CLIPS, type PhotoSummary } from "../../../shared/engine";
import { scenePhoto } from "../../engine/mockEngine.testkit";
import { binFacets, type BinFilter, binTiles, isBuiltInCategory, isFreePhoto, tileAction } from "./bin";
import { addRefusal } from "./clipOps";
import { collageClip, draftSpec, photoClip } from "./testkit";

// 3d.5: the «Фото» tab's bin (Editor.dc.html; P6–P15). Eligible scene photos only, each with the clip it is in (the slot badge);
// one photo → one video (the owner, 2026-09-30, Q1): a photo already in a video, or in a queued or running render, stays visible,
// dimmed, and cannot be added. The chips: «Неиспользованные» (free photos only) and the category.

const ALL: BinFilter = { unusedOnly: false, category: null };

/** Mia's photos: 1 free (home), 2 used (travel), 3 reserved (home), 4 rejected, 5 free (glam), 6 free (travel), 7 not eligible. */
const PHOTOS: PhotoSummary[] = [
  scenePhoto(1),
  scenePhoto(2, { category: "travel", used: true, usedIn: ["video-0000001"] }),
  scenePhoto(3, { reserved: true }),
  scenePhoto(4, { rejected: true, eligible: false }),
  scenePhoto(5, { category: "glam" }),
  scenePhoto(6, { category: "travel" }),
  scenePhoto(7, { eligible: false }),
];
const id = (n: number): string => `photo-mia-${String(n).padStart(4, "0")}`;
/** Photo 6 in clip 1, photo 1 in cell 2 of the collage that is clip 2. */
const SPEC = draftSpec([photoClip(0, id(6)), collageClip(1, [null, id(1)])]);

const shown = (tiles: ReturnType<typeof binTiles>): [number, number | null, string][] => tiles.map((t) => [t.n, t.slot, t.state]);

describe("the bin's tiles", () => {
  test("eligible photos only, numbered in the list's order; each with the clip it is in and whether it can go in", () => {
    expect(shown(binTiles(PHOTOS, SPEC, ALL))).toEqual([
      [1, 2, "placed"],
      [2, null, "used"],
      [3, null, "reserved"],
      [4, null, "free"],
      [5, 1, "placed"],
    ]);
  });

  test("a free photo is eligible and in no video and no render (one photo → one video)", () => {
    expect(PHOTOS.map(isFreePhoto)).toEqual([true, false, false, false, true, true, false]);
    // A record that lists a video is used even when the flag says otherwise.
    expect(isFreePhoto(scenePhoto(8, { usedIn: [] , used: false }))).toBe(true);
  });

  test("«Неиспользованные» keeps the free photos, placed ones included; the numbers stay those of the whole bin", () => {
    expect(shown(binTiles(PHOTOS, SPEC, { unusedOnly: true, category: null }))).toEqual([
      [1, 2, "placed"],
      [4, null, "free"],
      [5, 1, "placed"],
    ]);
  });

  test("a category keeps its own photos; both chips together keep what both allow", () => {
    expect(shown(binTiles(PHOTOS, SPEC, { unusedOnly: false, category: "travel" }))).toEqual([
      [2, null, "used"],
      [5, 1, "placed"],
    ]);
    expect(shown(binTiles(PHOTOS, SPEC, { unusedOnly: true, category: "travel" }))).toEqual([[5, 1, "placed"]]);
    expect(binTiles(PHOTOS, SPEC, { unusedOnly: false, category: "fit" })).toEqual([]);
  });
});

describe("the chips' counts", () => {
  test("«Неиспользованные N» counts the free eligible photos; the categories count what the other chip leaves, in the contract's order", () => {
    expect(binFacets(PHOTOS, ALL)).toEqual({
      unused: 3,
      categories: [
        { category: "home", label: "Дом", count: 2 },
        { category: "travel", label: "Путешествия", count: 2 },
        { category: "glam", label: "Гламур 18+", count: 1 },
      ],
    });
    expect(binFacets(PHOTOS, { unusedOnly: true, category: null }).categories).toEqual([
      { category: "home", label: "Дом", count: 1 },
      { category: "travel", label: "Путешествия", count: 1 },
      { category: "glam", label: "Гламур 18+", count: 1 },
    ]);
  });

  test("a chosen category the other chip empties is still offered (with 0), so the choice never vanishes from under the owner", () => {
    expect(binFacets(PHOTOS, { unusedOnly: true, category: "fit" }).categories.at(-1)).toEqual({ category: "fit", label: "Фитнес", count: 0 });
  });
});

// CS.1: the facets come from the categories the photos actually carry, so a photo of a custom category (or an own scene)
// is never hidden from the bin's category filter.
describe("the chips' counts for custom and own categories", () => {
  const CUSTOM_A = "cat-paris-cafes";
  const CUSTOM_B = "cat-night-market";
  const mixed: PhotoSummary[] = [
    scenePhoto(1),
    scenePhoto(2, { category: CUSTOM_A, categoryName: "Кофейни Парижа" }),
    scenePhoto(3, { category: CUSTOM_B, categoryName: "Ночной рынок" }),
    scenePhoto(4, { category: "own", categoryName: "Своя сцена" }),
    scenePhoto(5, { category: CUSTOM_A, categoryName: "Кофейни Парижа" }),
    scenePhoto(6, { category: "fit" }),
  ];

  test("a custom category is offered with its own label and its count", () => {
    const facets = binFacets(mixed, ALL).categories;
    expect(facets.find((c) => c.category === CUSTOM_A)).toEqual({ category: CUSTOM_A, label: "Кофейни Парижа", count: 2 });
  });

  test("the built-ins come first in the contract's order, then the custom ones and the own scenes by label", () => {
    expect(binFacets(mixed, ALL).categories.map((c) => c.label)).toEqual(["Дом", "Фитнес", "Кофейни Парижа", "Ночной рынок", "Своя сцена"]);
  });

  test("«Своя сцена» is last whatever the custom ones are called, and the built-ins stand apart (CS.7 L1, decision 6)", () => {
    const studio = [...mixed, scenePhoto(7, { category: "cat-mono-studio", categoryName: "Студия ч/б" })];
    const facets = binFacets(studio, ALL).categories;
    expect(facets.map((c) => c.label)).toEqual(["Дом", "Фитнес", "Кофейни Парижа", "Ночной рынок", "Студия ч/б", "Своя сцена"]);
    expect(facets.map((c) => isBuiltInCategory(c.category))).toEqual([true, true, false, false, false, false]);
  });

  test("a category with no photo is not offered", () => {
    expect(binFacets(PHOTOS, ALL).categories.map((c) => c.category)).toEqual(["home", "travel", "glam"]);
  });

  test("choosing a custom category keeps only its photos; the numbers stay those of the whole bin", () => {
    expect(binTiles(mixed, draftSpec([]), { unusedOnly: false, category: CUSTOM_A }).map((t) => t.n)).toEqual([2, 5]);
  });

  test("a renamed category shows the label of its newest photo, the list being newest first", () => {
    const renamed = [scenePhoto(1, { category: CUSTOM_A, categoryName: "Новое имя" }), scenePhoto(2, { category: CUSTOM_A, categoryName: "Старое имя" })];
    expect(binFacets(renamed, ALL).categories).toEqual([{ category: CUSTOM_A, label: "Новое имя", count: 2 }]);
  });

  test("a chosen custom category the other chip empties is still offered, with 0", () => {
    const used = [scenePhoto(1, { category: CUSTOM_A, categoryName: "Кофейни Парижа", used: true, usedIn: ["video-0000001"] })];
    expect(binFacets(used, { unusedOnly: true, category: CUSTOM_A }).categories).toEqual([{ category: CUSTOM_A, label: "Кофейни Парижа", count: 0 }]);
  });

  test("a custom category's own photos are counted per category, never merged with another's", () => {
    const counts = binFacets(mixed, ALL).categories.map((c) => [c.category, c.count]);
    expect(counts).toEqual([
      ["home", 1],
      ["fit", 1],
      [CUSTOM_A, 2],
      [CUSTOM_B, 1],
      ["own", 1],
    ]);
  });
});

describe("what a click on a tile does (P12, P15: the 20-clip cap)", () => {
  const tiles = binTiles(PHOTOS, SPEC, ALL);
  const tile = (n: number) => {
    const found = tiles.find((t) => t.n === n);
    if (found === undefined) throw new Error(`no tile ${n}`);
    return found;
  };
  const target = { clip: 1, cell: 0 };

  test("a placed photo selects its clip; a used or reserved one does nothing; a free one is appended, or fills the empty cell waiting", () => {
    expect(tileAction(tile(1), null, null)).toBe("select");
    expect(tileAction(tile(2), null, null)).toBe("taken");
    expect(tileAction(tile(3), target, null)).toBe("taken");
    expect(tileAction(tile(4), null, null)).toBe("append");
    expect(tileAction(tile(4), target, null)).toBe("fill");
  });

  test("19 clips: a free photo is still appended; 20: the bin is full, but an empty cell can still be filled", () => {
    // Half-second clips, so the 15 s has room to spare and only the cap is at play.
    const clips = (n: number) => Array.from({ length: n }, (_, i) => photoClip(i, `photo-cap-${String(i + 1).padStart(4, "0")}`, 500));
    const nineteen = draftSpec(clips(MAX_CLIPS - 1));
    const twenty = draftSpec(clips(MAX_CLIPS));
    expect(addRefusal(nineteen)).toBe(null);
    expect(tileAction(tile(4), null, addRefusal(nineteen))).toBe("append");
    expect(addRefusal(twenty)).toBe("clip-cap");
    expect(tileAction(tile(4), null, addRefusal(twenty))).toBe("full");
    expect(tileAction(tile(4), target, addRefusal(twenty))).toBe("fill");
    // A placed photo still selects its clip at the cap.
    expect(tileAction(tile(1), null, addRefusal(twenty))).toBe("select");
  });
});
