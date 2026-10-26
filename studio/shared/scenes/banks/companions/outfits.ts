import { isOwnerBannedOutfit } from "../../words";
import { OPENS_WITH_ARMS_UP } from "../boldRules";
import type { Outfit } from "../types";

// 5a.4 (S5.BA2, plan s5a4 §5.1.1, §5.2, §5.5): the outfits the «Смелая» companions and the custom «Смелая» banks wear, one wording each, so a garment says the same coverage in
// every bank. Every one is drawn on Seedream at 2K and carries its kept, restrictive coverage (H3): what an imported avatar's frame always says. P-BA drew the open classes
// (lingerie, the sports set, the bodysuit, the sheer set, the open shirt, swimwear; banks/boldRules.ts `openClassOf`) without it on a Studio-created avatar, so they carry no
// `openCoverage`: such a frame says no sentence. P-BA drew no satin open, so the satin says its kept sentence to every avatar (review M1). The implied covers are pinned by their own moments, which carry the coverage: the towel says its descriptive open one (P-BA B1); the sheet, the foam and the bare back
// were drawn with the kept sentence only, so every avatar says it (r2.2 P5). The tier is the garment's (the tier table, banks/boldRules.ts `tierOfGarment`).

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const LACE_THONG = "The lace is lined and opaque: her bra fully covers her breasts and her thong fully covers her in front.";
const SATIN_DRESS = "Her nightdress is opaque satin.";
const BIKINI = "Her bikini top fully covers her breasts, and her bikini bottoms fully cover her.";

const seedream = (text: string, level: "flirty" | "bold" | undefined, coverage: string, showsLegs = true): Outfit => ({
  text,
  ...(showsLegs ? { showsLegs: true as const } : {}),
  ...(level === undefined ? {} : { level }),
  route: "seedream",
  coverage,
});

/** A Seedream outfit of a class P-BA did not draw open: every avatar says its kept sentence (review M1, fail-closed). */
const keptForEveryone = (outfit: Outfit): Outfit => ({ ...outfit, openCoverage: outfit.coverage });

// ---------- plain («скромнее») ----------
export const TEE_AND_PANTIES = seedream("a tee and cotton panties", undefined, "Her tee covers her chest, and her panties fully cover her.");
export const COTTON_SET = seedream("a cotton bra and briefs", undefined, "Her bra fully covers her breasts and her briefs fully cover her.");
export const TANK_AND_BRIEFS = seedream("a tank top and cotton briefs", undefined, "Her tank top covers her chest, and her briefs fully cover her.");
export const CAMI_AND_PANTIES = seedream("a cami and cotton panties", undefined, "Her cami covers her chest, and her panties fully cover her.");
export const SATIN_CAMI = keptForEveryone(seedream("a satin cami and satin shorts", undefined, "Her cami and shorts are opaque satin."));
/** P-BA S1 drew it (half-dressed before going out). Her legs are in the jeans: no legwear. */
export const BRA_AND_JEANS = seedream("a black bra and jeans", undefined, "Her bra fully covers her breasts, and her jeans sit buttoned at her waist.", false);
export const BLACK_BRA_AND_BRIEFS = seedream("a black bra and briefs", undefined, "Her bra fully covers her breasts and her briefs fully cover her.");
/** P-BA F1 and L1 drew the sports set (L1 on a legs frame). */
export const SPORTS_SET = seedream("a sports bra and seamless briefs", undefined, "Her sports bra fully covers her breasts, and her seamless briefs fully cover her.");
export const SPORTS_AND_PANTIES = seedream("a sports bra and cotton panties", undefined, "Her sports bra fully covers her breasts, and her panties fully cover her.");

// ---------- flirty («кокетливо») ----------
export const BLACK_LACE = seedream("a black lace bra and panties", "flirty", LACE);
export const WHITE_LACE = seedream("a white lace bra and panties", "flirty", LACE);
export const LACE_BRALETTE = seedream("a lace bralette and briefs", "flirty", "The lace is lined and opaque: her bralette fully covers her breasts and her briefs fully cover her.");
export const LACE_AND_JEANS = seedream("a lace bra and jeans", "flirty", "The lace is lined and opaque: her bra fully covers her breasts, and her jeans sit buttoned at her waist.", false);
export const SATIN_SLIP = keptForEveryone(seedream("a satin slip nightdress", "flirty", SATIN_DRESS));
export const SATIN_MIDI = keptForEveryone(seedream("a satin midi nightdress", "flirty", SATIN_DRESS));
export const SATIN_ROBE = keptForEveryone(seedream("a short tied satin robe", "flirty", "Her robe is tied and closed over her chest."));

// ---------- most revealing («откровеннее всего») ----------
export const SHEER_SET = seedream("a sheer babydoll over a lace set", "bold", "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her.");
export const BODYSUIT = seedream("a lace bodysuit", "bold", "Her bodysuit is lined and opaque over her chest and fully covers her hips.");
/** P-BA S2 drew it, prone. */
export const LACE_THONG_SET = seedream("a white lace bra and a thong", "bold", LACE_THONG);
export const BLACK_THONG_SET = seedream("a black bra and a thong", "bold", "Her bra fully covers her breasts, and her thong fully covers her in front.");
/** P-BA F1 drew it. */
export const SPORTS_THONG = seedream("a sports bra and a thong", "bold", "Her sports bra fully covers her breasts, and her thong fully covers her in front.");
/** P-BA A3 drew it (the owner's «an unbuttoned shirt with the nipple not visible», as Spike A drew it). */
export const OPEN_SHIRT = seedream(
  "an open white shirt and panties",
  "bold",
  "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.",
);

// ---------- swimwear, worn only at the water (the beach bank's cuts and sentences) ----------
export const ONE_PIECE = seedream("a one-piece swimsuit", undefined, "Her swimsuit fully covers her chest and her hips.", false);
export const SPORTY_BIKINI = seedream("a sporty bikini", undefined, BIKINI, false);
export const BLACK_ONE_PIECE = seedream("a black one-piece swimsuit", undefined, "Her swimsuit fully covers her chest and her hips.", false);
export const BLACK_BIKINI = seedream("a black bikini", "flirty", BIKINI, false);
export const WHITE_BIKINI = seedream("a white bikini", "flirty", BIKINI, false);
export const STRAW_HAT_BIKINI = seedream("a bikini and a straw hat", "flirty", BIKINI, false);
export const STRING_BIKINI = seedream("a white string bikini", "bold", BIKINI, false);
export const TRIANGLE_BIKINI = seedream("a red triangle bikini", "bold", BIKINI, false);
export const BANDEAU_BIKINI = seedream("a strapless bandeau bikini", "bold", BIKINI, false);
export const HIGH_LEG = seedream("a high-leg black swimsuit", "bold", "Her swimsuit fully covers her chest and her bottom.", false);

/** A swimwear outfit pinned by the water places' moments of a bank that has rooms: never in its general draw (bold-floor). */
export const pinned = (outfit: Outfit): Outfit => ({ ...outfit, pinOnly: true });

// ---------- the implied covers (Studio-created avatars only; their moments carry the coverage) ----------
const implied = (text: string): Outfit => ({ text, pinOnly: true, level: "bold", route: "seedream", tier: "implied" });
export const BATH_TOWEL = implied("only a white bath towel");
export const BEDSHEET = implied("only the white bedsheet");
export const HOTEL_SHEET = implied("only the white hotel sheet");
export const BATH_FOAM = implied("only the bath foam");
/** P-BA F2: prone on her bed, a towel over her hips, her bare back. */
export const HIP_TOWEL = implied("only a towel over her hips");

/** The kept and open sentences of the implied covers, said by the moments that pin them. */
export const COVER = {
  towel: "The towel is wrapped around her and tucked in above her chest, and it fully covers her down to her thighs.",
  /** P-BA B1 drew the towel with this sentence on a Studio-created avatar. */
  towelOpen: "The towel is wrapped around her, tucked in above her chest.",
  sheet: "The white sheet is pulled up to her chest and fully covers her breasts and her hips.",
  foam: "Thick bath foam rises up to her shoulders and fully covers her body below them.",
  hipTowel: "The towel lies across her hips and fully covers her bottom, and she lies flat on her front.",
} as const;

/** The towel's pin: a moment wearing only the towel, with its kept and its open sentence. */
export const TOWEL_PIN = { tier: "implied", level: "bold", route: "seedream", outfits: [BATH_TOWEL.text], coverage: COVER.towel, openCoverage: COVER.towelOpen } as const;
/** The sheet's, the foam's and the bare back's pins: every avatar says the kept sentence. */
export const BEDSHEET_PIN = { tier: "implied", level: "bold", route: "seedream", outfits: [BEDSHEET.text], coverage: COVER.sheet, openCoverage: COVER.sheet } as const;
export const HOTEL_SHEET_PIN = { tier: "implied", level: "bold", route: "seedream", outfits: [HOTEL_SHEET.text], coverage: COVER.sheet, openCoverage: COVER.sheet } as const;
export const FOAM_PIN = { tier: "implied", level: "bold", route: "seedream", outfits: [BATH_FOAM.text], coverage: COVER.foam, openCoverage: COVER.foam } as const;
export const HIP_TOWEL_PIN = { tier: "implied", level: "bold", route: "seedream", outfits: [HIP_TOWEL.text], coverage: COVER.hipTowel, openCoverage: COVER.hipTowel } as const;

/** The general outfits a moment with her arms up may wear: every one but the open shirt and a crop top (bold-arms-up), in the bank's order. */
export function armsUpOutfits(outfits: readonly Outfit[]): readonly string[] {
  return outfits.filter((o) => o.pinOnly !== true && !isOwnerBannedOutfit(o.text) && !OPENS_WITH_ARMS_UP.test(o.text)).map((o) => o.text);
}
