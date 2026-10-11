// S5.5: the pool generator draws no lingerie, swimwear or nudity until the «Смелая» level ships (engine/scenes/poolGen.ts), so a custom category whose description asks for
// them comes out in everyday clothes. The swap used to be silent; the sheet now says so, before «Создать» and on the category's card. Renderer-only: the engine's own word
// list (scenes/words.ts) is not imported here, this one also reads Russian and the description rather than an outfit.

/** What the owner is told when his description asks for what is not drawn. Neutral: a fact and a date of sorts, not a reproach. */
export const REVEALING_NOTE = "Бельё, купальники и обнажёнку пока не рисуем — категория выйдет в обычной одежде. Это появится с уровнем «Смелая».";

// A word is a run of letters: `\b` knows only ASCII, so the edges are lookarounds over Unicode letters and digits. Text is lowercased and ё is read as е before matching,
// so every pattern below is written in lowercase with е. A Russian stem is followed by the endings it really takes (not by «any letters»), so «белый» and «бельгийский»
// (a different word that starts with the same letters) stay out.
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;

const RUSSIAN = [
  String.raw`бель(?:е|я|ю|ем|ях|ям|ями)?`, // бельё, белья, белью, бельём (the stem «бель» + an ending; «бельгийский» has a letter after «бель»)
  String.raw`трус(?:ы|ов|ам|ами|ах)`, // трусы (not «трус», a coward, nor «трусливый»)
  String.raw`трусик\p{L}*`,
  String.raw`лифчик\p{L}*`,
  String.raw`бюстгальтер\p{L}*`,
  String.raw`стринг(?:и|ов|ам|ами|ах)?`, // not «стрингер», a journalist
  String.raw`чулк\p{L}*`,
  String.raw`чулок`,
  String.raw`купальник\p{L}*`,
  String.raw`плавк\p{L}*`,
  String.raw`бикини`,
  String.raw`гол(?:ая|ую|ой|енькая|ышом)`, // голая; «голые руки» and «голова» are not it
  String.raw`наг(?:ая|ую|ой|ишом)`,
  String.raw`обнажен\p{L}*`, // обнажённая, обнажена, обнажёнка
  String.raw`топлес\p{L}*`,
  String.raw`ню`,
];

const ENGLISH = [
  String.raw`lingerie`,
  String.raw`underwear`,
  String.raw`undies`,
  String.raw`bras?`,
  String.raw`sports bra`,
  String.raw`panties`,
  String.raw`panty`,
  String.raw`thongs?`,
  String.raw`g-strings?`,
  String.raw`stockings?`,
  String.raw`swimsuits?`,
  String.raw`swimwear`,
  String.raw`bathing suits?`,
  String.raw`bikinis?`,
  String.raw`slip dress`,
  String.raw`nudes?`,
  String.raw`nudity`,
  String.raw`naked`,
  String.raw`topless`,
];

const REVEALING = new RegExp(`${START}(?:${[...RUSSIAN, ...ENGLISH].join("|")})${END}`, "u");

/** Whether a description asks for lingerie, swimwear or nudity (Russian or English), which the pool generator will not draw. A pure function of the text: no case, no ё/е. */
export function asksForRevealing(description: string): boolean {
  return REVEALING.test(description.toLowerCase().replaceAll("ё", "е"));
}
