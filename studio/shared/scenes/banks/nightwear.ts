import { isOwnerBannedOutfit } from "../words";
import { OPENS_WITH_ARMS_UP } from "./boldRules";
import type { CategoryBank, Outfit } from "./types";

// «Ночнушки и бельё» (`nightwear`, 5a.3, plan s5a3 §6.2 r3.1), a «Смелая» bank: drawn only under «Подача: Смелая». At home she shoots herself (I5.32): in the
// mirror, a third of the frames with the phone over her face; at arm's length from above as she lies there; lying on her stomach on her bed; over her own
// shoulder; on a timer. Never a friend. Lamp light at evening and night (I5.34). P-5a3 (2026-10-12): the arm over her chest with only lace panties was refused 6/6
// and is not here; the bedsheet (3/3), the sheer babydoll with thigh-high stockings and the prone bra and briefs were drawn and stay; stockings with lingerie on a
// legs frame were refused, so a bold legs frame wears the satin with the bold stockings. The owner confirms each of these on the review sheet.
//
// 5a.4 (S5.BA2, 2026-10-26, plan s5a4 §5.4, Q-A2): always underwear, every frame on Seedream at 2K. The cotton nightwear on the owner's model (the sleep tee, the cotton pajamas, the
// nightshirt, the silk pajamas, the prone grey lounge shorts) gave way to plain underwear; the tiers follow the tier table (r2.2 P6, banks/boldRules.ts `tierOfGarment`).
// The bedsheet is an implied cover (a Studio-created avatar's only, I5.74), its moment reworded so her free hand holds nothing (r2.2 P3). P-BA drew the prone bra and
// briefs (A1) and the open shirt (A3) without their coverage on a Studio-created avatar, so no lingerie or plain outfit here says an open coverage: such a frame says no
// sentence. The sheet was drawn with its kept sentence only, and no satin was drawn open (review M1), so every avatar says theirs (r2.2 P5).

/** The plain underwear that replaced the cotton nightwear; the prone moments wear the tee and panties (Seedream drew prone lingerie: P-5a3 #4, P-NUDE C1, P-BA A1). */
const TEE_AND_PANTIES = "a tee and cotton panties";
const CAMI_AND_PANTIES = "a cami and cotton panties";
const SATIN_CAMI = "a satin cami and satin shorts";
const SATIN_MIDI = "a satin midi nightdress";
const SATIN_ROBE = "a short tied satin robe";
/**
 * A legs frame (M5): three satin (the cami and shorts is the plain one) and plain cotton (P-BA L1 drew underwear on a legs frame); none a mini, no lace. A bold legs slot is the
 * satin with the bold stockings (P-5a3 #6).
 */
const LEGS = [SATIN_CAMI, SATIN_MIDI, SATIN_ROBE, TEE_AND_PANTIES, CAMI_AND_PANTIES];

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN_DRESS = "Her nightdress is opaque satin.";
const SATIN_SET = "Her cami and shorts are opaque satin.";
const ROBE = "Her robe is tied and closed over her chest.";
/** P-BA V2 drew the sheet with this sentence (P-5a3 #2 said «held up»; the moment no longer holds it). */
const SHEET = "The white sheet is pulled up to her chest and fully covers her breasts and her hips.";

/** The bank's outfits, general and pin-only, each in its tier by the tier table: plain underwear and the satin cami, lace and satin nightwear, then the most revealing. */
const OUTFITS: readonly Outfit[] = [
  { text: TEE_AND_PANTIES, showsLegs: true, route: "seedream", coverage: "Her tee covers her chest, and her panties fully cover her." },
  { text: "a cotton bra and briefs", showsLegs: true, route: "seedream", coverage: "Her bra fully covers her breasts and her briefs fully cover her." },
  { text: CAMI_AND_PANTIES, showsLegs: true, route: "seedream", coverage: "Her cami covers her chest, and her panties fully cover her." },
  // 5a.4 (S5.BA2 review M1): P-BA drew no satin without its coverage, so the satin says its kept sentence to every avatar (openCoverage = coverage).
  { text: "a satin slip nightdress", showsLegs: true, level: "flirty", route: "seedream", coverage: SATIN_DRESS, openCoverage: SATIN_DRESS },
  { text: SATIN_MIDI, showsLegs: true, level: "flirty", route: "seedream", coverage: SATIN_DRESS, openCoverage: SATIN_DRESS },
  // 5a.4 (r2.2 P6): flirty -> plain.
  { text: SATIN_CAMI, showsLegs: true, route: "seedream", coverage: SATIN_SET, openCoverage: SATIN_SET },
  { text: SATIN_ROBE, showsLegs: true, level: "flirty", route: "seedream", coverage: ROBE, openCoverage: ROBE },
  // Spike A drew the lace set 3/3 with this coverage. 5a.4 (r2.2 P6): bold -> flirty.
  { text: "a black lace bra and panties", showsLegs: true, level: "flirty", route: "seedream", coverage: LACE },
  { text: "a white lace bra and panties", showsLegs: true, level: "flirty", route: "seedream", coverage: LACE },
  { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." },
  // Answer (b): the garment name is allowed in the «Смелая» banks only.
  { text: "a sheer babydoll over a lace set", showsLegs: true, level: "bold", route: "seedream", coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her." },
  // The owner's «a top with panties at home». 5a.4 (r2.2 P6): bold -> plain.
  { text: "a cropped tee and cotton panties", showsLegs: true, route: "seedream", coverage: "Her tee covers her chest, and her panties fully cover her." },
  // The owner's «an unbuttoned shirt with the nipple not visible», as Spike A drew it.
  {
    text: "an open white shirt and panties",
    showsLegs: true,
    level: "bold",
    route: "seedream",
    coverage: "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.",
  },
  // 5a.4 (r2.2 P6): a thong is the most revealing tier, so the general draw keeps four bold outfits now that the lace sets are flirty.
  { text: "a white lace bra and a thong", showsLegs: true, level: "bold", route: "seedream", coverage: "The lace is lined and opaque: her bra fully covers her breasts and her thong fully covers her in front." },
  // 5a.4 (r2.2 P6): bold -> plain; the moment that pins it keeps its bold level.
  { text: "a black bra and briefs", showsLegs: true, pinOnly: true, route: "seedream", coverage: "Her bra fully covers her breasts and her briefs fully cover her." },
  // 5a.4 (r2.2 P6, bold-floor): it names her panties, and it is plain; the moment that pins it keeps its bold level and carries the coverage.
  { text: "a crop top with panties and jeans", pinOnly: true, route: "seedream" },
  // 5a.4 (I5.74): an implied cover, a Studio-created avatar's only.
  { text: "only the white bedsheet", pinOnly: true, level: "bold", route: "seedream", tier: "implied" },
];

/**
 * Every outfit of the general draw but the open shirt and the cropped tee: a moment with her arms up pins these (the open shirt does not stay closed over her chest, review of
 * S5.9b2; the cropped tee rides up, S5.R4). Derived from the bank's outfits, so an outfit added to the bank reaches the arms-up moments by itself and never slips in unchecked.
 */
const ARMS_UP_OUTFITS: readonly string[] = OUTFITS.filter((o) => o.pinOnly !== true && !isOwnerBannedOutfit(o.text) && !OPENS_WITH_ARMS_UP.test(o.text)).map((o) => o.text);

/**
 * S5.R4: every outfit of the general draw that is not bold: a moment under the duvet or a blanket pins these (rule bold-covered), so a bold slot never pays a 2K frame for lingerie
 * the cover hides. Derived from the bank's outfits, as the arms-up pins are.
 */
const COVERED_OUTFITS: readonly string[] = OUTFITS.filter((o) => o.pinOnly !== true && !isOwnerBannedOutfit(o.text) && o.level !== "bold").map((o) => o.text);

export const NIGHTWEAR: CategoryBank = {
  bold: true,
  places: [
    {
      name: "her bed",
      at: "on her bed",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a bedside lamp", "a glass of water on the nightstand"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "lies back against the pillows", motion: "she slowly blinks and smiles", captures: ["above"], twoHanded: false, messyOk: true },
        { text: "lies on her side, head on her hand", motion: "she smiles a little and looks away", captures: ["above", "timer"], twoHanded: false, handAtFace: true },
        { text: "rests her cheek on the pillow", motion: "she slowly closes her eyes", captures: ["above"], twoHanded: false },
        { text: "lies curled up under the duvet", motion: "she pulls the duvet up a little", captures: ["above", "timer"], twoHanded: false, messyOk: true, outfits: COVERED_OUTFITS },
        { text: "lies back, hair across the pillow", motion: "she slowly turns her head", captures: ["above"], twoHanded: false, hair: "own" },
        { text: "lies back, one knee up", motion: "she sways her knee a little", captures: ["above"], twoHanded: false, level: "flirty" },
        { text: "sits cross-legged with her coffee", motion: "she sips and smiles a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "sits up against the headboard", motion: "she leans her head back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "sits with her legs tucked under her", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "stretches out on the duvet", motion: "she stretches her arms slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, outfits: ARMS_UP_OUTFITS },
        // 5a.4 (Q-A2): the prone selfie wears the tee and cotton panties on Seedream (it wore grey lounge shorts on the owner's model); it keeps her bare legs.
        { text: "lies on her stomach, one arm out", motion: "she swings her feet a little", captures: ["prone"], twoHanded: false, outfits: [TEE_AND_PANTIES], noLegwear: true },
        { text: "lies prone, her cheek on her hand", motion: "she slowly blinks and smiles", captures: ["prone"], twoHanded: false, outfits: [TEE_AND_PANTIES], handAtFace: true, noLegwear: true },
        { text: "lies on her stomach, head tilted", motion: "she tilts her head a little", captures: ["prone"], twoHanded: false, outfits: [TEE_AND_PANTIES], noLegwear: true },
        { text: "lies prone, glancing back", motion: "she turns her head a little further", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", gaze: "own", outfits: [TEE_AND_PANTIES], noLegwear: true },
        { text: "lies prone, ankles crossed behind", motion: "she crosses her raised ankles slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: [TEE_AND_PANTIES], noLegwear: true },
        { text: "lies prone, feet raised behind", motion: "her raised feet swing slowly behind her", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: [TEE_AND_PANTIES], noLegwear: true },
        { text: "lies prone, chin on her hand", motion: "she kicks her feet slowly behind her", captures: ["prone"], twoHanded: false, level: "flirty", outfits: [TEE_AND_PANTIES, SATIN_CAMI], handAtFace: true, noLegwear: true },
        // P58 and P-5a3 #4: Seedream drew it, with no phone in her hands.
        { text: "lies on her stomach, hips behind", motion: "she lifts her hips a little", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: ["a black bra and briefs"], noLegwear: true },
        { text: "lies on her stomach, feet up", motion: "her raised feet swing slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", level: "bold", route: "seedream", outfits: ["a black lace bra and panties"], noLegwear: true },
        // Review round 2: arms up, the open shirt would not stay closed over her chest, so this moment wears the lingerie that stays in place.
        {
          text: "lies back with her arms up",
          motion: "she stretches slowly and smiles",
          captures: ["above"],
          twoHanded: false,
          level: "bold",
          route: "seedream",
          // S5.R4: not the cropped tee either: with her arms up it rides up.
          outfits: ["a black lace bra and panties", "a white lace bra and panties", "a lace bodysuit", "a sheer babydoll over a lace set"],
        },
        // P-5a3 #2 (3/3): the sheet is all she wears; the moment carries what covers her. 5a.4 (r2.2 P3): on `above` her near hand holds the phone and her other hand is free, so
        // the sheet is pulled up, never held («lies holding the sheet to her chest» was the text). An implied cover (I5.74); every avatar says the kept sentence (r2.2 P5).
        {
          text: "lies with the sheet up to her chest",
          motion: "she pulls the sheet a little higher",
          captures: ["above"],
          twoHanded: false,
          level: "bold",
          route: "seedream",
          tier: "implied",
          outfits: ["only the white bedsheet"],
          coverage: SHEET,
          openCoverage: SHEET,
        },
        // «Ножки» (S5.8a, M5): a look down along her own legs.
        // S5.R4 round 3: its motion was «Дом»'s and the beach's word for word.
        { text: "lies with her legs crossed", motion: "she slides one ankle over the other slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        // S5.R4: seven legs moments of seven poses, so the six legs slots of a 20-photo run at «Ножки» 30 % never show one pose twice (round 2: «legs stretched out» three times
        // over in other words was the same photo).
        { text: "lies on her side, one knee bent", motion: "she slides her top knee forward a little", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bedroom",
      at: "in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a string of fairy lights", "a plain wall behind her"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "stretches after waking up", motion: "she stretches her arms up slowly", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, outfits: ARMS_UP_OUTFITS },
        { text: "tucks her hair behind one ear", motion: "she tucks her hair back slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        // The cotton nightwear has no straps (review round 2): the strap moment is flirty and wears the satin and the lingerie that have them.
        {
          text: "adjusts the strap on her shoulder",
          motion: "she slides the strap up slowly",
          captures: ["mirror-hidden", "mirror"],
          twoHanded: false,
          gaze: "focus",
          level: "flirty",
          outfits: ["a satin slip nightdress", SATIN_MIDI, SATIN_CAMI, "a black lace bra and panties", "a white lace bra and panties", "a lace bodysuit", "a sheer babydoll over a lace set"],
        },
        { text: "stands by the wardrobe", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "holds a mug of tea", motion: "she lifts the mug a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "sits on the edge of the bed", motion: "she swings one foot slowly", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false, level: "flirty" },
        { text: "leans on the doorframe", motion: "she shifts her shoulder slowly", captures: ["mirror", "timer"], twoHanded: false, level: "flirty" },
        { text: "stands with one hand on her hip", motion: "she turns her hips a little", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "stands sideways to the mirror", motion: "she turns her head a little toward the mirror", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
        // The owner's «bent over pulling on trousers, her bottom in panties visible»: side to the mirror, only her reflection.
        {
          text: "pulls her jeans up over her panties",
          motion: "she tugs the waistband up slowly",
          captures: ["mirror-hidden"],
          twoHanded: false,
          angle: "three-quarter",
          mirrorBack: true,
          level: "bold",
          route: "seedream",
          outfits: ["a crop top with panties and jeans"],
          coverage: "Her panties fully cover her bottom, and her crop top covers her chest.",
        },
        { text: "stands on tiptoe by the mirror", motion: "she rises a little higher on her toes", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        // S5.R4 round 3: a step toward the mirror, her legs mid-stride, in place of «kneels in front of the mirror» (kneeling folds her legs under her: they cannot fill the frame).
        { text: "steps toward the mirror", motion: "she takes a small step closer", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bathroom",
      at: "in her bathroom",
      room: true,
      mirror: true,
      details: ["a towel on the hook", "a small plant by the sink"],
      times: ["morning", "evening", "night"],
      moments: [
        { text: "brushes her hair", motion: "she draws the brush down slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        { text: "leans on the edge of the tub", motion: "she leans back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "fixes her hair in a clip", motion: "she pins her hair up slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        // S5.R4 round 3: in place of «lifts one foot to the mirror», which was «Дом»'s «lifts one bare foot to the mirror» with «Дом»'s motion.
        // Polish after C4: «stands with her weight on one leg» was «Дом»'s «weight on one hip» (both are mirror-hidden); her feet together is a pose of its own.
        { text: "stands with her feet together", motion: "she turns one foot out slowly", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        { text: "pats on some face cream", motion: "she pats her cheek gently", captures: ["mirror"], twoHanded: false, gaze: "focus" },
        { text: "leans toward the mirror", motion: "she leans in a little closer", captures: ["mirror"], twoHanded: false, level: "flirty" },
        { text: "sits on the counter", motion: "she turns her head a little toward the mirror", captures: ["mirror-hidden"], twoHanded: false, angle: "three-quarter", mirrorBack: true, level: "bold", route: "seedream" },
      ],
    },
    {
      name: "an armchair in her bedroom",
      at: "in an armchair in her bedroom",
      room: true,
      lamp: true,
      mirror: true,
      details: ["a knitted throw", "a floor lamp"],
      times: ["evening", "night"],
      moments: [
        { text: "sits with one leg crossed", motion: "she wiggles her crossed foot a bit", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
        { text: "pulls one knee up to her chest", motion: "she rests her cheek a little lower", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
        { text: "curls up with a blanket", motion: "she pulls the blanket a little closer", captures: ["mirror-hidden", "mirror"], twoHanded: false, outfits: COVERED_OUTFITS },
        { text: "tucks one leg under her", motion: "she settles a little deeper", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "sits back, knees together", motion: "she rocks a little in place", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        // S5.R4 round 2: worded apart from «Фитнес»'s and «Дом»'s «sits with her legs stretched out»; the pose is the same.
        { text: "stretches out her legs", motion: "she points her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        // S5.R4 round 3: in the chair before the mirror, her legs over the armrest, the phone over her face. It replaces «crosses her legs, a foot dangling», which was «Дом»'s pose with
        // «Дом»'s motion (the owner's C3′ chair frame stays in «Дом»).
        { text: "sits, legs over the armrest", motion: "she bounces her feet a little", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
      ],
    },
    {
      name: "her bedroom window",
      at: "by her bedroom window",
      room: true,
      details: ["a potted plant in the corner", "a soft rug on the floor"],
      times: ["morning", "evening"],
      moments: [
        // C3′ (the owner: «просто стоит спиной без какой-либо позы»): from behind she does something the frame can read.
        { text: "stretches her arms up, facing away", motion: "she stretches a little further", captures: ["timer"], twoHanded: true, angle: "back", outfits: ARMS_UP_OUTFITS },
        { text: "opens the curtains", motion: "she pulls the curtain a little wider", captures: ["timer"], twoHanded: true, gaze: "focus" },
        { text: "leans against the wall", motion: "she shifts her weight a little", captures: ["timer"], twoHanded: false },
        { text: "sits on the windowsill", motion: "she swings one foot a little", captures: ["timer"], twoHanded: false, level: "flirty" },
      ],
    },
  ],
  outfits: OUTFITS,
  legwear: {
    items: ["thigh-high socks", "sheer black tights"],
    share: 0.3,
    // Review round 2, MEDIUM 4: the stockings go with the satin nightwear and the lingerie, never the cotton; on a legs frame that leaves the satin (P-5a3 #6), and a bold legs
    // slot wears them always, not at the share (S5.R4: the stockings make it bold). 5a.4: never with the plain cotton underwear either.
    bold: {
      items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"],
      share: 0.5,
      route: "seedream",
      outfits: [
        "a satin slip nightdress",
        SATIN_MIDI,
        SATIN_CAMI,
        "a short tied satin robe",
        "a black lace bra and panties",
        "a white lace bra and panties",
        "a lace bodysuit",
        "a sheer babydoll over a lace set",
        "an open white shirt and panties",
      ],
    },
  },
  // ⅓ phone-over-face mirror frames (I5.32), never a friend: 4 of 12 with the phone over her face, 3 mirrors, 2 from above, 1 prone, 1 over her shoulder, 1 timer.
  captureDeck: ["mirror-hidden", "mirror", "above", "mirror-hidden", "prone", "timer", "mirror-hidden", "mirror", "above", "mirror-hidden", "over-shoulder", "mirror"],
};
