import { describe, expect, test } from "bun:test";
import type { Capture } from "../captures";
import { lingerieWordsIn, openClassOf } from "./boldRules";
import { AWAY_ACTION_WORDS, unfabricBottomsIn, WALKS_AWAY_WORDS } from "../words";
import { NIGHTWEAR } from "./nightwear";
import { boldAnyProblems, boldBankProblems, categoryBankProblems } from "./schema";
import type { Moment, Outfit } from "./types";

// 5a.3 (S5.9b2, plan s5a3 §6.2 r3.1): «Ночнушки и бельё», a «Смелая» bank. At home she shoots herself: in the mirror (a third of the frames with the phone over her
// face), at arm's length from above as she lies there, lying on her stomach on her bed, over her own shoulder, on a timer. P-5a3 decided four items: the arm over her
// chest with only lace panties was refused 6/6 and left; the bedsheet, the babydoll with stockings and the prone bra and briefs were drawn and stay; a bold legs frame
// wears satin with stockings (#6). The bank text is the product: these rows pin it.
// 5a.4 (S5.BA2, 2026-10-26, plan s5a4 §5.4, Q-A2): always underwear, every outfit on Seedream at 2K with its coverage sentence; the cotton nightwear on the owner's model left,
// the tiers follow the tier table (r2.2 P6), the bedsheet is an implied cover and its moment pulls the sheet up instead of holding it (r2.2 P3), and plain underwear joins the
// satin on a legs frame (P-BA L1). The rows below were edited for it, each named in the commit.

const moments = NIGHTWEAR.places.flatMap((place) => place.moments.map((moment) => ({ place: place.name, moment })));
const momentNamed = (text: string): { place: string; moment: Moment } | undefined => moments.find((m) => m.moment.text === text);
const outfitNamed = (text: string): Outfit | undefined => NIGHTWEAR.outfits.find((o) => o.text === text);
const sorted = (items: readonly string[]): string[] => [...items].sort();

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN_DRESS = "Her nightdress is opaque satin.";

describe("«Ночнушки и бельё» validates as a «Смелая» bank", () => {
  test("it passes the «Смелая» schema", () => {
    expect(boldBankProblems(NIGHTWEAR)).toEqual([]);
  });

  // 5a.4 (S5.BA2): and the 5a.4 rules: always underwear (bold-floor), every outfit on Seedream, its tiers by the tier table, the bedsheet an implied cover.
  test("it passes the 5a.4 rules", () => {
    expect(boldAnyProblems(NIGHTWEAR, "nightwear")).toEqual([]);
  });

  test("the five's schema refuses it: its fields are «Смелая» only", () => {
    expect(categoryBankProblems(NIGHTWEAR, "home").join("\n")).toMatch(/\[shape\] : Unrecognized key: "bold"/);
  });
});

describe("who takes the photo: she shoots herself (I5.32)", () => {
  test("the deck of 12: four phone-over-face mirror frames, three mirrors, two from above, one prone, one over her shoulder, one timer", () => {
    expect(sorted(NIGHTWEAR.captureDeck)).toEqual(sorted(["mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror", "mirror", "mirror", "above", "above", "prone", "over-shoulder", "timer"]));
  });

  test("no moment is a photo someone else took: no friend, no candid, no low-feet", () => {
    const asked: Capture[] = ["friend", "candid", "low-feet"];
    expect(moments.filter((m) => m.moment.captures.some((c) => asked.includes(c))).map((m) => m.moment.text)).toEqual([]);
  });

  test("she lies on her stomach, and looks back over her shoulder, only on her bed; a close selfie from above lies there too", () => {
    for (const { place, moment } of moments) {
      if (moment.captures.some((c) => c === "prone" || c === "over-shoulder" || c === "above")) expect(place, moment.text).toBe("her bed");
      if (/\bstomach\b|\bprone\b/.test(moment.text)) expect(place, moment.text).toBe("her bed");
    }
  });

  test("a prone or over-the-shoulder frame wears no legwear (the approved prone frames had bare legs)", () => {
    for (const { moment } of moments.filter((m) => m.moment.captures.some((c) => c === "prone" || c === "over-shoulder"))) expect(moment.noLegwear, moment.text).toBe(true);
  });

  test("side or back to the mirror, only her reflection: three phone-over-face moments, tagged mirrorBack", () => {
    expect(moments.filter((m) => m.moment.mirrorBack === true).map((m) => `${m.place}: ${m.moment.text}`)).toEqual([
      "her bedroom: stands sideways to the mirror",
      "her bedroom: pulls her jeans up over her panties",
      "her bathroom: sits on the counter",
    ]);
    for (const { moment } of moments.filter((m) => m.moment.mirrorBack === true)) expect({ captures: moment.captures, angle: moment.angle }).toEqual({ captures: ["mirror-hidden"], angle: "three-quarter" });
  });
});

describe("the places (plan §6.2)", () => {
  test("five rooms of her home, with their lamp, mirror, times and details", () => {
    expect(NIGHTWEAR.places.map((p) => ({ name: p.name, at: p.at, room: p.room, lamp: p.lamp, mirror: p.mirror, times: p.times }))).toEqual([
      { name: "her bed", at: "on her bed", room: true, lamp: true, mirror: true, times: ["morning", "evening", "night"] },
      { name: "her bedroom", at: "in her bedroom", room: true, lamp: true, mirror: true, times: ["morning", "evening", "night"] },
      { name: "her bathroom", at: "in her bathroom", room: true, lamp: undefined, mirror: true, times: ["morning", "evening", "night"] },
      { name: "an armchair in her bedroom", at: "in an armchair in her bedroom", room: true, lamp: true, mirror: true, times: ["evening", "night"] },
      { name: "her bedroom window", at: "by her bedroom window", room: true, lamp: undefined, mirror: undefined, times: ["morning", "evening"] },
    ]);
  });
});

describe("the moments and their levels (plan §6.2)", () => {
  test.each<[string, string, readonly Capture[], "flirty" | "bold" | undefined, string]>([
    ["her bed", "lies back against the pillows", ["above"], undefined, "she slowly blinks and smiles"],
    ["her bed", "sits cross-legged with her coffee", ["mirror-hidden", "mirror"], undefined, "she sips and smiles a little"],
    ["her bed", "lies on her stomach, one arm out", ["prone"], undefined, "she swings her feet a little"],
    ["her bed", "lies prone, glancing back", ["over-shoulder"], undefined, "she turns her head a little further"],
    ["her bed", "lies prone, chin on her hand", ["prone"], "flirty", "she kicks her feet slowly behind her"],
    ["her bed", "lies on her stomach, hips behind", ["prone"], "bold", "she lifts her hips a little"],
    ["her bed", "lies on her stomach, feet up", ["over-shoulder"], "bold", "her raised feet swing slowly"],
    ["her bed", "lies back with her arms up", ["above"], "bold", "she stretches slowly and smiles"],
    ["her bed", "lies with the sheet up to her chest", ["above"], "bold", "she pulls the sheet a little higher"],
    // The stand-in's variety sweep (boldBanks.sweep.test.ts): an ordinary or flirty plan needs more than one moment for each frame from above, prone and over her shoulder.
    ["her bed", "lies on her side, head on her hand", ["above", "timer"], undefined, "she smiles a little and looks away"],
    ["her bed", "rests her cheek on the pillow", ["above"], undefined, "she slowly closes her eyes"],
    ["her bed", "lies curled up under the duvet", ["above", "timer"], undefined, "she pulls the duvet up a little"],
    ["her bed", "lies back, one knee up", ["above"], "flirty", "she sways her knee a little"],
    ["her bed", "lies prone, her cheek on her hand", ["prone"], undefined, "she slowly blinks and smiles"],
    ["her bed", "lies on her stomach, head tilted", ["prone"], undefined, "she tilts her head a little"],
    ["her bed", "lies prone, ankles crossed behind", ["over-shoulder"], undefined, "she crosses her raised ankles slowly"],
    ["her bed", "lies prone, feet raised behind", ["over-shoulder"], undefined, "her raised feet swing slowly behind her"],
    ["her bed", "lies back, hair across the pillow", ["above"], undefined, "she slowly turns her head"],
    ["her bed", "sits up against the headboard", ["mirror-hidden", "mirror"], undefined, "she leans her head back a little"],
    ["her bed", "sits with her legs tucked under her", ["mirror-hidden", "mirror"], undefined, "she shifts her weight a little"],
    ["her bedroom", "tucks her hair behind one ear", ["mirror-hidden", "mirror"], undefined, "she tucks her hair back slowly"],
    // Review round 2, MEDIUM 5: the cotton nightwear has no straps, so the strap moment is flirty and pins the outfits that have them.
    ["her bedroom", "adjusts the strap on her shoulder", ["mirror-hidden", "mirror"], "flirty", "she slides the strap up slowly"],
    // The mirror frames are more than half of a plan: an ordinary plan needs some sixteen moments in front of the mirror.
    ["her bed", "stretches out on the duvet", ["mirror-hidden", "mirror"], undefined, "she stretches her arms slowly"],
    ["her bedroom", "stands by the wardrobe", ["mirror-hidden", "mirror"], undefined, "she shifts her weight a little"],
    ["her bedroom", "holds a mug of tea", ["mirror-hidden", "mirror"], undefined, "she lifts the mug a little"],
    ["her bathroom", "pats on some face cream", ["mirror"], undefined, "she pats her cheek gently"],
    ["an armchair in her bedroom", "curls up with a blanket", ["mirror-hidden", "mirror"], undefined, "she pulls the blanket a little closer"],
    ["her bathroom", "fixes her hair in a clip", ["mirror-hidden", "mirror"], undefined, "she pins her hair up slowly"],
    ["an armchair in her bedroom", "pulls one knee up to her chest", ["mirror-hidden", "mirror", "timer"], undefined, "she rests her cheek a little lower"],
    ["her bedroom", "stretches after waking up", ["mirror-hidden", "mirror", "timer"], undefined, "she stretches her arms up slowly"],
    ["her bedroom", "sits on the edge of the bed", ["mirror-hidden", "mirror", "timer"], "flirty", "she swings one foot slowly"],
    ["her bedroom", "leans on the doorframe", ["mirror", "timer"], "flirty", "she shifts her shoulder slowly"],
    ["her bedroom", "stands with one hand on her hip", ["mirror-hidden", "mirror"], "bold", "she turns her hips a little"],
    ["her bedroom", "stands sideways to the mirror", ["mirror-hidden"], "bold", "she turns her head a little toward the mirror"],
    ["her bedroom", "pulls her jeans up over her panties", ["mirror-hidden"], "bold", "she tugs the waistband up slowly"],
    ["her bathroom", "brushes her hair", ["mirror-hidden", "mirror"], undefined, "she draws the brush down slowly"],
    ["her bathroom", "leans on the edge of the tub", ["mirror-hidden", "mirror"], undefined, "she leans back a little"],
    ["her bathroom", "leans toward the mirror", ["mirror"], "flirty", "she leans in a little closer"],
    ["her bathroom", "sits on the counter", ["mirror-hidden"], "bold", "she turns her head a little toward the mirror"],
    ["an armchair in her bedroom", "sits with one leg crossed", ["mirror-hidden", "mirror", "timer"], undefined, "she wiggles her crossed foot a bit"],
    ["an armchair in her bedroom", "tucks one leg under her", ["mirror-hidden", "mirror"], "flirty", "she settles a little deeper"],
    ["an armchair in her bedroom", "sits back, knees together", ["mirror-hidden", "mirror"], "bold", "she rocks a little in place"],
    ["her bedroom window", "stretches her arms up, facing away", ["timer"], undefined, "she stretches a little further"],
    ["her bedroom window", "opens the curtains", ["timer"], undefined, "she pulls the curtain a little wider"],
    ["her bedroom window", "leans against the wall", ["timer"], undefined, "she shifts her weight a little"],
    ["her bedroom window", "sits on the windowsill", ["timer"], "flirty", "she swings one foot a little"],
  ])("%s · «%s»", (place, text, captures, level, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, level: found?.moment.level, motion: found?.moment.motion, legs: found?.moment.legs }).toEqual({ captures, level, motion, legs: undefined });
  });

  test("every bold moment is drawn on Seedream, and no other moment is", () => {
    for (const { moment } of moments) expect({ text: moment.text, route: moment.route }).toEqual({ text: moment.text, route: moment.level === "bold" ? "seedream" : undefined });
  });

  // S5.9c round 2: the arms-up pin is the bank's own general outfits but the open shirt, so an outfit added to the bank reaches the arms-up moments by itself.
  // S5.R4 (the whole-slice review, LOW): and but the cropped tee, which rides up with her arms raised (24 frames of «lies back with her arms up» wore it): 13 -> 12.
  test("a stretch with her arms up pins every general outfit of the bank but the open shirt and the cropped tee, in the bank's order", () => {
    const general = NIGHTWEAR.outfits.filter((o) => o.pinOnly !== true && !/\bopen\b[^,]*\bshirt\b|\bcrop(?:ped)?\b/i.test(o.text)).map((o) => o.text);
    expect(general).toHaveLength(12);
    expect(general).not.toContain("a cropped tee and cotton panties");
    for (const text of ["stretches out on the duvet", "stretches after waking up", "stretches her arms up, facing away"]) expect(momentNamed(text)?.moment.outfits, text).toEqual(general);
  });

  // S5.R4 (the whole-slice review, LOW): under the duvet or a blanket a bold outfit does not show, and the 2K frame was paid for nothing («curls up with a blanket, wearing a white lace
  // bra and panties»). The covering moments pin every general outfit of the bank that is not bold, in the bank's order.
  test("a moment under the duvet or a blanket pins every general outfit but the bold ones", () => {
    const notBold = NIGHTWEAR.outfits.filter((o) => o.pinOnly !== true && o.level !== "bold").map((o) => o.text);
    // 5a.4 (Q-A2, r2.2 P6): plain underwear in place of the cotton nightwear, and the lace sets, now flirty.
    expect(notBold).toEqual([
      "a tee and cotton panties",
      "a cotton bra and briefs",
      "a cami and cotton panties",
      "a satin slip nightdress",
      "a satin midi nightdress",
      "a satin cami and satin shorts",
      "a short tied satin robe",
      "a black lace bra and panties",
      "a white lace bra and panties",
      "a cropped tee and cotton panties",
    ]);
    for (const text of ["lies curled up under the duvet", "curls up with a blanket"]) expect(momentNamed(text)?.moment.outfits, text).toEqual(notBold);
  });

  // Review round 2: arms up, the open shirt would not stay closed over her chest. S5.R4: nor would the cropped tee, which rides up.
  test("her arms up, she wears lingerie that stays in place, never the open shirt or the cropped tee", () => {
    expect(momentNamed("lies back with her arms up")?.moment.outfits).toEqual(["a black lace bra and panties", "a white lace bra and panties", "a lace bodysuit", "a sheer babydoll over a lace set"]);
  });

  test("the strap moment wears only an outfit with straps: the satin nightwear, the lace sets, the bodysuit, the babydoll", () => {
    expect(momentNamed("adjusts the strap on her shoulder")?.moment.outfits).toEqual(["a satin slip nightdress", "a satin midi nightdress", "a satin cami and satin shorts", "a black lace bra and panties", "a white lace bra and panties", "a lace bodysuit", "a sheer babydoll over a lace set"]);
  });

  test("the over-her-shoulder frames are three-quarter: she looks back along her body", () => {
    for (const { moment } of moments.filter((m) => m.moment.captures.includes("over-shoulder"))) expect(moment.angle, moment.text).toBe("three-quarter");
  });

  test("seen from behind at the window, she stretches (review round 2: a frame from behind shows what she does)", () => {
    expect(momentNamed("stretches her arms up, facing away")?.moment).toMatchObject({ angle: "back", twoHanded: true });
    expect(momentNamed("opens the curtains")?.moment).toMatchObject({ twoHanded: true, gaze: "focus" });
  });

  // 5a.4 (Q-A2): the tee and cotton panties on Seedream in place of the grey lounge shorts on the owner's model (Seedream drew prone lingerie: P-5a3 #4, P-NUDE C1, P-BA A1).
  test("the prone selfies wear what drew: the tee and cotton panties, satin or lingerie, on Seedream", () => {
    for (const text of ["lies on her stomach, one arm out", "lies prone, glancing back", "lies prone, her cheek on her hand", "lies on her stomach, head tilted", "lies prone, ankles crossed behind", "lies prone, feet raised behind"]) {
      expect(momentNamed(text)?.moment.outfits, text).toEqual(["a tee and cotton panties"]);
    }
    expect(momentNamed("lies prone, her cheek on her hand")?.moment.handAtFace).toBe(true);
    expect(momentNamed("lies on her side, head on her hand")?.moment.handAtFace).toBe(true);
    expect(momentNamed("lies prone, chin on her hand")?.moment).toMatchObject({ outfits: ["a tee and cotton panties", "a satin cami and satin shorts"], handAtFace: true });
    // P-5a3 #4: Seedream drew it, and no phone in her hands.
    expect(momentNamed("lies on her stomach, hips behind")?.moment.outfits).toEqual(["a black bra and briefs"]);
    expect(momentNamed("lies on her stomach, feet up")?.moment.outfits).toEqual(["a black lace bra and panties"]);
  });
});

describe("the P-5a3 decisions", () => {
  test("the arm over her chest with only lace panties left the bank (refused 6/6)", () => {
    const texts = [...moments.map((m) => m.moment.text), ...NIGHTWEAR.outfits.map((o) => o.text)].join(" | ");
    expect(texts).not.toMatch(/covers her chest with her arm|only lace panties/);
  });

  // 5a.4 (r2.2 P3, P5; I5.74): an implied cover, a Studio-created avatar's only. On `above` her near hand holds the phone and her other hand is free, so the moment pulls the sheet up
  // instead of holding it; P-BA V2 drew the sheet with the «pulled up» kept sentence, which every avatar says (no open item was probed).
  test("the bedsheet stays (drawn 3/3): an implied cover, the moment pins it and carries the coverage, the kept one for every avatar", () => {
    const SHEET = "The white sheet is pulled up to her chest and fully covers her breasts and her hips.";
    expect(momentNamed("lies with the sheet up to her chest")?.moment).toMatchObject({ outfits: ["only the white bedsheet"], coverage: SHEET, openCoverage: SHEET, tier: "implied", level: "bold", route: "seedream" });
    expect(outfitNamed("only the white bedsheet")).toEqual({ text: "only the white bedsheet", pinOnly: true, level: "bold", route: "seedream", tier: "implied" });
    expect(moments.map((m) => m.moment.text)).not.toContain("lies holding the sheet to her chest");
  });

  test("the sheer babydoll over a lace set stays (drawn with thigh-high stockings), bold, with its coverage", () => {
    expect(outfitNamed("a sheer babydoll over a lace set")).toEqual({
      text: "a sheer babydoll over a lace set",
      showsLegs: true,
      level: "bold",
      route: "seedream",
      coverage: "Under her sheer babydoll, her lace bra and panties are lined and opaque and fully cover her.",
    });
  });

  // 5a.4 (P-BA L1 drew the sports set on a legs frame): plain cotton underwear joins the satin; lace stays out, and the stockings still go with the satin only.
  test("a legs frame wears no lace (#6: stockings with lingerie on a legs frame was refused): satin, the bold stockings on a bold slot, or plain cotton", () => {
    const legs = moments.filter((m) => m.moment.legs !== undefined);
    // S5.R4: 4 -> 7, so the six legs slots of a 20-photo run at «Ножки» 30 % never repeat one.
    expect(legs.length).toBe(7);
    for (const { moment } of legs) {
      expect(moment.outfits, moment.text).toEqual(["a satin cami and satin shorts", "a satin midi nightdress", "a short tied satin robe", "a tee and cotton panties", "a cami and cotton panties"]);
      for (const outfit of moment.outfits ?? []) expect({ outfit, lace: /\blace\b/.test(outfit), lingerie: lingerieWordsIn(outfit).length > 0 && !/\bcotton\b/.test(outfit) }).toEqual({ outfit, lace: false, lingerie: false });
    }
  });
});

describe("the legs moments (plan §6.2, S5.8a rules, M5)", () => {
  test.each<[string, string, readonly Capture[], string]>([
    // S5.R4 round 3: its motion was «Дом»'s and the beach's word for word.
    ["her bed", "lies with her legs crossed", ["pov-legs"], "she slides one ankle over the other slowly"],
    // S5.R4 round 2: worded apart from «Фитнес»'s and «Дом»'s moments of the same text; the poses are the same.
    ["an armchair in her bedroom", "stretches out her legs", ["pov-legs"], "she points her toes slowly"],
    // S5.R4 round 3: in place of «lifts one foot to the mirror» and «crosses her legs, a foot dangling» (C3′'s chair frame), which were «Дом»'s poses with «Дом»'s motions.
    ["her bathroom", "stands with her feet together", ["mirror-hidden"], "she turns one foot out slowly"],
    ["an armchair in her bedroom", "sits, legs over the armrest", ["mirror-hidden"], "she bounces her feet a little"],
    // S5.R4: three more, so a 20-photo run at «Ножки» 30 % never repeats one; round 2: each a pose of its own.
    ["her bed", "lies on her side, one knee bent", ["pov-legs"], "she slides her top knee forward a little"],
    ["her bedroom", "stands on tiptoe by the mirror", ["mirror-hidden"], "she rises a little higher on her toes"],
    // S5.R4 round 3: in place of «kneels in front of the mirror» (her legs folded under her cannot fill the frame).
    ["her bedroom", "steps toward the mirror", ["mirror-hidden"], "she takes a small step closer"],
  ])("%s · «%s»", (place, text, captures, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, motion: found?.moment.motion, legs: found?.moment.legs, level: found?.moment.level }).toEqual({ captures, motion, legs: { framing: "legs" }, level: undefined });
  });
});

test("no legs frame puts her feet or soles to the mirror: the composition the owner called a strange photo (C3′ R1#08)", () => {
  expect(moments.filter((m) => /\b(?:feet|soles)\b[^,]*\bmirror\b/.test(m.moment.text)).map((m) => m.moment.text)).toEqual([]);
});

// 5a.4 (S5.BA2, Q-A2, r2.2 P6): every outfit on Seedream with its kept coverage, in its tier by the tier table. The retags against 5a.3: the satin cami and shorts flirty -> plain;
// the black and white lace sets bold -> flirty; the cropped tee and cotton panties, the black bra and briefs and the crop top (now «a crop top with panties and jeans») bold -> plain;
// a new white lace bra and a thong at bold.
describe("the outfits: plain underwear, lace and satin, the most revealing (plan s5a4 §5.4)", () => {
  test.each<[string, string, boolean]>([
    ["a tee and cotton panties", "Her tee covers her chest, and her panties fully cover her.", false],
    ["a cotton bra and briefs", "Her bra fully covers her breasts and her briefs fully cover her.", false],
    ["a cami and cotton panties", "Her cami covers her chest, and her panties fully cover her.", false],
    ["a cropped tee and cotton panties", "Her tee covers her chest, and her panties fully cover her.", false],
    ["a black bra and briefs", "Her bra fully covers her breasts and her briefs fully cover her.", true],
  ])("plain, on Seedream: «%s»", (text, coverage, pinOnly) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, ...(pinOnly ? { pinOnly: true } : {}), route: "seedream", coverage });
  });

  // Review M1 (2026-10-26): P-BA drew no satin without its coverage, so the satin says its kept sentence to every avatar.
  test("plain, on Seedream, its kept sentence for every avatar: «a satin cami and satin shorts»", () => {
    const coverage = "Her cami and shorts are opaque satin.";
    expect(outfitNamed("a satin cami and satin shorts")).toEqual({ text: "a satin cami and satin shorts", showsLegs: true, route: "seedream", coverage, openCoverage: coverage });
  });

  test.each<[string, string, boolean]>([
    // Review M1: the satin says its kept sentence to every avatar.
    ["a satin slip nightdress", SATIN_DRESS, true],
    ["a satin midi nightdress", SATIN_DRESS, true],
    ["a short tied satin robe", "Her robe is tied and closed over her chest.", true],
    ["a black lace bra and panties", LACE, false],
    ["a white lace bra and panties", LACE, false],
  ])("flirty, on Seedream: «%s»", (text, coverage, kept) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, level: "flirty", route: "seedream", coverage, ...(kept ? { openCoverage: coverage } : {}) });
  });

  test.each<[string, string]>([
    ["a lace bodysuit", "Her bodysuit is lined and opaque over her chest and fully covers her hips."],
    ["an open white shirt and panties", "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her."],
    ["a white lace bra and a thong", "The lace is lined and opaque: her bra fully covers her breasts and her thong fully covers her in front."],
  ])("the most revealing, on Seedream: «%s»", (text, coverage) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, level: "bold", route: "seedream", coverage });
  });

  test("pulling her jeans up over her panties pins a crop top with panties and jeans, and the moment carries the coverage", () => {
    expect(outfitNamed("a crop top with panties and jeans")).toEqual({ text: "a crop top with panties and jeans", pinOnly: true, route: "seedream" });
    expect(momentNamed("pulls her jeans up over her panties")?.moment).toMatchObject({ outfits: ["a crop top with panties and jeans"], coverage: "Her panties fully cover her bottom, and her crop top covers her chest.", level: "bold" });
  });

  test("no other outfit is in the bank, and the cotton nightwear on the owner's model left it", () => {
    expect(NIGHTWEAR.outfits).toHaveLength(17);
    const texts = NIGHTWEAR.outfits.map((o) => o.text);
    for (const gone of ["an oversized sleep tee", "cotton pajama shorts and a tee", "a long cotton nightshirt", "silk pajamas", "grey jersey lounge shorts and a tee", "a crop top and jeans"]) expect(texts).not.toContain(gone);
  });

  test("every outfit is drawn on Seedream (Q-A2), and the general draw keeps four of the most revealing", () => {
    for (const outfit of NIGHTWEAR.outfits) expect({ text: outfit.text, route: outfit.route }).toEqual({ text: outfit.text, route: "seedream" });
    expect(NIGHTWEAR.outfits.filter((o) => o.pinOnly !== true && o.level === "bold").map((o) => o.text)).toEqual(["a lace bodysuit", "a sheer babydoll over a lace set", "an open white shirt and panties", "a white lace bra and a thong"]);
  });

  // Review M1: P-BA drew the lingerie classes without their coverage (A1, A3), no satin: only the satin says its kept sentence as its open one.
  // Review M1/N1: by the table of the classes P-BA drew open (banks/boldRules.ts `openClassOf`): an outfit of such a class says no open coverage; every other one (the satin) says its
  // kept one as its open one.
  test.each<[string, string | null]>([
    ["a tee and cotton panties", "A1"],
    ["a cotton bra and briefs", "A1"],
    ["a cami and cotton panties", "A1"],
    ["a cropped tee and cotton panties", "A1"],
    ["a black bra and briefs", "A1"],
    ["a crop top with panties and jeans", "S1"],
    ["a black lace bra and panties", "V1"],
    ["a white lace bra and panties", "V1"],
    ["a lace bodysuit", "G1"],
    ["a sheer babydoll over a lace set", "G2"],
    ["an open white shirt and panties", "A3"],
    ["a white lace bra and a thong", "S2"],
    ["a satin slip nightdress", null],
    ["a satin midi nightdress", null],
    ["a satin cami and satin shorts", null],
    ["a short tied satin robe", null],
  ])("«%s»: class %p, and its open coverage by it", (text, probe) => {
    const outfit = outfitNamed(text);
    if (probe === null) expect(openClassOf(text)).toBeNull();
    else expect(openClassOf(text)).toStartWith(probe);
    expect(outfit?.openCoverage).toBe(probe === null ? outfit?.coverage : undefined);
  });

  test("the table names every outfit of the bank but the implied bedsheet", () => {
    expect(NIGHTWEAR.outfits.filter((o) => o.tier !== "implied")).toHaveLength(16);
  });
});

// Review round 2, MEDIUM 4 (P-5a3 #6): a bold legs frame is satin with stockings. The stockings never go with the cotton nightwear on the owner's model, and on a
// legs moment the outfits they go with are the satin ones.
test("the stockings go with Seedream outfits only, never cotton; on a legs moment, with the satin nightwear only", () => {
  const goWith = NIGHTWEAR.legwear?.bold?.outfits ?? [];
  for (const text of goWith) expect({ text, route: outfitNamed(text)?.route }).toEqual({ text, route: "seedream" });
  expect(goWith.filter((t) => /cotton/.test(t))).toEqual([]);
  for (const { moment } of moments.filter((m) => m.moment.legs !== undefined)) {
    const pinned = (moment.outfits ?? []).filter((o) => goWith.includes(o));
    expect({ text: moment.text, pinned }).toEqual({ text: moment.text, pinned: ["a satin cami and satin shorts", "a satin midi nightdress", "a short tied satin robe"] });
  }
});

// Review round 2 (C3′, the owner: «просто стоит спиной без какой-либо позы»): a moment seen from behind or in profile names what she is doing.
test("every moment seen from behind or in profile names a readable action and never walks away (C3′, main's rule)", () => {
  const away = moments.filter((m) => m.moment.angle === "back" || m.moment.angle === "profile");
  expect(away.length).toBeGreaterThan(0);
  expect(away.filter((m) => (!AWAY_ACTION_WORDS.test(m.moment.text) || WALKS_AWAY_WORDS.test(m.moment.text))).map((m) => m.moment.text)).toEqual([]);
});

// Review round 2 (C3′, the owner's verdict): Grok draws a skirt or shorts named without its fabric as denim. The prone lounge shorts are jersey (as «Дом»'s on
// fix/c3-prompts), the satin set's shorts are satin.
test("every skirt or shorts of the bank names its fabric (C3′, main's detector)", () => {
  const texts = [...NIGHTWEAR.outfits.map((o) => o.text), ...moments.flatMap((m) => m.moment.outfits ?? [])];
  expect(texts.filter((t) => unfabricBottomsIn(t).length > 0)).toEqual([]);
});

describe("the legwear: socks and tights at ordinary and flirty, stockings on a bold slot (Q-A)", () => {
  test("the slots and their shares", () => {
    expect(NIGHTWEAR.legwear).toEqual({
      items: ["thigh-high socks", "sheer black tights"],
      share: 0.3,
      bold: {
        items: ["black thigh-high stockings", "sheer black stockings", "white lace-top stockings"],
        share: 0.5,
        route: "seedream",
        outfits: [
          "a satin slip nightdress",
          "a satin midi nightdress",
          "a satin cami and satin shorts",
          "a short tied satin robe",
          "a black lace bra and panties",
          "a white lace bra and panties",
          "a lace bodysuit",
          "a sheer babydoll over a lace set",
          "an open white shirt and panties",
        ],
      },
    });
  });
});
