import { describe, expect, test } from "bun:test";
import type { Capture } from "../captures";
import { boldWordsIn, lingerieWordsIn } from "./boldRules";
import { AWAY_ACTION, unfabricBottomsOf } from "./boldDesign.testkit";
import { NIGHTWEAR } from "./nightwear";
import { boldBankProblems, categoryBankProblems } from "./schema";
import type { Moment, Outfit } from "./types";

// 5a.3 (S5.9b2, plan s5a3 §6.2 r3.1): «Ночнушки и бельё», a «Смелая» bank. At home she shoots herself: in the mirror (a third of the frames with the phone over her
// face), at arm's length from above as she lies there, lying on her stomach on her bed, over her own shoulder, on a timer. Ordinary is cotton nightwear on the owner's
// model; flirty is satin nightwear and bold is lingerie, both on Seedream at 2K, each with a positive coverage sentence. P-5a3 decided four items: the arm over her
// chest with only lace panties was refused 6/6 and left; the bedsheet, the babydoll with stockings and the prone bra and briefs were drawn and stay; a legs frame wears
// satin with stockings, never lingerie (#6). The bank text is the product: these rows pin it.

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
    ["her bed", "sits cross-legged with her coffee", ["mirror"], undefined, "she sips and smiles a little"],
    ["her bed", "lies on her stomach, one arm out", ["prone"], undefined, "she swings her feet a little"],
    ["her bed", "lies prone, glancing back", ["over-shoulder"], undefined, "she turns her head a little further"],
    ["her bed", "lies prone, chin on her hand", ["prone"], "flirty", "she kicks her feet slowly behind her"],
    ["her bed", "lies on her stomach, hips behind", ["prone"], "bold", "she lifts her hips a little"],
    ["her bed", "lies on her stomach, feet up", ["over-shoulder"], "bold", "her raised feet swing slowly"],
    ["her bed", "lies back with her arms up", ["above"], "bold", "she stretches slowly and smiles"],
    ["her bed", "lies holding the sheet to her chest", ["above"], "bold", "she pulls the sheet a little higher"],
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

  test("the prone selfies wear what drew: grey lounge shorts on the owner's model, satin or lingerie on Seedream", () => {
    for (const text of ["lies on her stomach, one arm out", "lies prone, glancing back", "lies prone, her cheek on her hand", "lies on her stomach, head tilted", "lies prone, ankles crossed behind", "lies prone, feet raised behind"]) {
      expect(momentNamed(text)?.moment.outfits, text).toEqual(["grey jersey lounge shorts and a tee"]);
    }
    expect(momentNamed("lies prone, her cheek on her hand")?.moment.handAtFace).toBe(true);
    expect(momentNamed("lies on her side, head on her hand")?.moment.handAtFace).toBe(true);
    expect(momentNamed("lies prone, chin on her hand")?.moment).toMatchObject({ outfits: ["grey jersey lounge shorts and a tee", "a satin cami and satin shorts"], handAtFace: true });
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

  test("the bedsheet stays (drawn 3/3): the moment pins it and carries the coverage", () => {
    expect(momentNamed("lies holding the sheet to her chest")?.moment).toMatchObject({
      outfits: ["only the white bedsheet"],
      coverage: "The white sheet is held up to her chest and fully covers her breasts and her hips.",
      level: "bold",
      route: "seedream",
    });
    expect(outfitNamed("only the white bedsheet")).toEqual({ text: "only the white bedsheet", pinOnly: true, level: "bold", route: "seedream" });
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

  test("a legs frame wears no lingerie (#6: stockings with lingerie on a legs frame was refused): cotton, or satin with the bold stockings", () => {
    const legs = moments.filter((m) => m.moment.legs !== undefined);
    expect(legs.length).toBe(4);
    for (const { moment } of legs) {
      expect(moment.outfits, moment.text).toEqual(["cotton pajama shorts and a tee", "a long cotton nightshirt", "a satin cami and satin shorts", "a satin midi nightdress"]);
      for (const outfit of moment.outfits ?? []) expect(lingerieWordsIn(outfit), outfit).toEqual([]);
    }
  });
});

describe("the legs moments (plan §6.2, S5.8a rules, M5)", () => {
  test.each<[string, string, readonly Capture[], string]>([
    ["her bed", "lies with her legs crossed", ["pov-legs"], "she crosses and uncrosses her ankles slowly"],
    ["an armchair in her bedroom", "sits with her legs stretched out", ["pov-legs"], "she points her toes slowly"],
    ["her bedroom", "lifts one foot to the mirror", ["mirror-hidden"], "she lifts her foot a little and lowers it"],
    // Review round 2, HIGH 3 (C3′ R1#08, «странное фото»): the owner's own idea, on the chair in front of the mirror, legs crossed, one foot dangling.
    ["an armchair in her bedroom", "sits, legs crossed, a foot dangling", ["mirror-hidden"], "she swings her dangling foot slowly"],
  ])("%s · «%s»", (place, text, captures, motion) => {
    const found = momentNamed(text);
    expect(found?.place).toBe(place);
    expect({ captures: found?.moment.captures, motion: found?.moment.motion, legs: found?.moment.legs, level: found?.moment.level }).toEqual({ captures, motion, legs: { framing: "legs" }, level: undefined });
  });
});

test("no legs frame puts her feet or soles to the mirror: the composition the owner called a strange photo (C3′ R1#08)", () => {
  expect(moments.filter((m) => /\b(?:feet|soles)\b[^,]*\bmirror\b/.test(m.moment.text)).map((m) => m.moment.text)).toEqual([]);
});

describe("the outfits: cotton, satin, lingerie (plan §6.2)", () => {
  test.each<[string, boolean, boolean]>([
    ["an oversized sleep tee", true, false],
    ["cotton pajama shorts and a tee", true, false],
    ["a long cotton nightshirt", true, false],
    ["silk pajamas", false, false],
    ["grey jersey lounge shorts and a tee", true, true],
  ])("ordinary, on the owner's model: «%s»", (text, showsLegs, pinOnly) => {
    const outfit = outfitNamed(text);
    expect(outfit).toEqual({ text, ...(showsLegs ? { showsLegs: true } : {}), ...(pinOnly ? { pinOnly: true } : {}) });
  });

  test.each<[string, string]>([
    ["a satin slip nightdress", SATIN_DRESS],
    ["a satin midi nightdress", SATIN_DRESS],
    ["a satin cami and satin shorts", "Her cami and shorts are opaque satin."],
    ["a short tied satin robe", "Her robe is tied and closed over her chest."],
  ])("flirty, on Seedream (Grok refused satin 2/2): «%s»", (text, coverage) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, level: "flirty", route: "seedream", coverage });
  });

  test.each<[string, string, boolean]>([
    ["a black lace bra and panties", LACE, false],
    ["a white lace bra and panties", LACE, false],
    ["a lace bodysuit", "Her bodysuit is lined and opaque over her chest and fully covers her hips.", false],
    ["a cropped tee and cotton panties", "Her tee covers her chest, and her panties fully cover her.", false],
    ["an open white shirt and panties", "The shirt's two edges fall over her chest and fully cover both breasts, leaving only a narrow gap of skin down the middle; her panties fully cover her.", false],
    ["a black bra and briefs", "Her bra fully covers her breasts and her briefs fully cover her.", true],
  ])("bold, on Seedream: «%s»", (text, coverage, pinOnly) => {
    expect(outfitNamed(text)).toEqual({ text, showsLegs: true, ...(pinOnly ? { pinOnly: true } : {}), level: "bold", route: "seedream", coverage });
  });

  test("pulling her jeans up over her panties pins a crop top and jeans, and the moment carries the coverage", () => {
    expect(outfitNamed("a crop top and jeans")).toEqual({ text: "a crop top and jeans", pinOnly: true, level: "bold", route: "seedream" });
    expect(momentNamed("pulls her jeans up over her panties")?.moment).toMatchObject({ outfits: ["a crop top and jeans"], coverage: "Her panties fully cover her bottom, and her crop top covers her chest." });
  });

  test("no other outfit is in the bank", () => {
    expect(NIGHTWEAR.outfits).toHaveLength(18);
  });

  test("every Seedream outfit names the «Смелая» vocabulary or is bold, and the cotton ones name none of it", () => {
    for (const outfit of NIGHTWEAR.outfits) expect({ text: outfit.text, seedream: outfit.route === "seedream" }).toEqual({ text: outfit.text, seedream: boldWordsIn(outfit.text).length > 0 || outfit.level === "bold" });
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
    expect({ text: moment.text, pinned }).toEqual({ text: moment.text, pinned: ["a satin cami and satin shorts", "a satin midi nightdress"] });
  }
});

// Review round 2 (C3′, the owner: «просто стоит спиной без какой-либо позы»): a moment seen from behind or in profile names what she is doing.
test("every moment seen from behind or in profile names a readable action (C3′)", () => {
  const away = moments.filter((m) => m.moment.angle === "back" || m.moment.angle === "profile");
  expect(away.length).toBeGreaterThan(0);
  expect(away.filter((m) => !AWAY_ACTION.test(m.moment.text)).map((m) => m.moment.text)).toEqual([]);
});

// Review round 2 (C3′, the owner's verdict): Grok draws a skirt or shorts named without its fabric as denim. The prone lounge shorts are jersey (as «Дом»'s on
// fix/c3-prompts), the satin set's shorts are satin.
test("every skirt or shorts of the bank names its fabric (C3′)", () => {
  const texts = [...NIGHTWEAR.outfits.map((o) => o.text), ...moments.flatMap((m) => m.moment.outfits ?? [])];
  expect(texts.filter((t) => unfabricBottomsOf(t).length > 0)).toEqual([]);
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
