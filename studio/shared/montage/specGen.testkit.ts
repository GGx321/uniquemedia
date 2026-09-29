import type { Cell, Clip, Layer, MontageSpec } from "../engine/montage";
import { pick, randId, randInt } from "./random.testkit";

// A seeded generator of valid MontageSpecs for property-style tests. Every
// spec it makes passes the contract's `MontageSpec` (the tests assert that).

/** Split `units` into `parts` whole numbers, each at least `min`. */
function composition(rand: () => number, units: number, parts: number, min: number): number[] {
  const sizes = Array.from({ length: parts }, () => min);
  let left = units - parts * min;
  while (left > 0) {
    const i = randInt(rand, 0, parts - 1);
    const bite = Math.min(left, randInt(rand, 1, Math.max(1, Math.ceil(left / 2))));
    sizes[i] = (sizes[i] ?? min) + bite;
    left -= bite;
  }
  return sizes;
}

function randomFocus(rand: () => number): { x: number; y: number } | null {
  const roll = rand();
  if (roll < 0.2) return null;
  if (roll < 0.4) return { x: pick(rand, [0, 1, 0.5]), y: pick(rand, [0, 1, 0.38]) };
  return { x: rand(), y: rand() };
}

/** A random valid spec: 1 to 20 clips totalling 4.0 to 15.0 s, up to 6 layers, distinct scene photos. */
export function randomSpec(rand: () => number): MontageSpec {
  const totalUnits = pick(rand, [40, 150, randInt(rand, 40, 150)]);
  const clipCount = randInt(rand, 1, Math.min(20, Math.floor(totalUnits / 5)));
  const durations = composition(rand, totalUnits, clipCount, 5);
  const usedIds = new Set<string>();
  const uniqueId = (): string => {
    for (;;) {
      const id = randId(rand);
      if (!usedIds.has(id)) {
        usedIds.add(id);
        return id;
      }
    }
  };
  const cell = (): Cell => ({ photo: { source: "scene", photoId: uniqueId() }, focus: randomFocus(rand) });

  const clips: Clip[] = durations.map((units) => {
    const base = { clipId: uniqueId(), durationMs: units * 100, transitionIn: "cut" as const };
    const motion = pick(rand, ["kenburns", "pan", "static"] as const);
    const roll = rand();
    if (roll < 0.4) return { ...base, kind: "photo", cell: cell(), motion };
    if (roll < 0.9) {
      const layout = pick(rand, ["collage2", "collage3", "collage4"] as const);
      const count = { collage2: 2, collage3: 3, collage4: 4 }[layout];
      return { ...base, kind: "collage", layout, cells: Array.from({ length: count }, cell), motion, stagger: rand() < 0.6 };
    }
    return { ...base, kind: "video", mediaId: uniqueId(), trimStartMs: randInt(rand, 0, 5) * 100, focus: randomFocus(rand) };
  });

  const layers: Layer[] = [];
  for (let i = 0, n = randInt(rand, 0, 6); i < n; i++) {
    const startUnits = randInt(rand, 0, totalUnits - 3);
    const endUnits = randInt(rand, startUnits + 3, totalUnits);
    const layerBase = { layerId: uniqueId(), startMs: startUnits * 100, endMs: endUnits * 100, x: rand(), y: rand() };
    layers.push(
      rand() < 0.5
        ? { ...layerBase, kind: "text", value: "hello", font: "manrope", style: "plaque", color: "#111111", scale: 1 }
        : { ...layerBase, kind: "sticker", sticker: { source: "builtin", stickerId: uniqueId() }, size: 0.3 },
    );
  }

  return { schemaVersion: 1, avatarId: uniqueId(), clips, layers, music: null, seed: randInt(rand, 0, 4_294_967_295) };
}
