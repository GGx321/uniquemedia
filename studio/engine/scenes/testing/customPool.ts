import type { CategorySnapshot } from "../../../shared/engine";
import type { Pool } from "../pools";

// A small custom category for tests that plan, write or run a custom category
// (CS.1). It only has to satisfy what a pool is: places with times and a
// one-handed activity each, a mirror place, outfits and a five-shot deck.

export const CUSTOM_REF = "cat-paris-cafes";

export const CUSTOM_POOL: Pool = {
  locations: [
    { name: "a corner cafe in Paris", times: ["morning", "midday"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "stirring a coffee with both hands", twoHanded: true }] },
    { name: "a Paris bakery counter", times: ["morning"], activities: [{ text: "choosing a croissant", twoHanded: false }], mirror: true },
    { name: "a bridge over the Seine", times: ["golden hour", "evening"], activities: [{ text: "leaning on the railing", twoHanded: false }] },
    { name: "a flower stall", times: ["midday"], activities: [{ text: "smelling a bouquet", twoHanded: false }] },
    { name: "a tiny bookshop", times: ["midday", "evening"], activities: [{ text: "browsing a shelf", twoHanded: false }] },
  ],
  outfits: ["a beige trench coat and jeans", "a striped knit top and a midi skirt", "a long cardigan and trousers"],
  shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
};

export function customSnapshot(style: CategorySnapshot["style"] = "phone"): CategorySnapshot {
  return { ref: CUSTOM_REF, name: "Кофейни Парижа", label: "Paris cafes", style };
}
