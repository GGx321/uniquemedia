import { CUSTOM_BOLD_BANKS, impliedItemsOf } from "../../../shared/scenes/banks/companions";
import { impliedText, type ImpliedWord } from "./captionWords";

// S5.5: the pool generator draws no lingerie, swimwear or nudity in the owner's own categories (engine/scenes/poolGen.ts), so a custom category whose description asks for them comes out in
// everyday clothes. The swap used to be silent; the sheet says so, before «Создать» and on the category's card. Renderer-only: the engine's own word list (scenes/words.ts) is not imported
// here, this one also reads Russian and the description rather than an outfit. 5a.4 (S5.BA8b, plan s5a4 §5.9 rows 15, 16; r2.2 D4, r2.3 M5; mockup 66): «Смелая» draws every category, a
// custom one included, so the note says what it gives there instead of sending the owner to the two built-ins. It promises nothing «в духе описания»: the engine never draws an outfit
// from the description (I5.78).

/** The covers a custom category's «Смелая» frames may draw for a Studio-created avatar, read from its two banks (r2.4 N1: the sheet and the towel), in the clause's fixed order. */
const CUSTOM_COVERS: readonly ImpliedWord[] = (["sheet", "towel", "foam"] as const).filter((item) =>
  [CUSTOM_BOLD_BANKS.rooms, CUSTOM_BOLD_BANKS.water].some((bank) => impliedItemsOf(bank).includes(item)),
);

/**
 * BA8b round 2 (owner question 1, the controller's default (b)): Seedream draws no full nudity, and a Studio-created avatar's most revealing frames may be an implied cover — named as the
 * custom banks give them. With no cover in the banks, the plain «Голой Seedream не рисует.»
 */
const COVERS_CLAUSE = impliedText(CUSTOM_COVERS);
const NUDITY_TAIL = COVERS_CLAUSE === null ? "Голой Seedream не рисует." : `Полностью голой Seedream не рисует; у аватара из Studio часть кадров — ${COVERS_CLAUSE}.`;

/** What the owner is told before «Создать» when his description asks for what the category's own outfits will not have. Neutral: a fact and where to find it, not a reproach. */
export const REVEALING_NOTE = `Бельё и купальники даёт подача «Смелая»: с ней она выйдет в белье дома или в номере, в мире категории, а у воды — в купальнике. ${NUDITY_TAIL}`;

/** The note on the card of a category that is already created: its own outfits are ordinary, and what «Смелая» gives. */
export const REVEALING_NOTE_DONE = `Наряды категории — обычные. С подачей «Смелая» она выйдет в белье дома или в номере, а у воды — в купальнике. ${NUDITY_TAIL}`;

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
