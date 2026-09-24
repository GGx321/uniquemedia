// Age and youth detection for text that goes into prompts: the avatar
// descriptor and the user's vibe (invariant 8). Errs on the side of rejecting.
//
// Every check runs on a normalised form of the text: NFKC (fullwidth "１７",
// "ｔｅｅｎ" fold to ASCII), every dash to "-", every space to " ", curly
// quotes to straight ones, and accents stripped from Latin letters ("tëen").
// Any digit that is still not ASCII (Arabic-Indic, Devanagari, ...) is rejected.
//
// Invisible format characters are dropped before matching, so one inside a
// word ("te\u2060en") hides nothing.
//
// Script policy: the descriptor is engine-written English, so it may hold
// only ASCII letters, digits and basic punctuation. The vibe is user input in
// English or Russian: Latin and Cyrillic letters only, and never both inside
// one word (homoglyph attacks such as "years оld" with a Cyrillic "о").
//
// Two scopes. The vibe only feeds the descriptor LLM, so it is refused only
// for hard markers of a minor; "a youthful smile" or "girl next door" pass.
// The descriptor is engine-written and goes into every prompt, so it is held
// strictly: at most 600 chars, no number but its "<age>-year-old" anchor (a
// lone "one" and decade styles aside), letters repeated or spelled out in
// short fragments ("teeen", "t e e n", "t/e/e/n", "t-een") are read as a word,
// and every word that suggests she is not a grown adult ("girlish",
// "petite", "youthful", "innocent", "coed", "school...") is refused.

/** `descriptor`: the strict rule for LLM output that goes into every prompt. `vibe`: hard markers only. */
export type AgeTextScope = "descriptor" | "vibe";

const EN_ONES: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const EN_TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const EN_TENS: Record<string, number> = { twenty: 20, thirty: 30 };

const RU_ONES: Record<string, number> = {
  один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9,
};
const RU_TEENS: Record<string, number> = {
  десять: 10, одиннадцать: 11, двенадцать: 12, тринадцать: 13, четырнадцать: 14,
  пятнадцать: 15, шестнадцать: 16, семнадцать: 17, восемнадцать: 18, девятнадцать: 19,
};
const RU_TENS: Record<string, number> = { двадцать: 20, тридцать: 30 };

// Genitive stems used in compounds such as "пятнадцатилетняя", "пятнадцатилетка".
const RU_STEM_ONES: Record<string, number> = {
  одно: 1, двух: 2, трёх: 3, трех: 3, четырёх: 4, четырех: 4, пяти: 5, шести: 6, семи: 7, восьми: 8, девяти: 9,
};
const RU_STEM_TEENS: Record<string, number> = {
  десяти: 10, одиннадцати: 11, двенадцати: 12, тринадцати: 13, четырнадцати: 14,
  пятнадцати: 15, шестнадцати: 16, семнадцати: 17, восемнадцати: 18, девятнадцати: 19,
};
const RU_STEM_TENS: Record<string, number> = { двадцати: 20, тридцати: 30 };

/** Longest first, so "seventeen" wins over "seven". */
function alt(...maps: Record<string, number>[]): string {
  return maps
    .flatMap((m) => Object.keys(m))
    .sort((a, b) => b.length - a.length)
    .join("|");
}

const EN_WORD = `(?:(?:${alt(EN_TENS)})(?:[- ]?(?:${alt(EN_ONES)}))?|${alt(EN_TEENS, EN_ONES)})`;
/** Without one..nine: after "looks"/"seems" those are too common ("looks like one of the locals"). */
const EN_BIG_WORD = `(?:(?:${alt(EN_TENS)})(?:[- ]?(?:${alt(EN_ONES)}))?|${alt(EN_TEENS)})`;
/** Every number word but a lone "one" ("she's one of a kind"); "twenty-one" still counts. */
const EN_ONES_BUT_ONE = Object.fromEntries(Object.entries(EN_ONES).filter(([word]) => word !== "one"));
const EN_WORD_BUT_ONE = `(?:(?:${alt(EN_TENS)})(?:[- ]?(?:${alt(EN_ONES)}))?|${alt(EN_TEENS, EN_ONES_BUT_ONE)})`;
/** thirteen..nineteen: never a clock time, so "at seventeen" is an age wherever it stands. */
const EN_TEEN_WORD = alt(Object.fromEntries(Object.entries(EN_TEENS).filter(([, n]) => n >= 13)));
const RU_WORD = `(?:(?:${alt(RU_TENS)})(?:\\s+(?:${alt(RU_ONES)}))?|${alt(RU_TEENS, RU_ONES)})`;
const RU_STEM = `(?:(?:${alt(RU_STEM_TENS)})(?:${alt(RU_STEM_ONES)})?|${alt(RU_STEM_TEENS, RU_STEM_ONES)})`;
/** "15-ти", "5-и", "2-х", "7-ми". */
const RU_DIGIT_SUFFIX = "(?:\\s*-?\\s*(?:ти|и|х|ми))?";

/**
 * After a range's first number: not the tens of a compound word, so "aged
 * twenty-five" is 25, never the range "twenty" to "five".
 */
const NOT_SPLIT_COMPOUND = `(?!(?<=(?:${alt(EN_TENS)}))[- ](?:${alt(EN_ONES)})(?![\\p{L}\\p{N}]))`;

const START = "(?<![\\p{L}\\p{N}])";
const END = "(?![\\p{L}\\p{N}])";
const NUM = `(\\d+|${EN_WORD})`;
const RU_NUM = `(\\d+|${RU_WORD})`;

const EN_JUDGE_VERB =
  "(?:looks?|looking|seems?|seeming|appears?|appearing|(?:could|can|would|might)\\s+pass\\s+for|pass(?:es|ing)?\\s+for)";
const EN_JUDGE_FILLER =
  "(?:like\\s+)?(?:(?:she|he|they)(?:['’]s|\\s+is|\\s+was|\\s+are)?\\s+)?(?:to\\s+be\\s+)?(?:an?\\s+)?(?:about\\s+|around\\s+|maybe\\s+|barely\\s+|only\\s+|just\\s+)?";

/** After a number, what makes it an age rather than a count ("2 or 3 coffees"). */
const AGE_CONTEXT_AFTER = "(?=\\s*(?:$|[.,;:!?)]|-?\\s*(?:years?|yrs?|yo|y\\.o|y\\/o)\\b|лет|года|год))";
const NOT_A_MEASURE = "(?!\\s*(?:feet|foot|ft|inch|inches|cm|m|kg|lbs?|pounds|minutes?|hours?|days?|percent|%))";

/** Words that soften a stated age without changing it: "she's only 16", "ей всего 16". */
const EN_HEDGE = "(?:only|just|barely|about|around|nearly|almost|maybe)\\s+";
const RU_HEDGE = "(?:всего|только|уже|почти|около)\\s+";
/**
 * After "she's N": what makes N a height, a distance, a share or a count
 * rather than an age ("she's 5 feet", "she's 5'6\"", "she is 2 hours away",
 * "she's 100% herself", "she is 3 out of 4").
 */
const NOT_AN_AGE_AFTER =
  "(?!\\s*(?:(?:feet|foot|ft|inch(?:es)?|cm|m|kg|lbs?|pounds|miles?|km|minutes?|mins?|hours?|days?|weeks?|months?|percent|times|of|out)\\b|[%'\"]|[:.,]\\d))";

const AGE_PATTERNS: RegExp[] = [
  // 25-year-old, 17 years old, 17 yrs old, seventeen-year-old, 17 years young
  new RegExp(`${START}${NUM}\\s*-?\\s*(?:years?|yrs?)\\s*-?\\s*(?:old|young)${END}`, "giud"),
  // 17 years of age
  new RegExp(`${START}${NUM}\\s*-?\\s*years?\\s+of\\s+age${END}`, "giud"),
  // aged 17, age 17, age: 17, ages 17, at the age of 17
  new RegExp(`\\bage[ds]?\\s*(?:of\\s*)?:?\\s*${NUM}${END}`, "giud"),
  // ages 16-18, aged 16 to 18
  new RegExp(`\\bage[ds]?\\s*:?\\s*${NUM}${NOT_SPLIT_COMPOUND}\\s*(?:-|to|or|and)\\s*${NUM}${END}`, "giud"),
  // she's 17, she is seven, he's only 16, who is sixteen, she'll be 17 (a lone "one" is too common: "she's one of a kind")
  new RegExp(
    `\\b(?:she|he|who)(?:'s|'ll\\s+be|\\s+is|\\s+was|\\s+will\\s+be)\\s+(?:${EN_HEDGE})?(\\d+|${EN_WORD_BUT_ONE})${END}${NOT_AN_AGE_AFTER}`,
    "giud",
  ),
  // her age is 16, his age was fifteen
  new RegExp(`\\bage\\s+(?:is|was)\\s+(?:${EN_HEDGE})?${NUM}${END}`, "giud"),
  // at 17, she moved; at 16 she started; at 17 years
  new RegExp(`\\bat\\s+(?:${EN_HEDGE})?${NUM}(?=\\s*,?\\s*(?:she|he|they)\\b|\\s*-?\\s*years?\\b)`, "giud"),
  // at seventeen
  new RegExp(`\\bat\\s+(?:${EN_HEDGE})?(${EN_TEEN_WORD})${END}`, "giud"),
  // 17 yo, 17yo, 17 y.o., 17 y/o, 17 yrs
  new RegExp(`${START}${NUM}\\s*(?:yo|y\\.\\s?o\\.?|y\\/o|yrs?)${END}`, "giud"),
  // looks 16, looks like she is 17, seems fifteen, could pass for 16, appears to be 15
  new RegExp(`\\b${EN_JUDGE_VERB}\\s+${EN_JUDGE_FILLER}(\\d+|${EN_BIG_WORD})${END}`, "giud"),
  // 15 лет, 3 года, 1 год, 15-ти лет, шестнадцать лет
  new RegExp(`${START}(\\d+)${RU_DIGIT_SUFFIX}\\s*-?\\s*(?:лет|года|год)(?![\\p{L}])`, "giud"),
  new RegExp(`${START}(${RU_WORD})\\s*(?:лет|года|год)(?![\\p{L}])`, "giud"),
  // 16-летняя, 15-ти летняя, 16-летка
  new RegExp(`${START}(\\d+)${RU_DIGIT_SUFFIX}\\s*-?\\s*лет(?:н|к)`, "giud"),
  // пятнадцатилетняя, пятнадцати летняя, пятнадцатилетка, двадцатипятилетняя
  new RegExp(`(?<![\\p{L}])(${RU_STEM})[\\s-]?лет(?:н|к)`, "giud"),
  // выглядит на пятнадцать, смотрится на 15
  new RegExp(`(?<![\\p{L}])(?:выгляд\\p{L}*|смотрит\\p{L}*)\\s+(?:лет\\s+)?на\\s+${RU_NUM}${END}`, "giud"),
  // лет 15 (на вид), года 3
  new RegExp(`(?<![\\p{L}])(?:лет|года)\\s+${RU_NUM}${END}`, "giud"),
  // 15 на вид
  new RegExp(`${START}${RU_NUM}\\s+на\\s+вид(?![\\p{L}])`, "giud"),
  // ей 16, ему шестнадцать, ей всего 16
  new RegExp(`(?<![\\p{L}])(?:ей|ему|им)\\s+(?:${RU_HEDGE})?${RU_NUM}(?=\\s*(?:$|[.,;:!?)]|лет|года|год|на\\s+вид))`, "giud"),
  // 16 годиков, 16 годков
  new RegExp(`${START}${RU_NUM}\\s*-?\\s*год(?:ик|к)\\p{L}*`, "giud"),
  // just turned 18, turning 17
  new RegExp(`\\b(?:just\\s+turned|turned|turning)\\s+${NUM}${END}`, "giud"),
  // barely 18 (but not "barely 5 feet tall")
  new RegExp(`\\bbarely\\s+${NUM}${END}${NOT_A_MEASURE}`, "giud"),
  // 16 or 17
  new RegExp(`${START}${NUM}\\s+or\\s+${NUM}${AGE_CONTEXT_AFTER}`, "giud"),
  // sweet sixteen
  new RegExp(`\\bsweet\\s+(sixteen|16)${END}`, "giud"),
];

const BOUND_PATTERNS: RegExp[] = [
  // under 18, under-18, below 21, younger than 20, less than eighteen
  new RegExp(`\\b(?:under|below|younger\\s+than|less\\s+than)\\s*-?\\s*${NUM}${AGE_CONTEXT_AFTER}`, "giud"),
  // младше 18, моложе 16 лет, до 18 лет
  new RegExp(`(?<![\\p{L}])(?:младше|моложе|меньше|до)\\s+${RU_NUM}${AGE_CONTEXT_AFTER}`, "giud"),
  // not yet 21, 25 going on 15: she is below that age
  new RegExp(`\\b(?:not\\s+yet|going\\s+on)\\s+${NUM}${END}`, "giud"),
];

const WORD_VALUES: Record<string, number> = {
  ...EN_ONES, ...EN_TEENS, ...EN_TENS, ...RU_ONES, ...RU_TEENS, ...RU_TENS,
  ...RU_STEM_ONES, ...RU_STEM_TEENS, ...RU_STEM_TENS,
};

function numberValue(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw);
  const lower = raw.toLowerCase();
  // Russian compound stems are written without a separator: "двадцатипяти".
  const stemTens = Object.keys(RU_STEM_TENS).find((t) => lower.startsWith(t) && lower !== t);
  const parts = stemTens ? [stemTens, lower.slice(stemTens.length)] : lower.split(/[-\s]+/);
  return parts.reduce((sum, part) => sum + (WORD_VALUES[part] ?? Number.NaN), 0);
}

/** NFKC, then one dash, one space and straight quotes. */
function foldForms(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\p{Pd}\u2010\u2011\u2212]/gu, "-")
    .replace(/\p{Zs}/gu, " ")
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"');
}

/** The text every age and youth check runs on: `foldForms`, invisible format characters dropped, Latin accents stripped. */
function normalise(text: string): string {
  return foldForms(text).replace(/\p{Cf}/gu, "").normalize("NFD").replace(/(?<=[A-Za-z])\p{M}+/gu, "").normalize("NFC");
}

/**
 * Two or more fragments of one to three letters, each apart by one to three
 * characters that are neither letters nor digits: "t e e n", "T.E.E.N",
 * "t/e/e/n", "(t)(e)(e)(n)", "t-een", "tee-n".
 */
const FRAGMENTS = /(?<![\p{L}\p{N}])\p{L}{1,3}(?:[^\p{L}\p{N}]{1,3}\p{L}{1,3})+(?![\p{L}\p{N}])/gu;
/** Longer than any word the rules look for: a suffix is cut here, so the join stays linear. */
const MAX_WORD = 32;

/**
 * Each run of short fragments joined, with every suffix of the joined word
 * (cut to MAX_WORD), so a leading article is no cover: "a t e e n" reads
 * "ateen teen een en n".
 */
function fragmentWords(text: string): string[] {
  return Array.from(text.matchAll(FRAGMENTS), ([run]) => {
    const word = run.replace(/[^\p{L}]/gu, "");
    return Array.from(word, (_, i) => word.slice(i, i + MAX_WORD)).join(" ");
  });
}

/**
 * The descriptor's matching forms: `text` is the text `normalise`d, then the
 * same with a letter repeated three times or more cut to two ("teeen") and to
 * one ("giiirl"); `joined` is their short fragments joined. Each part is apart
 * by "|", so no multi-word rule ("old enough") spans two of them.
 */
function descriptorForms(text: string): { text: string; joined: string } {
  const base = normalise(text);
  const forms = [...new Set([base, base.replace(/(\p{L})\1{2,}/giu, "$1$1"), base.replace(/(\p{L})\1{2,}/giu, "$1")])];
  return { text: forms.join("|"), joined: forms.flatMap(fragmentWords).join("|") };
}

function numbersFound(text: string, patterns: readonly RegExp[]): number[] {
  const normalized = normalise(text);
  const byPosition = new Map<number, number>();
  for (const pattern of patterns) {
    for (const m of normalized.matchAll(pattern)) {
      for (let group = 1; group < m.length; group++) {
        const raw = m[group];
        const start = m.indices?.[group]?.[0];
        if (raw !== undefined && start !== undefined && !byPosition.has(start)) {
          byPosition.set(start, numberValue(raw));
        }
      }
    }
  }
  return [...byPosition.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
}

/** Every age stated in the text, in order of appearance, in any supported EN/RU form. */
export function ageMentions(text: string): number[] {
  return numbersFound(text, AGE_PATTERNS);
}

/** Every "under N" / "younger than N" / "младше N" bound, in order of appearance. */
export function ageUpperBounds(text: string): number[] {
  return numbersFound(text, BOUND_PATTERNS);
}

/** Decimal digits that are not ASCII 0-9 even after NFKC. */
export function nonAsciiDigits(text: string): string[] {
  return Array.from(normalise(text).matchAll(/(?![0-9])\p{Nd}/gu), (m) => m[0]);
}

/**
 * A word the checks refuse, under a fixed name: the name (never text of the
 * checked answer) is what a retry is told to avoid.
 */
interface WordRule {
  name: string;
  pattern: RegExp;
  /** False for a word that short words run together make by chance ("in in a" → "ninina"): it is matched on real words only. */
  joins: boolean;
}

/** An English rule: whole words (ASCII word boundaries). */
function en(name: string, pattern: string, opts: { joins?: boolean } = {}): WordRule {
  return { name, pattern: new RegExp(`\\b(?:${pattern})\\b`, "giu"), joins: opts.joins ?? true };
}

/** A Russian rule: `\b` does not see Cyrillic, so the pattern bounds itself. */
function ru(name: string, pattern: string): WordRule {
  return { name, pattern: new RegExp(pattern, "giu"), joins: true };
}

/** Markers of a minor in any scope. */
const HARD_YOUTH: WordRule[] = [
  en("teen", "(?:pre-?)?teen\\w*"),
  en("tween", "tweens?"),
  en("middle school", "middle[- ]?school(?:ers?)?"),
  en("Nth grade", "\\d+(?:st|nd|rd|th)[- ]?grade(?:rs?)?"),
  en("schoolgirl", "school[- ]?girls?"),
  en("school uniform", "school[- ]uniforms?"),
  en("high school", "high[- ]?school(?:ers?)?"),
  en("loli", "loli\\w*"),
  en("jailbait", "jail[- ]?bait\\w*"),
  en("nymphet", "nymphets?"),
  en("minor", "minors?"),
  en("underage", "under[- ]?aged?"),
  en("young-looking", "young[- ]looking"),
  en("barely legal", "barely[- ]?legal"),
  en("adolescent", "adolescen\\w*"),
  en("pubescent", "(?:pre-?)?pubescen\\w*"),
  en("juvenile", "juveniles?"),
  ru("подросток", "(?<![\\p{L}])подрост\\p{L}*"),
  ru("школьница", "(?<![\\p{L}])школьниц\\p{L}*"),
  ru("несовершеннолетняя", "(?<![\\p{L}])несовершеннолет\\p{L}*"),
  ru("малолетка", "(?<![\\p{L}])малолет\\p{L}*"),
  ru("малышка", "(?<![\\p{L}])малышк\\p{L}*"),
  ru("ученица", "(?<![\\p{L}])учениц\\p{L}*"),
  ru("тинейджер", "(?<![\\p{L}])тинейдж\\p{L}*"),
  ru("школота", "(?<![\\p{L}])школот\\p{L}*"),
  // старшеклассница, пятиклассник, одноклассница: any "...классник/...классница" is a school pupil
  ru("классница", "(?<![\\p{L}])\\p{L}*классни[кц]\\p{L}*"),
  ru("юная", "(?<![\\p{L}])юн(?:ая|ой|ую|ые|ых|ым|ыми|ое|ого|ый|ому|ом)(?![\\p{L}])"),
  ru("школьная форма", "(?<![\\p{L}])школьн\\p{L}*\\s+форм\\p{L}*"),
];

/**
 * Words that are ordinary in a vibe ("girl next door", "it-girl", "kids-free",
 * "a youthful smile", "petite", "innocent") but never belong in the
 * descriptor, an appearance anchor the engine writes: there she is a
 * "woman", and nothing may suggest she is not a grown adult. Neutral geometry
 * stays allowed: a round face, a small frame, a slight build, a button nose,
 * rosy cheeks; so do "old-school" and "salon-grade".
 */
const DESCRIPTOR_YOUTH: WordRule[] = [
  en("girl", "girl\\w*"),
  en("gurl", "gurls?|grls?"),
  en("kid", "kids?|kidd\\w*"),
  en("child", "child\\w*"),
  en("baby", "bab(?:y|ies)\\w*"),
  en("doll-like", "doll[- ]?like"),
  en("coed", "co-?eds?"),
  en("freshman", "freshm[ae]n"),
  en("sophomore", "sophomores?"),
  en("school", "(?<!old[- ])\\w*school\\w*"),
  en("Nth grade", "(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)[- ]grade(?:rs?)?|graders?"),
  en("grade school", "grade[- ]?school\\w*"),
  en("kindergarten", "kindergart\\w*"),
  en("uniform", "uniforms?"),
  en("just legal", "(?:just|barely)\\s+(?:legal|of\\s+age)"),
  en("drinking age", "drinking\\s+age"),
  en("old enough", "old\\s+enough"),
  en("half her age", "half\\s+(?:her|his|their)\\s+age"),
  en("youthful", "youthful\\w*"),
  // The "N-year-old ... woman" anchor carries her age; "young" would pull an age-21 image toward the lower bound.
  en("young", "young\\w*"),
  en("boyish", "boyish\\w*"),
  en("petite", "petite"),
  en("tiny", "tiny"),
  en("underdeveloped", "(?:un|under)[- ]?developed"),
  en("flat-chested", "flat[- ]?chested"),
  en("pigtails", "pig-?tails?"),
  en("braces", "braces"),
  en("innocent", "innocen\\w*"),
  en("virgin", "virgin\\w*"),
  en("nubile", "nubile"),
  en("cherub", "cherub\\w*"),
  en("ingenue", "ingenues?"),
  en("waif", "waif\\w*"),
  en("fresh-faced", "fresh[- ]?faced"),
  en("college-age", "college[- ]?age\\w*"),
  en("doe-eyed", "doe[- ]?eyed"),
  en("prom queen", "prom[- ]?queens?"),
  en("junior", "junior\\w*|jr"),
  en("tween", "tween\\w*"),
  en("lil", "lil"),
  en("smol", "smol"),
  en("yung", "yung"),
  en("lass", "lass(?:ie)?s?"),
  en("missy", "missy"),
  en("maiden", "maidens?"),
  en("damsel", "damsels?"),
  en("kawaii", "kawaii"),
  en("chibi", "chibi"),
  en("shoujo", "shoujo|shojo"),
  en("nymph", "nymph\\w*"),
  en("minor", "minor(?:ly|s)?"),
  en("bambina", "bambin[ao]s?"),
  // Spanish "niña" (girl) folds to "nina". A real word only: short words run together make it by chance ("tan in a").
  en("nina", "ninas?", { joins: false }),
  ru("девочка", "(?<![\\p{L}])девочк\\p{L}*"),
  ru("ребёнок", "(?<![\\p{L}])реб[её]н\\p{L}*"),
];

function youthMatches(text: string, scope: AgeTextScope): { rule: WordRule; words: string[] }[] {
  const forms = scope === "descriptor" ? descriptorForms(text) : { text: normalise(text), joined: "" };
  const rules = scope === "descriptor" ? [...HARD_YOUTH, ...DESCRIPTOR_YOUTH] : HARD_YOUTH;
  return rules
    .map((rule) => ({
      rule,
      words: [...forms.text.matchAll(rule.pattern), ...(rule.joins ? forms.joined.matchAll(rule.pattern) : [])].map((m) => m[0]),
    }))
    .filter((match) => match.words.length > 0);
}

/** Words that describe a minor or a youthful look, in English or Russian, as the text has them (the renderer quotes the user's own words). */
export function youthWords(text: string, scope: AgeTextScope = "descriptor"): string[] {
  return youthMatches(text, scope).flatMap((match) => match.words);
}

/**
 * The hard markers of a minor only ("teen", "minor", "school uniform"), as
 * the text has them: the vibe's whole set, and what any text about a person
 * is held to. Words that only describe a youthful look ("young",
 * "youthful", "girl") are the descriptor's stricter set.
 */
export function hardYouthWords(text: string): string[] {
  return youthWords(text, "vibe");
}

/** The fixed names of the rules the text breaks, each once: what a retry is told to avoid, never text of the answer. */
export function youthRuleNames(text: string, scope: AgeTextScope): string[] {
  return [...new Set(youthMatches(text, scope).map((match) => match.rule.name))];
}

/**
 * English number words: two..nineteen and every -teen form, "twenty" in every
 * form ("twenties" can mean 20), the other tens and their ordinals, hundreds,
 * dozens, and the ordinals from fourth on. Allowed: a lone "one" ("a mole on
 * one cheek", "no one"; "she is one" is no realistic marker next to the
 * anchor) and the decades as a style ("seventies-style", "nineties brows").
 * Two..nine are refused: a descriptor needs no count ("a mole", not "two
 * moles"), and "she is nine" would be an age.
 */
const NUMBER_WORD = new RegExp(
  "\\b(?:zero|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|(?:thir|four|fif|six|seven|eigh|nine)teen\\w*" +
    "|twent(?:y|ie)\\w*|(?:thir|for|four|fif|six|seven|eigh|nine)t(?:y\\w*|ieth\\w*)|hundred\\w*|thousand\\w*|dozens?" +
    "|(?:four|fif|six|seven|eigh|nin|ten|eleven|twelf)th)\\b",
  "iu",
);

/**
 * True when the descriptor holds a number besides its one "<age>-year-old"
 * anchor: any digit, or a number word (see NUMBER_WORD), also spelled out.
 * Closes "t33n", "18+", "of 16", "who is sixteen", "not yet 21" at once.
 */
function hasNumberBesideAnchor(text: string, age: number): boolean {
  const rest = normalise(text).replace(new RegExp(`(?<![0-9])${age}-year-old`), " ");
  const forms = descriptorForms(rest);
  return /[0-9]/.test(rest) || NUMBER_WORD.test(`${forms.text}|${forms.joined}`);
}

const DESCRIPTOR_CHARS = /^[A-Za-z0-9 \-.,;:!?'"()/&%+]*$/;
const LATIN = /\p{Script=Latin}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;

/** True when the text breaks the scope's script policy (see the header comment). */
function breaksScriptPolicy(text: string, scope: AgeTextScope): boolean {
  const normalized = foldForms(text);
  if (scope === "descriptor") return !DESCRIPTOR_CHARS.test(normalized);
  const words = normalized.match(/[\p{L}\p{M}]+/gu) ?? [];
  return words.some((word) => {
    const letters = Array.from(word).filter((ch) => /\p{L}/u.test(ch));
    const latin = letters.some((ch) => LATIN.test(ch));
    const cyrillic = letters.some((ch) => CYRILLIC.test(ch));
    const other = letters.some((ch) => !LATIN.test(ch) && !CYRILLIC.test(ch));
    return other || (latin && cyrillic);
  });
}

/** The descriptor's longest text (the contract's AvatarDescriptor); longer is refused before any other check. */
export const DESCRIPTOR_MAX_CHARS = 600;

/**
 * Descriptor only: `number` — a number besides the "<age>-year-old" anchor;
 * `too-long` — over DESCRIPTOR_MAX_CHARS, which is all that is reported then.
 */
export type AdultTextProblem = "script" | "non-ascii-digits" | "other-age" | "under-21-bound" | "youth-word" | "number" | "too-long";

/** Why a text that goes into prompts is not clearly about a 21+ adult of the given age; empty when it is. */
export function adultTextProblems(text: string, age: number, scope: AgeTextScope): AdultTextProblem[] {
  // Bounded before anything else: the checks must never block the engine on a runaway answer.
  if (scope === "descriptor" && text.length > DESCRIPTOR_MAX_CHARS) return ["too-long"];
  const problems: AdultTextProblem[] = [];
  if (breaksScriptPolicy(text, scope)) problems.push("script");
  if (nonAsciiDigits(text).length > 0) problems.push("non-ascii-digits");
  if (ageMentions(text).some((n) => n !== age)) problems.push("other-age");
  if (ageUpperBounds(text).some((n) => n <= 21)) problems.push("under-21-bound");
  if (youthWords(text, scope).length > 0) problems.push("youth-word");
  if (scope === "descriptor" && hasNumberBesideAnchor(text, age)) problems.push("number");
  return problems;
}
