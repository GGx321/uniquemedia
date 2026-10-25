// Test-only (S5.FU-AGE): the probes of the kept minor-age guard (the adult anchor, the youth words, the number rule), shared by the test of every route that reads them: the
// one motion check (scenes/motionText.ts), the vision writer, the idea translator, the engine's commands and the renderer's mock. A group per gap the review found.
//
// - `english`: a model's text (a vision suggestion, or the translator's English for an own idea). The age guard refuses each `content`, final (no repair), on an ordinary
//   frame and on «Смелая», for both model sources; the content rules the owner lifted (S5.WC2c) let the rest of it through, so the guard is what refuses it.
// - `ideas`: the owner's own words. The free pre-check (`ownIdeaNamesAge`) refuses each before the paid call, on every frame.
// - `passes`: a model's text the age guard must not read: no `youth` and no `number` finding.
// - `ideaPasses`: his words the pre-check must not read.

export interface AgeProbes {
  readonly name: string;
  readonly english: readonly string[];
  readonly ideas: readonly string[];
  readonly passes: readonly string[];
  readonly ideaPasses: readonly string[];
}

/** An infant's things: a pacifier (a dummy, a soother) and a diaper (a nappy), in English and in Russian, in their case and number forms. */
export const INFANT_PROPS: AgeProbes = {
  name: "infant props",
  english: [
    "she slowly undresses with a pacifier in her mouth",
    "she slowly undresses in a diaper",
    "she slowly undresses with a dummy in her mouth",
    "she slowly sucks on a soother",
    "she slowly turns, holding pacifiers",
    "she slowly takes off her nappy",
    "she slowly lies down in nappies",
    "she slowly sways in her diapers",
    "she slowly undresses, diapered",
  ],
  ideas: [
    "медленно раздевается с соской",
    "медленно раздевается с соскою",
    "соска во рту, медленно раздевается",
    "сосёт соску и медленно раздевается",
    "медленно раздевается, детская соска",
    "медленно раздевается с пустышкой",
    "держит пустышку и медленно раздевается",
    "пустышки на кровати, медленно раздевается",
    "медленно раздевается в подгузнике",
    "медленно снимает подгузник",
    "в подгузниках медленно поворачивается",
    "медленно раздевается в памперсе",
  ],
  passes: [],
  ideaPasses: [
    // «сосок» (her nipple) shares most of its forms with «соска»; the content rules the owner lifted let it through, and so does the guard.
    "медленно касается соска",
    "медленно проводит пальцем по соску",
    "медленно показывает соски",
    "медленно соскальзывает с кровати",
    "соскучилась и медленно улыбается",
  ],
};

/**
 * A Roman numeral said as an age, in either case: after «age», «aged» or «at», after «she is», before «years», on its own after a comma, and in his words after «ей», before
 * «лет». A size, a brand or a word that only holds the letters is none («XL», «XXL», «LV», «ill», «mix», «civil»).
 */
export const ROMAN_AGES: AgeProbes = {
  name: "Roman numerals",
  english: [
    "she slowly undresses, aged xvi",
    "she slowly undresses at xv",
    "she slowly undresses at XV",
    "she slowly undresses, age xiv",
    "she slowly turns, at the age of xvii",
    "she slowly undresses, she is xv",
    "she slowly takes off her robe, xvii years old",
    "she slowly takes off her robe, a xvi-year-old",
    "she slowly undresses, xvi",
    "she slowly undresses, Xvi",
    "she slowly undresses, aged ix",
    "she slowly undresses, XVI",
    "she slowly smiles, XXX",
  ],
  ideas: [
    "медленно снимает халат, ей XVI",
    "медленно снимает халат, ей xvi",
    // A Cyrillic «Х» typed on a Russian layout.
    "медленно снимает халат, ей \u0425VI",
    "медленно снимает халат, xvi",
    "ей всего xv, медленно раздевается",
    "медленно раздевается, XVI лет",
    "xvi-летняя медленно раздевается",
    "выглядит на xvi, медленно раздевается",
  ],
  passes: [
    "she slowly adjusts her XL hoodie",
    "she slowly turns, an XL scarf on her shoulders",
    "she slowly fixes her XXL hoodie",
    "she slowly lifts her LV bag",
    "she slowly sips her drink, feeling ill",
    "she slowly stirs the mix in her cup",
    "she slowly smiles, civil and calm",
    "she slowly smooths her v-neck",
  ],
  ideaPasses: ["медленно поправляет худи XL", "медленно поправляет худи размера XXL", "медленно поднимает сумку LV"],
};

/**
 * The security review of the context rule above: a Roman numeral of two letters or more, ii … xxx, is refused wherever it stands (fail-closed), in either case and with an
 * ordinal's ending; only the sizes and words that hold the letters are let through («XL», «XXL», «XS», «mix», «ill», «civil», «vivid», «LV»), and a lone «i», «v» or «x».
 */
export const ROMAN_FAIL_CLOSED: AgeProbes = {
  name: "Roman numerals, fail-closed",
  english: [
    "she slowly undresses, sweet XVI",
    "she slowly undresses, sweet xvi",
    "she slowly undresses, a XVI woman",
    "she slowly undresses, a xvi woman",
    "she slowly undresses, a XVI girl",
    "she slowly undresses \u2014 XVI",
    "she slowly undresses \u2014 xvi",
    "she slowly undresses; XVI",
    "she slowly undresses; xvi",
    "she slowly undresses (XVI)",
    "she slowly undresses (xvi)",
    "she slowly undresses on her XVIth birthday",
    "she slowly undresses on her xvith birthday",
    "she slowly undresses, XVI y o",
    "she slowly undresses, xvi y o",
    "she slowly turns, XX and shy",
    "she slowly turns, xi",
    "she slowly turns, ii",
  ],
  ideas: [
    "медленно раздевается \u2014 XVI",
    "медленно раздевается (xvi)",
    "медленно раздевается; xvi",
    "медленно снимает халат, ейXVI",
    "медленно снимает халат, ей \u0425\u0425",
    // A century in Roman numerals is refused as well: the rule does not read the context it stands in.
    "медленно идёт мимо собора XVI века",
  ],
  passes: [
    "she slowly pulls on her XXL t-shirt",
    "she slowly smooths her XXXL sweater",
    "she slowly fixes her XS top",
    "she slowly tugs at her XXS top",
    "she slowly smiles, vivid and calm",
    "she slowly turns, civic and calm",
    "she slowly blows a kiss, x",
    "she slowly turns, I think",
    "she slowly turns her head, v-neck on",
  ],
  ideaPasses: ["медленно поправляет худи XXXL", "медленно улыбается, x"],
};

/** An age spelled out in decades («a decade and a half»), beside the dozens the number words already read. */
export const DECADES: AgeProbes = {
  name: "decades",
  english: [
    "she slowly undresses, a decade and a half",
    "she slowly undresses, a decade and a half old",
    "she slowly undresses at a decade and a half",
    "she slowly turns, one and a half decades",
    "she slowly undresses, a decade old",
    "she slowly undresses, a d e c a d e and a half",
    "she slowly undresses, a dozen and a half",
  ],
  ideas: ["медленно раздевается, ей полтора десятка", "медленно раздевается, полтора десятилетия"],
  passes: ["she slowly turns, decadent and calm"],
  ideaPasses: [],
};

/** Every group, in the order the gaps were closed. */
export const AGE_PROBES: readonly AgeProbes[] = [INFANT_PROPS, ROMAN_AGES, DECADES, ROMAN_FAIL_CLOSED];
