// S5.5: the pool generator draws no lingerie, swimwear or nudity until the «Смелая» level ships (engine/scenes/poolGen.ts), so a custom category whose description asks for
// them comes out in everyday clothes. The swap used to be silent; the sheet now says so, before «Создать» and on the category's card. Renderer-only: the engine's own word
// list (scenes/words.ts) is not imported here, this one also reads Russian and the description rather than an outfit.

/** What the owner is told when his description asks for what is not drawn. Neutral: a fact and a date of sorts, not a reproach. */
export const REVEALING_NOTE = "Бельё, купальники и обнажёнку пока не рисуем — категория выйдет в обычной одежде. Это появится с уровнем «Смелая».";

/** The same note on the card of a category that is already created: it did come out in everyday clothes. */
export const REVEALING_NOTE_DONE = "Бельё, купальники и обнажёнку пока не рисуем — категория вышла в обычной одежде. Это появится с уровнем «Смелая».";

// A word is a run of letters: `\b` knows only ASCII, so the edges are lookarounds over Unicode letters and digits. Text is lowercased and ё is read as е before matching,
// so every pattern below is written in lowercase with е. A Russian stem is followed by the endings it really takes (not by «any letters»), so «белый» and «бельгийский»
// (a different word that starts with the same letters) stay out.
const START = String.raw`(?<![\p{L}\p{N}])`;
const END = String.raw`(?![\p{L}\p{N}])`;

// «Обнажённые плечи», «голая спина», «голые руки» are drawn (a backless dress, a sleeveless top), so a bare/naked word followed by one of these body parts is not a request.
const NOT_A_BODY_PART = String.raw`(?!\s+(?:плеч|спин|рук|ног)\p{L}*)`;

const RUSSIAN = [
  String.raw`бель(?:е|я|ю|ем|ях|ям|ями)?(?!-этаж)`, // бельё, белья, белью, бельём (the stem «бель» + an ending; «бельгийский» has a letter after «бель», «бель-этаж» is a floor)
  String.raw`трус(?:ы|ов|ам|ами|ах)`, // трусы (not «трус», a coward, nor «трусливый»)
  String.raw`трусик\p{L}*`,
  String.raw`лифчик\p{L}*`,
  String.raw`бюстгальтер\p{L}*`,
  String.raw`стринг(?:и|ов|ам|ами|ах)?`, // not «стрингер», a journalist
  String.raw`чулк\p{L}*`,
  String.raw`чулок`,
  String.raw`купальник\p{L}*`,
  String.raw`плав(?:ки|ок|кам|ками|ках)`, // swim trunks (not «плавка металла», not «плавкий»)
  String.raw`бикини`,
  String.raw`(?:полу)?гол(?:ая|ую|ой|ое|ые|ых|енькая|ышом)${NOT_A_BODY_PART}`, // голая, на голое тело; «голова» and «голые руки» are not it
  String.raw`наг(?:ая|ую|ой|ишом)`,
  String.raw`(?:полу)?обнажен\p{L}*${NOT_A_BODY_PART}`, // обнажённая, обнажена, обнажёнка, полуобнажённая
  String.raw`раздет\p{L}*`,
  String.raw`без одежды`,
  String.raw`халат(?:а|е|у|ом|ы|ов)?`, // a robe (not «халатность»)
  String.raw`пеньюар\p{L}*`,
  String.raw`неглиже`,
  String.raw`ночн(?:ая|ой|ую|ые|ых)\s+сорочк\p{L}*`,
  String.raw`ночнушк\p{L}*`,
  String.raw`боди`,
  String.raw`топлес\p{L}*`,
  String.raw`ню`,
];

// The engine's own list (scenes/words.ts) has no «nude», so «nude lipstick», «nude heels» and «a nude colour» are drawn; a stocking in «Christmas stocking» is a sock.
const NUDE_AS_A_COLOUR = String.raw`(?![\s-]+(?:lip\p{L}*|make[- ]?up|heels?|shoes?|pumps?|sandals?|colou?r\p{L}*|tones?|toned|shades?|polish|nails?))`;

const ENGLISH = [
  String.raw`lingerie`,
  String.raw`underwear`,
  String.raw`undies`,
  String.raw`bras?`, // also «sports bra»
  String.raw`panties`,
  String.raw`panty`,
  String.raw`thongs?`,
  String.raw`g-strings?`,
  String.raw`(?<!christmas\s)stockings?`,
  String.raw`swimsuits?`,
  String.raw`swimwear`,
  String.raw`bathing suits?`,
  String.raw`bikinis?`,
  String.raw`slip dress`,
  String.raw`robe over lingerie`,
  String.raw`nudes?${NUDE_AS_A_COLOUR}`,
  String.raw`nudity`,
  String.raw`naked`,
  String.raw`topless`,
];

const REVEALING = new RegExp(`${START}(?:${[...RUSSIAN, ...ENGLISH].join("|")})${END}`, "u");

/** Whether a description asks for lingerie, swimwear or nudity (Russian or English), which the pool generator will not draw. A pure function of the text: no case, no ё/е, composed or decomposed letters alike. */
export function asksForRevealing(description: string): boolean {
  return REVEALING.test(description.normalize("NFC").toLowerCase().replaceAll("ё", "е"));
}
