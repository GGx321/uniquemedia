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
    // Round 2 (L11): split by hyphens into parts too long for the short-fragment join.
    "she slowly undresses with a paci-fier in her mouth",
    "she slowly undresses in a dia-pers",
    // Round 3 (N1): «old-school» is a style only as the whole word.
    "she slowly undresses like an oldschoolgirl",
    "she slowly undresses in an oldschooluniform",
    // Round 2 (M4): more of an infant's things.
    "she slowly shakes a rattle",
    "she slowly chews on a teether",
    "she slowly sips from a sippy cup",
    "she slowly lies down in a crib",
    "she slowly undresses in a baby bib",
    "she slowly holds a bottle of formula",
  ],
  ideas: [
    "медленно раздевается с соской",
    "медленно раздевается с соскою",
    "берёт соску в рот и медленно раздевается",
    // The nominative «соска» before «во рту» is a pacifier (round-2 security review of M2); after «кончик», «вокруг», «ореол» it is «сосок», her nipple.
    "соска во рту, медленно раздевается",
    "держу соску во рту и медленно раздеваюсь",
    "сосёт соску и медленно раздевается",
    "медленно раздевается, детская соска",
    "медленно раздевается с пустышкой",
    // Round 2 (L1): «пустышка» only where it is a pacifier.
    "берёт пустышку в рот и медленно раздевается",
    "сосёт пустышку и медленно раздевается",
    "пустышка во рту, медленно раздевается",
    "медленно раздевается в подгузнике",
    "медленно снимает подгузник",
    "в подгузниках медленно поворачивается",
    "медленно раздевается в памперсе",
    "медленно трясёт погремушкой",
    "в слюнявчике медленно раздевается",
    "в ползунках медленно раздевается",
    "медленно ложится в детскую кроватку",
    "держит бутылочку смеси и медленно раздевается",
  ],
  passes: [
    "she slowly turns, old school glamour",
    "she slowly turns, old-school glamour",
    "she slowly turns, oldschool glamour",
    "she slowly rattles her keys",
    "she slowly turns at a rattle of keys",
    // Round 2 (L1): a dummy or a soother is a pacifier only in her mouth or sucked; nappy hair is hair.
    "she slowly poses beside a tailor's dummy",
    "she slowly leans on a crash test dummy",
    "she slowly lights a soother candle",
    "she slowly touches her natural nappy coils",
  ],
  ideaPasses: [
    // Round 2 (M4): «малыш» is a common pet name for an adult, «кроватка» his own bed, «ползунок» a slider, a bottle of water no formula.
    "малыш, медленно улыбается",
    "она пустышка, медленно улыбается",
    "медленно ложится в кроватку",
    "медленно двигает ползунок громкости",
    "медленно наливает бутылочку воды",
    // «сосок» (her nipple) shares most of its forms with «соска»; the content rules the owner lifted let it through, and so does the guard.
    "медленно касается соска",
    // Round 2 (M2): the genitive of «сосок» before «во рту» is her nipple.
    "кончик соска во рту, медленно стонет",
    "держит кончик соска во рту и медленно стонет",
    "медленно касается соска во рту языком",
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
    // Round 2 (H1): the additive and the malformed numerals main refused.
    "she slowly undresses, XIIII",
    "she slowly undresses, XVIIII",
    "she slowly undresses, IIII",
    "she slowly undresses, XIIX",
    "she slowly undresses, xiiii",
    // Round 2 (M1): glued to a word or an ending, or split into letters.
    "she slowly undresses, XVIyo",
    "she slowly undresses, xviyo",
    "she slowly undresses, sweetXVI",
    "she slowly undresses, ageXVI",
    "she slowly undresses, XVIs",
    "she slowly undresses, x-v-i",
    "she slowly undresses, aged x-v-i",
    "she slowly undresses, X.V.I",
    "she slowly undresses, a x v i",
    // Round 2, the security review of the ageText commits: Cyrillic look-alikes inside a split numeral, a case change before «Years», and an age's tail of any length.
    "she slowly undresses, \u0445-v-\u0456",
    "she slowly undresses, XVIYearsold",
    "she slowly undresses, XVIYO",
    "she slowly undresses, xviyearsold",
    "she slowly undresses, XVIYEARSOLD",
    "she slowly undresses, xviy.o.",
    // The security review of the dot removal: a dot that ends a numeral must not glue it to the next word.
    "she slowly smiles, xvi.she undresses",
    "she slowly smiles, XVI.",
    "she slowly undresses, x.v.i",
    // Round 3 (N2): only a run of «x» alone is a filler; a run of «i» after a numeral counts on.
    "she slowly undresses, XIIIII",
    "she slowly undresses, XIIIIII",
    "she slowly undresses, XVIIIII",
    "she slowly undresses, VIIIIIIIIIII",
    "she slowly undresses, IIIIIIIIIIIIIIII",
    "she slowly undresses, xvixxxxx",
  ],
  ideas: [
    "медленно раздевается \u2014 XVI",
    "медленно раздевается (xvi)",
    "медленно раздевается; xvi",
    "медленно снимает халат, ейXVI",
    "медленно снимает халат, ей \u0425\u0425",
    "медленно раздевается, ей X-V-I",
    "медленно раздевается, ей x v i",
    "медленно раздевается, ей \u0445-v-\u0456",
    // A century in Roman numerals is refused as well: the rule does not read the context it stands in.
    "медленно идёт мимо собора XVI века",
  ],
  passes: [
    "she slowly pulls on her XXL t-shirt",
    "she slowly smooths her XXXL sweater",
    "she slowly fixes her XS top",
    "she slowly tugs at her XXS top",
    // The only words whose core is a numeral («XXS», «vis», «ivy», «visage», «visaged»), let through by name.
    "she slowly sits vis-a-vis the window",
    "she slowly smiles, vivid and calm",
    "she slowly turns, civic and calm",
    "she slowly blows a kiss, x",
    "she slowly turns, I think",
    "she slowly turns her head, v-neck on",
    "she slowly holds her iPhone up",
    "she slowly pins on her VIP badge",
    // Words that start with the numeral letters stay words: an age's tail is taken off only where a numeral is left.
    "she slowly films a video",
    "she slowly takes in the view",
    "she slowly walks to the villa",
    "she slowly smooths her vintage dress",
    "she slowly feels the vibe",
    "she slowly touches the ivory keys",
    "she slowly brushes the ivy",
    "she slowly turns her visage to the light",
    "she slowly turns, stern-visaged and calm",
    "she smiles. vivid light",
    "she slowly adjusts her hoodie, XL.",
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

/**
 * What the free pre-check missed in his words, which the English check refused only after a paid translation: a number glued to a word («ей16»), a numeral misspelt or split
 * («шешнадцать», «шест надцать»), a school grade («в девятом классе»), and the youth words «первоклашка», «лолита», «нимфетка», «младенец». The English of each is pinned
 * beside it. «Молоденькая» is ordinary adult usage, as «young» is allowed in English, and stays out.
 */
export const PRE_CHECK_GAPS: AgeProbes = {
  name: "pre-check gaps",
  english: [
    "she slowly undresses like a lolita",
    "she slowly undresses like a nymphet",
    "she slowly undresses like a first grader",
    "she slowly undresses in ninth grade",
    "she slowly undresses like a baby",
  ],
  ideas: [
    "медленно снимает халат, ей16",
    "ей16, медленно раздевается",
    "медленно снимает халат, шешнадцать",
    "медленно снимает халат, шест надцать",
    "медленно снимает халат, шестнад цать",
    "медленно снимает халат, шест-надцать",
    "медленно снимает халат, шес т надцать",
    "медленно снимает халат, ш е с т н а д ц а т ь",
    "медленно снимает халат, пятнацать",
    "медленно снимает халат, семнацать",
    "медленно снимает халат, шешнадцатилетняя",
    "медленно снимает халат, двацать",
    "медленно раздевается в девятом классе",
    "девятый класс, медленно раздевается",
    "из девятого класса, медленно раздевается",
    // Round 2 (L3): the school forms with an invisible space or a hyphen before «классе», and «N-классница».
    "медленно раздевается в девятом\u200bклассе",
    "медленно раздевается в девятом-классе",
    "медленно раздевается, 9-классница",
    "медленно раздевается, восьмиклассник рядом",
    // The security review of L3: any case and number of the grade, after any word but a carriage's, a ticket's, a cabin's or a seat's.
    "девушка девятого класса медленно раздевается",
    "медленно раздевается, как в девятых классах",
    "ученица одиннадцатого класса медленно раздевается",
    "девятиклассница медленно раздевается",
    // Its second review: a travel noun spares a grade only as the whole word right before it, and nothing after «класса» spares one.
    "медленно раздевается, местного девятого класса",
    "девушка девятого класса поезда медленно раздевается",
    "медленно улыбается, пятого класса обслуживания",
    "медленно раздевается, учится в 9 классе",
    // Round 2 (L5): a Russian letter touching a digit does not shield it.
    "медленно смотрит в экран 4\u041a",
    "медленно говорит в 2х словах",
    "первоклашка медленно раздевается",
    "медленно раздевается как первоклашки",
    "лолита медленно раздевается",
    "в образе лолиты медленно раздевается",
    "нимфетка медленно раздевается",
    "как нимфетки медленно раздевается",
    "младенец медленно раздевается",
    "как младенец медленно раздевается",
  ],
  passes: [],
  ideaPasses: [
    "медленно поворачивает голову к окну",
    "медленно потягивается в первом классе самолёта",
    // Round 2 (L3): a class of a carriage or a ticket is no grade.
    "медленно садится в вагон третьего класса",
    "медленно показывает билет пятого класса",
    "медленно улыбается в купе третьего класса",
    "медленно заходит в каюту третьего класса",
    "это класс, медленно улыбается",
    "медленно трогает пятна на платье",
    "медленно делает упражнение на тренажёре",
    "медленно смотрит в экран 4K",
    // Short words that run together into a misspelt numeral («тринатот») are no number.
    "три на тот угол, медленно улыбается",
    // Round 2 (L4): two words that run together into a misspelling («пятна тату» → «пятнатату»).
    "медленно трогает пятна тату на плече",
    "медленно стирает пятна томатного сока",
    "медленно улыбается, молоденькая",
  ],
};

/**
 * Words the round-2 youth list refused where they name no child: the pupils of her eyes, a tot of rum and tater tots, a youth hostel, a newborn animal. The child each word
 * also names stays refused beside them.
 */
export const FALSE_POSITIVES: AgeProbes = {
  name: "false positives",
  english: [
    "she slowly undresses like a pupil",
    "she slowly undresses for her pupils",
    "she slowly undresses, a tot",
    "she slowly undresses like a tot",
    // Round 2 (H2): «a tot of …» is a drink only when it names one.
    "she slowly undresses beside a tot of her own",
    "she slowly undresses, a tot of three",
    "she slowly undresses, a youth",
    "she slowly undresses at the youth club",
    "she slowly undresses like a newborn",
    "she slowly undresses, a newborn baby",
    // Round 2 (L2): «chick» and «kit» also name a girl.
    "she slowly undresses like a newborn chick",
  ],
  ideas: [],
  passes: [
    "her pupils slowly widen a little",
    "she slowly looks up, her pupils dilating",
    "she slowly narrows her eyes, her dilated pupils",
    "she slowly sips a tot of rum",
    "she slowly pours a tot of whiskey",
    "she slowly eats tater tots",
    "she slowly waves outside the youth hostel",
    "she slowly sits in the youth hostel lobby",
    "she slowly strokes a newborn kitten",
    "she slowly cradles a newborn puppy",
    "she slowly feeds a newborn lamb",
  ],
  ideaPasses: [],
};

/** Every group, in the order the gaps were closed. */
export const AGE_PROBES: readonly AgeProbes[] = [INFANT_PROPS, ROMAN_AGES, DECADES, ROMAN_FAIL_CLOSED, PRE_CHECK_GAPS, FALSE_POSITIVES];
