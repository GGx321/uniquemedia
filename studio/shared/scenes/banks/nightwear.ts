import type { CategoryBank } from "./types";

// «Ночнушки и бельё» (`nightwear`, 5a.3, plan s5a3 §6.2 r3.1), a «Смелая» bank: drawn only under «Подача: Смелая». At home she shoots herself (I5.32): in the
// mirror, a third of the frames with the phone over her face; at arm's length from above as she lies there; lying on her stomach on her bed; over her own
// shoulder; on a timer. Never a friend. Lamp light at evening and night (I5.34). Ordinary is cotton nightwear on the owner's model; flirty is satin
// nightwear (Grok refused satin nightdresses 2/2) and bold is lingerie, both on Seedream at 2K, each with a positive coverage sentence the template appends.
// P-5a3 (2026-10-12): the arm over her chest with only lace panties was refused 6/6 and is not here; the bedsheet (3/3), the sheer babydoll with thigh-high
// stockings and the prone bra and briefs were drawn and stay; stockings with lingerie on a legs frame were refused, so a legs frame wears cotton or satin,
// and a bold one the satin with the bold stockings. The owner confirms each of these on the review sheet.

/** The prone selfie's outfit on the owner's model: «Дом»'s probes drew grey lounge shorts and refused cotton shorts; C3′: a skirt or shorts names its fabric (an unnamed one draws as denim), so jersey, as «Дом» words it. */
const PRONE_GREY = "grey jersey lounge shorts and a tee";
const PAJAMAS = "cotton pajama shorts and a tee";
const NIGHTSHIRT = "a long cotton nightshirt";
const SATIN_CAMI = "a satin cami and satin shorts";
const SATIN_MIDI = "a satin midi nightdress";
/** A legs frame (M5): two cotton, two satin, none a mini, none lingerie. A bold legs slot is the satin with the bold stockings (P-5a3 #6). */
const LEGS = [PAJAMAS, NIGHTSHIRT, SATIN_CAMI, SATIN_MIDI];

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN_DRESS = "Her nightdress is opaque satin.";

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
        { text: "lies curled up under the duvet", motion: "she pulls the duvet up a little", captures: ["above", "timer"], twoHanded: false, messyOk: true },
        { text: "lies back, hair across the pillow", motion: "she slowly turns her head", captures: ["above"], twoHanded: false, hair: "own" },
        { text: "lies back, one knee up", motion: "she sways her knee a little", captures: ["above"], twoHanded: false, level: "flirty" },
        { text: "sits cross-legged with her coffee", motion: "she sips and smiles a little", captures: ["mirror"], twoHanded: false },
        { text: "sits up against the headboard", motion: "she leans her head back a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "sits with her legs tucked under her", motion: "she shifts her weight a little", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "stretches out on the duvet", motion: "she stretches her arms slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        // The prone selfie on the owner's model wears what «Дом»'s probes drew; it keeps her bare legs.
        { text: "lies on her stomach, one arm out", motion: "she swings her feet a little", captures: ["prone"], twoHanded: false, outfits: [PRONE_GREY], noLegwear: true },
        { text: "lies prone, her cheek on her hand", motion: "she slowly blinks and smiles", captures: ["prone"], twoHanded: false, outfits: [PRONE_GREY], handAtFace: true, noLegwear: true },
        { text: "lies on her stomach, head tilted", motion: "she tilts her head a little", captures: ["prone"], twoHanded: false, outfits: [PRONE_GREY], noLegwear: true },
        { text: "lies prone, glancing back", motion: "she turns her head a little further", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", gaze: "own", outfits: [PRONE_GREY], noLegwear: true },
        { text: "lies prone, ankles crossed behind", motion: "she crosses her raised ankles slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: [PRONE_GREY], noLegwear: true },
        { text: "lies prone, feet raised behind", motion: "her raised feet swing slowly behind her", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", outfits: [PRONE_GREY], noLegwear: true },
        { text: "lies prone, chin on her hand", motion: "she kicks her feet slowly behind her", captures: ["prone"], twoHanded: false, level: "flirty", outfits: [PRONE_GREY, SATIN_CAMI], handAtFace: true, noLegwear: true },
        // P58 and P-5a3 #4: Seedream drew it, with no phone in her hands.
        { text: "lies on her stomach, hips behind", motion: "she lifts her hips a little", captures: ["prone"], twoHanded: false, level: "bold", route: "seedream", outfits: ["a black bra and briefs"], noLegwear: true },
        { text: "lies on her stomach, feet up", motion: "her raised feet swing slowly", captures: ["over-shoulder"], twoHanded: false, angle: "three-quarter", level: "bold", route: "seedream", outfits: ["a black lace bra and panties"], noLegwear: true },
        { text: "lies back with her arms up", motion: "she stretches slowly and smiles", captures: ["above"], twoHanded: false, level: "bold", route: "seedream" },
        // P-5a3 #2 (3/3): the sheet held to her chest is all she wears; the moment carries what covers her.
        {
          text: "lies holding the sheet to her chest",
          motion: "she pulls the sheet a little higher",
          captures: ["above"],
          twoHanded: false,
          level: "bold",
          route: "seedream",
          outfits: ["only the white bedsheet"],
          coverage: "The white sheet is held up to her chest and fully covers her breasts and her hips.",
        },
        // «Ножки» (S5.8a, M5): a look down along her own legs.
        { text: "lies with her legs crossed", motion: "she crosses and uncrosses her ankles slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
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
        { text: "stretches after waking up", motion: "she stretches her arms up slowly", captures: ["mirror-hidden", "mirror", "timer"], twoHanded: false },
        { text: "tucks her hair behind one ear", motion: "she tucks her hair back slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, hair: "own" },
        { text: "adjusts the strap on her shoulder", motion: "she slides the strap up slowly", captures: ["mirror-hidden", "mirror"], twoHanded: false, gaze: "focus" },
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
          outfits: ["a crop top and jeans"],
          coverage: "Her panties fully cover her bottom, and her crop top covers her chest.",
        },
        { text: "lifts one foot to the mirror", motion: "she lifts her foot a little and lowers it", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
        { text: "sits with her feet to the mirror", motion: "she taps her feet together a little", captures: ["mirror-hidden"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
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
        { text: "curls up with a blanket", motion: "she pulls the blanket a little closer", captures: ["mirror-hidden", "mirror"], twoHanded: false },
        { text: "tucks one leg under her", motion: "she settles a little deeper", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "flirty" },
        { text: "sits back, knees together", motion: "she rocks a little in place", captures: ["mirror-hidden", "mirror"], twoHanded: false, level: "bold", route: "seedream" },
        { text: "sits with her legs stretched out", motion: "she points her toes slowly", captures: ["pov-legs"], twoHanded: false, outfits: LEGS, legs: { framing: "legs" } },
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
        { text: "stretches her arms up, facing away", motion: "she stretches a little further", captures: ["timer"], twoHanded: true, angle: "back" },
        { text: "opens the curtains", motion: "she pulls the curtain a little wider", captures: ["timer"], twoHanded: true, gaze: "focus" },
        { text: "leans against the wall", motion: "she shifts her weight a little", captures: ["timer"], twoHanded: false },
        { text: "sits on the windowsill", motion: "she swings one foot a little", captures: ["timer"], twoHanded: false, level: "flirty" },
      ],
    },
  ],
  outfits: [
    { text: "an oversized sleep tee", showsLegs: true },
    { text: PAJAMAS, showsLegs: true },
    { text: NIGHTSHIRT, showsLegs: true },
    // Grok drew silk pajamas (style probe 2); K-22 exempts the phrase from the luxury words.
    { text: "silk pajamas" },
    { text: PRONE_GREY, showsLegs: true, pinOnly: true },
    { text: "a satin slip nightdress", showsLegs: true, level: "flirty", route: "seedream", coverage: SATIN_DRESS },
    { text: SATIN_MIDI, showsLegs: true, level: "flirty", route: "seedream", coverage: SATIN_DRESS },
    { text: SATIN_CAMI, showsLegs: true, level: "flirty", route: "seedream", coverage: "Her cami and shorts are opaque satin." },
    { text: "a short tied satin robe", showsLegs: true, level: "flirty", route: "seedream", coverage: "Her robe is tied and closed over her chest." },
    // Spike A drew the lace set 3/3 with this coverage.
    { text: "a black lace bra and panties", showsLegs: true, level: "bold", route: "seedream", coverage: LACE },
    { text: "a white lace bra and panties", showsLegs: true, level: "bold", route: "seedream", coverage: LACE },
    { text: "a lace bodysuit", showsLegs: true, level: "bold", route: "seedream", coverage: "Her bodysuit is lined and opaque over her chest and fully covers her hips." },
    // Answer (b): the garment name is allowed in the «Смелая» banks only.
    { text: "a sheer babydoll over a lace set", showsLegs: true, level: "bold", route: "seedream", coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her." },
    // The owner's «a top with panties at home».
    { text: "a cropped tee and cotton panties", showsLegs: true, level: "bold", route: "seedream", coverage: "Her tee covers her chest, and her panties fully cover her." },
    // The owner's «an unbuttoned shirt with the nipple not visible», as Spike A drew it.
    {
      text: "an open white shirt and panties",
      showsLegs: true,
      level: "bold",
      route: "seedream",
      coverage: "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.",
    },
    { text: "a black bra and briefs", showsLegs: true, pinOnly: true, level: "bold", route: "seedream", coverage: "Her bra fully covers her breasts and her briefs fully cover her." },
    { text: "a crop top and jeans", pinOnly: true, level: "bold", route: "seedream" },
    { text: "only the white bedsheet", pinOnly: true, level: "bold", route: "seedream" },
  ],
  legwear: {
    items: ["thigh-high socks", "sheer black tights"],
    share: 0.3,
    bold: { items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"], share: 0.5, route: "seedream" },
  },
  // ⅓ phone-over-face mirror frames (I5.32), never a friend: 4 of 12 with the phone over her face, 3 mirrors, 2 from above, 1 prone, 1 over her shoulder, 1 timer.
  captureDeck: ["mirror-hidden", "mirror", "above", "mirror-hidden", "prone", "timer", "mirror-hidden", "mirror", "above", "mirror-hidden", "over-shoulder", "mirror"],
};
