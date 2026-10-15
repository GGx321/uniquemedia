// Stage 5, 5b.2, S5.WC2b round 2 (the controller's decision after the adversarial review): the POSITIVE motion grammar. A blacklist of undressing paraphrases cannot close
// the class (three rounds and a review proved it), so a model's text (a vision text on any frame, an own idea on an ordinary frame; motionText.ts decides the scope) is read
// against what a motion may say, and anything it cannot read is refused:
//
//   «she» + adverbs + ONE main verb + an object the verb may take + tails (degree, direction, a place), clause by clause («and», «as», «while», a comma);
//   a few subject-first forms («her hair stirs in the wind», «her raised feet swing slowly», «her chest rises a little», «her skirt flutters in the breeze»).
//
// The verbs and the objects are the bank's own: `BANK_VERBS` is every clause verb of the 271 bank motions and the 7 code motions (derived mechanically;
// motionGrammar.test.ts proves the list is exactly theirs and that every one of those motions reads), generalised by the class of what each verb moves (her face, her hands,
// her feet, a prop …), plus a small curated extension of safe motions (`CURATED_VERBS`). What she wears is an object only of the dressing forms (adjusts, smooths,
// straightens, fixes, tucks in, tugs … a little, puts on, slips into, pulls on, pulls … closed, zips or buttons up, and the bank's own «slides the strap up», «tugs the
// coat closer», «lets the strap settle on her shoulder»), from a closed list; an unknown garment noun («bandeau», «pareo») is never read. «it» and «them» read only where
// the text has named something they may stand for, and nothing she wears. A second object after «and» is a clause of its own, so it is read (and refused) on its own.
//
// Besides the yes or no, the reading says what a refused text names, for motionText.ts to choose its code: undressing (`takes-off`, final), her body (`content`), or
// neither (`not-motion`, which a repair may fix). Pure: no clock, no I/O, nothing imported.
//
// Round 3 (the re-review): «it» and «them» take the class of what they stand for («lifts her legs and spreads them» spreads her legs); a towel or a sheet after «off» or
// «from» is a place only after her body moving («steps off the towel», never «takes off her towel»); a garment held closed, then her hands let go, undresses her; her
// shoulder is never something slips off (only her hair); a pose toward the mirror, an arched back with her hips, her arms squeezed together or her knees apart is no
// motion it reads. Each clause says how it was read (`MotionReading.clauses`), so the old takes-off forms keep their veto over every generic form.

const list = (text: string): string[] => text.split(/\s+/).filter((word) => word !== "");

// ---------- the lexicon ----------

/**
 * Every clause verb of the 271 bank motions and the 7 code motions, as they write them (the third person; a clause after «and» or a comma may also use the base or the -ing
 * form). Derived mechanically; motionGrammar.test.ts recomputes it from the banks and pins equality.
 */
export const BANK_VERBS = list(
  "blinks bounces breathes brushes buries catches closes crosses dips draws flexes gathers gives glances jingles keeps kicks laughs leans lets lifts looks lowers pats " +
    "peeks pins points presses pulls raises reaches relaxes rests rises rocks rolls runs scrolls settles shifts sinks sips slides smiles smooths squeezes steps stirs " +
    "stretches sways sweeps swings swirls takes taps tightens tilts trails tucks tugs turns twirls uncrosses walks watches wiggles zips",
);

/** The curated extension: small, safe motions the bank does not happen to say (each with the objects it may take, below). */
export const CURATED_VERBS = list(
  "nods shakes shrugs yawns sighs giggles grins winks waves opens parts spreads arches bends rubs touches plays fiddles holds puts places lays drops lies sits stands " +
    "poses waits spins snuggles props hugs wraps pushes does flashes adjusts straightens fixes removes slips grips hooks sets brings digs gets",
);

/** What a noun names, as the grammar reads it. */
type NounClass =
  | "FACE"
  | "HAND"
  | "FEET"
  | "LEGS"
  | "KNEE"
  | "HAIR"
  | "HIPS"
  | "SHOULDER"
  | "BACK"
  | "TRUNK"
  | "SIDE"
  | "OTHER"
  | "SPOT"
  | "BREATH"
  | "PROP"
  | "ACC"
  | "PLACE"
  | "COVER"
  | WornClass
  | "BODYX"
  | "PRON";
/** What she wears, by the way it may move: an outer layer, a top, what covers her legs, a skirt or a dress, a strap or a neckline, a sleeve, underwear or swimwear, a towel, her outfit, a fastening; and a garment the grammar does not know. */
type WornClass = "OUTER" | "TOP" | "LOWER" | "SKIRT" | "STRAP" | "SLEEVE" | "INNER" | "TOWEL" | "OUTFIT" | "PART" | "XWORN";
const WORN_CLASSES: readonly WornClass[] = ["OUTER", "TOP", "LOWER", "SKIRT", "STRAP", "SLEEVE", "INNER", "TOWEL", "OUTFIT", "PART", "XWORN"];

const NOUNS: ReadonlyMap<string, NounClass> = new Map(
  (
    [
      ["FACE", "head chin face cheek cheeks neck nose brow brows eyebrow eyebrows eye eyes gaze lips lip ear ears forehead jaw"],
      ["HAND", "hand hands finger fingers fingertips thumb thumbs wrist wrists arm arms elbow elbows palm palms fist fists"],
      ["FEET", "foot feet toe toes ankle ankles heel"],
      ["LEGS", "leg legs shin shins calf calves"],
      ["KNEE", "knee knees"],
      ["HAIR", "hair strand strands ponytail curls curl bangs fringe braid braids lock locks bun"],
      ["HIPS", "hip hips"],
      ["SHOULDER", "shoulder shoulders"],
      ["TRUNK", "chest stomach belly"],
      ["SIDE", "side"],
      ["OTHER", "other"],
      ["SPOT", "heart lap pocket pockets"],
      ["BREATH", "breath breaths sip sips step steps smile smiles glance look half-smile sigh yawn spin twirl kiss laugh nod grin"],
      [
        "PROP",
        "cup mug glass book keys key fork spoon brush phone bag clutch purse handbag tote backpack bottle laces curtain curtains coffee tea drink weight weights menu card ticket magazine pillow cushion flower flowers petal petals umbrella straw candle leash ball racket map notebook pen elevator doorbell remote latte cappuccino espresso page pages",
      ],
      ["ACC", "sunglasses glasses hat cap beanie hood scarf earring earrings necklace bracelet bracelets watch ring rings headphones earbuds hairclip clip scrunchie headband heels shoes sandals sneakers boots slippers flip-flops gloves"],
      [
        "PLACE",
        "window water mirror sun sand foam floor tiles railing post pose stretch light wall door table counter ledge shore sea waves wave pool edge seat grass sky view shade sunset city street balcony room bed sofa couch chair lounger hammock rug carpet wind breeze rain air bathtub tub sink stairs beach dock deck terrace garden car doorway ground way",
      ],
      ["COVER", "blanket blankets sheet sheets duvet duvets quilt quilts comforter covers"],
      ["OUTER", "jacket jackets coat coats cardigan cardigans hoodie hoodies sweater sweaters jumper jumpers sweatshirt sweatshirts blazer blazers robe robes bathrobe bathrobes kimono kimonos shawl shawls parka parkas poncho ponchos pullover pullovers"],
      ["TOP", "top tops shirt shirts t-shirt t-shirts tee tees blouse blouses turtleneck turtlenecks"],
      ["LOWER", "jeans trousers pants leggings shorts tights stockings sock socks"],
      ["SKIRT", "skirt skirts dress dresses hem hems hemline hemlines"],
      ["STRAP", "strap straps waistband waistbands neckline necklines collar collars zip zipper zippers"],
      ["SLEEVE", "sleeve sleeves"],
      ["INNER", "bra bras bralette bralettes bikini bikinis swimsuit swimsuits swimwear lingerie camisole camisoles cami bodysuit bodysuits panties briefs underwear thong thongs babydoll babydolls nightgown nightgowns nightie nighties nightdress nightdresses pajamas pyjamas sarong sarongs"],
      ["TOWEL", "towel towels"],
      ["OUTFIT", "outfit outfits clothes clothing"],
      ["PART", "belt belts sash sashes button buttons buckle buckles clasp clasps drawstring drawstrings bodice bodices tie ties"],
      [
        "XWORN",
        "bandeau bandeaus tank tanks bottoms one-piece wrap wraps cover-up cover-ups coverup pareo pareos halter teddy negligee negligees chemise chemises corset corsets bustier bustiers gown gowns sundress sundresses minidress romper rompers jumpsuit jumpsuits playsuit overalls leotard catsuit tunic tunics kaftan caftan knickers garter garters monokini fabric material cloth silk satin lace chiffon folds trunks onesie",
      ],
      [
        "BODYX",
        "thigh thighs torso abs bum bottom butt buttocks curves tummy cleavage midriff navel bust breasts breast bosom decolletage underboob sideboob crotch groin waist body figure skin collarbone collarbones nipple nipples",
      ],
      ["PRON", "it them they"],
    ] as const
  ).flatMap(([cls, words]) => list(words).map((word): [string, NounClass] => [word, cls])),
);

/** The body words a refused text shows (`content`): her body, never a place her hand may rest. */
const BODY_SHOWN = new Set(list("thigh thighs torso abs bum bottom butt buttocks curves tummy cleavage midriff navel bust breasts breast bosom decolletage underboob sideboob crotch groin nipple nipples"));

const DETERMINERS = new Set(list("her the a an one both each some"));
const ADVERBS = new Set(list("slowly gently softly slightly lightly carefully calmly quietly lazily absently idly casually smoothly playfully shyly just still again"));
/** Words that only describe what follows («her raised feet», «a small sip», «her denim jacket»). */
const ADJECTIVES = new Set(
  list(
    "raised crossed lifted bent dangling small deep little half big soft warm gentle slight long light thin thick white black red blue green pink beige grey gray brown navy cream yellow purple orange " +
      "denim leather wool woollen woolen cotton linen knit knitted cozy cosy oversized favorite favourite summer winter rain picnic beach bath hotel morning evening fluffy fuzzy chunky",
  ),
);
/** What she wears on her feet: a garment word before it only names the kind («her dress shoes»). */
const FOOTWEAR = new Set(list("heels shoes sandals sneakers boots slippers flip-flops"));
/** A noun that names a part of what follows «of»: «a strand of hair» is her hair, «the top of her head» is her head. */
const PARTITIVES = new Set(list("strand strands lock locks piece bit edge corner end top"));
/** A part that belongs to what it is of, or to what names it first: «the strap of her bag», «the seat belt», «the elevator button». */
const PARTS_OF_THINGS = new Set(list("strap straps zip zipper belt buckle button buttons laces"));
const NOT_HERS = new Set(list("bag handbag purse clutch backpack tote camera guitar suitcase luggage seat watch phone shoe shoes sandal sandals boot boots helmet leash door window elevator lift remote doorbell keyboard dog"));
/** «top» is no garment before these («her top knee», «the top of her head», «her top lip»). */
const TOP_NOT = new Set(list("knee leg foot arm hand of step stair shelf bunk lip lips teeth tooth row corner half floor drawer lid"));
/** A cover or a towel after these is a place («lies back on the towel», «snuggles under the blanket»). */
const PLACE_PREPS = new Set(list("on onto under beneath into across in"));
/** «off» and «from» lead to a place only after her body moving (the re-review's H1: «takes off her towel» is no place she leaves). */
const LEAVING_PREPS = new Set(list("off from"));
const BODY_MOVES = new Set(list("steps step stepping rolls roll rolling rises rise rising sits sit sitting lies lie lying gets get getting stands stand standing climbs climb climbing"));
const PARTICLES = new Set(list("up down back out away over"));
const PLACE_IN_CONTEXT = new Set(list("towel towels blanket blankets sheet sheets duvet duvets quilt covers pillow glass"));

const PREPS = list("in on onto into to toward towards through along against behind at from over under across around above near beside by off with up down past below out");
const DIRECTIONS = list("up down in out back away forward forwards off over around aside along on upward upwards downward downwards sideways across");
const DEGREES = list("more further higher lower closer deeper wider tight together again");
/** Fixed phrases a motion's tail says, read as one word each. */
const PHRASES: readonly (readonly [RegExp, string])[] = [
  [/\bside to side\b/g, "SIDETOSIDE"],
  [/\bthe other way\b/g, "OTHERWAY"],
  [/\b(?:back )?(?:into|in) place\b/g, "INPLACE"],
  [/\bto herself\b/g, "TOHERSELF"],
  [/\bto warm up\b/g, "TOWARMUP"],
  [/\bat arm's length\b/g, "ATARMSLENGTH"],
  [/\bbehind her(?=$| ,| and| as| while)/g, "BEHINDHER"],
  [/\bwith (?:each|every) breath\b/g, "EACHBREATH"],
  [/\bface down\b/g, "FACEDOWN"],
  [/\band back\b/g, "ANDBACK"],
  [/\bin front of\b/g, "infrontof"],
];
/** The words that open the next clause. */
const JOINERS = new Set([",", "and", "as", "while"]);
/** Words that would open a clause the grammar does not read («then», «until» …): the text is not read. */
const OTHER_OPENERS = new Set(list("then when until till but so or before after because"));

// ---------- the verbs: what each may move ----------

const FACE = "#FACE";
const HAND = "#HAND";
const FEET = "#FEET";
const LEGS = "#LEGS";
const KNEE = "#KNEE";
const HAIR = "#HAIR";
const HIPS = "#HIPS";
const SHOULDER = "#SHOULDER";
const BACK = "#BACK";
const BREATH = "#BREATH";
const PROP = "#PROP";
const ACC = "#ACC";
const PLACE = "#PLACE";

/** Each verb (third person) with the objects it may take; none: it takes no object (a place or a direction may still follow). `wear`: «in her dress» may follow. */
interface VerbRule {
  readonly objects: readonly string[];
  readonly wear?: true;
  readonly extra?: string;
  /** A hand that strokes or slides: its tail reaches only places, props and her hair. */
  readonly strokes?: true;
}
const VERBS: ReadonlyMap<string, VerbRule> = new Map<string, VerbRule>([
  // the bank's own, each with the classes of what the bank moves with it
  ["blinks", { objects: [] }],
  ["bounces", { objects: [FEET, LEGS, KNEE] }],
  ["breathes", { objects: [] }],
  ["brushes", { objects: [PLACE, HAIR, PROP] }],
  ["buries", { objects: [FEET, HAND, FACE] }],
  ["catches", { objects: [BREATH] }],
  ["closes", { objects: [FACE, PROP] }],
  ["crosses", { objects: [FEET, LEGS, KNEE, HAND] }],
  ["uncrosses", { objects: [FEET, LEGS, KNEE, HAND] }],
  ["dips", { objects: [FEET, HAND] }],
  ["draws", { objects: [PROP, LEGS, KNEE] }],
  ["flexes", { objects: [FEET, HAND] }],
  ["gathers", { objects: [HAIR] }],
  ["gives", { objects: [BREATH] }],
  ["glances", { objects: [] }],
  ["jingles", { objects: [PROP] }],
  ["kicks", { objects: [FEET, LEGS, KNEE, ACC] }],
  ["laughs", { objects: [], wear: true }],
  ["leans", { objects: [FACE] }],
  ["lifts", { objects: [FEET, LEGS, KNEE, PROP, ACC, HIPS, HAND, FACE, HAIR] }],
  ["looks", { objects: [] }],
  ["lowers", { objects: [HAND, FEET, LEGS, KNEE, PROP, ACC, FACE] }],
  ["pats", { objects: [FACE, HAIR] }],
  ["peeks", { objects: [] }],
  ["pins", { objects: [HAIR] }],
  ["points", { objects: [FEET, HAND] }],
  ["presses", { objects: [FEET, FACE, HAND, PROP] }],
  ["pulls", { objects: [HAND, PROP, LEGS, KNEE, ACC] }],
  ["raises", { objects: [PROP, ACC, HAND, FACE, SHOULDER] }],
  ["reaches", { objects: [] }],
  ["relaxes", { objects: [SHOULDER, HAND, FACE], wear: true }],
  ["rests", { objects: [FACE, HAND, FEET], wear: true }],
  ["rises", { objects: [] }],
  ["rocks", { objects: [FEET, LEGS, KNEE] }],
  ["rolls", { objects: [SHOULDER, FACE] }],
  ["runs", { objects: [HAND], strokes: true }],
  ["scrolls", { objects: [PROP] }],
  ["settles", { objects: [] }],
  ["shifts", { objects: [FEET, LEGS, KNEE, HIPS, SHOULDER, PROP] }],
  ["sinks", { objects: [] }],
  ["sips", { objects: [PROP] }],
  ["slides", { objects: [HAND, FEET, LEGS, KNEE, ACC], strokes: true }],
  ["smiles", { objects: [], wear: true }],
  ["smooths", { objects: [HAIR] }],
  ["squeezes", { objects: [HAIR] }],
  ["steps", { objects: [] }],
  ["stirs", { objects: [PROP] }],
  ["stretches", { objects: [HAND, FEET, LEGS, KNEE, FACE, BACK] }],
  ["sways", { objects: [FEET, LEGS, KNEE, HIPS], wear: true }],
  ["sweeps", { objects: [HAIR] }],
  ["swings", { objects: [FEET, LEGS, KNEE, PROP] }],
  ["swirls", { objects: [FEET, PROP] }],
  ["takes", { objects: [BREATH, ACC] }],
  ["taps", { objects: [FEET, HAND, PROP, ACC] }],
  ["tightens", { objects: [HAIR] }],
  ["tilts", { objects: [FACE, FEET, PROP, ACC] }],
  ["trails", { objects: [HAND], strokes: true }],
  ["tucks", { objects: [HAIR, PROP, ACC] }],
  ["tugs", { objects: [ACC] }],
  ["turns", { objects: [FACE, HIPS, FEET, PROP, ACC], wear: true }],
  ["twirls", { objects: [PROP, HAIR], wear: true }],
  ["walks", { objects: [], wear: true }],
  ["watches", { objects: [PLACE], extra: "fade" }],
  ["wiggles", { objects: [FEET, HAND] }],
  ["zips", { objects: [PROP] }],
  // the curated extension
  ["nods", { objects: [] }],
  ["shakes", { objects: [FACE] }],
  ["shrugs", { objects: [SHOULDER] }],
  ["yawns", { objects: [] }],
  ["sighs", { objects: [] }],
  ["giggles", { objects: [] }],
  ["grins", { objects: [] }],
  ["winks", { objects: [] }],
  ["waves", { objects: [HAND] }],
  ["opens", { objects: [FACE, PROP] }],
  ["parts", { objects: [FACE] }],
  ["spreads", { objects: [HAND] }],
  ["arches", { objects: [BACK] }],
  ["bends", { objects: [LEGS, KNEE, FACE] }],
  ["rubs", { objects: [HAND], strokes: true }],
  ["touches", { objects: [ACC, PROP, HAIR, FACE] }],
  ["plays", { objects: [] }],
  ["fiddles", { objects: [] }],
  ["holds", { objects: [PROP, ACC, HAND] }],
  ["puts", { objects: [HAND, ACC] }],
  ["places", { objects: [HAND] }],
  ["lays", { objects: [HAND] }],
  ["drops", { objects: [HAND] }],
  ["lies", { objects: [], wear: true }],
  ["sits", { objects: [], wear: true }],
  ["stands", { objects: [], wear: true }],
  ["poses", { objects: [], wear: true }],
  ["waits", { objects: [], wear: true }],
  ["spins", { objects: [], wear: true }],
  ["snuggles", { objects: [] }],
  ["hugs", { objects: [LEGS, KNEE, PROP] }],
  ["wraps", { objects: [HAND, ACC] }],
  ["pushes", { objects: [ACC, HAIR] }],
  ["does", { objects: [BREATH], wear: true }],
  ["flashes", { objects: [BREATH] }],
  ["adjusts", { objects: [ACC, HAIR] }],
  ["straightens", { objects: [ACC] }],
  ["fixes", { objects: [ACC, HAIR] }],
  ["removes", { objects: [ACC] }],
  ["slips", { objects: [ACC] }],
  ["grips", { objects: [PROP, ACC] }],
  ["hooks", { objects: [HAND], strokes: true }],
  ["sets", { objects: [PROP, ACC] }],
  ["brings", { objects: [PROP, ACC, HAND], strokes: true, extra: `to ${FACE}` }],
  ["digs", { objects: [FEET, HAND] }],
  ["gets", { objects: [] }],
]);

/** The base and the -ing form of a third-person verb («tucks» → tuck, tucking; «rises» → rise, rising; «lies» → lie, lying). */
function formsOf(verb: string): string[] {
  const irregular: Record<string, readonly string[]> = { lies: ["lie", "lying"], does: ["do", "doing"], ties: ["tie", "tying"], buries: ["bury", "burying"] };
  const known = irregular[verb];
  if (known !== undefined) return [verb, ...known];
  const base = /(?:ch|sh|ss|x)es$/.test(verb) ? verb.slice(0, -2) : verb.slice(0, -1);
  const doubled = new Set(list("dip pat pin tug sip tap step nod shrug hug rub prop pop drop spin sit grip slip flip wrap swim skip"));
  const ing = doubled.has(base) ? `${base}${base.slice(-1)}ing` : /[^e]e$/.test(base) ? `${base.slice(0, -1)}ing` : `${base}ing`;
  return [verb, base, ing];
}
/** Every form of every verb, back to its third person. */
const FORM_OF: ReadonlyMap<string, string> = new Map([...VERBS.keys()].flatMap((verb) => formsOf(verb).map((form): [string, string] => [form, verb])));

// ---------- the clause shapes ----------

const alt = (items: readonly string[]): string => `(?:${items.join("|")})`;
const ADV = "ADV";
const MANNER = alt([ADV, "a little", "a bit", "a touch"]);
/** A noun a preposition may lead to: a place, a prop, or a part of her that a motion may touch or rest on (never her legs, her back, her chest or her body). */
const PP_OBJECT = alt([PLACE, PROP, ACC, FACE, HAND, FEET, HAIR, "#SIDE", "#OTHER", "#SPOT"]);
const TAIL_ITEM = alt([
  MANNER,
  alt(DEGREES),
  alt(DIRECTIONS),
  "SIDETOSIDE",
  "OTHERWAY",
  "INPLACE",
  "TOHERSELF",
  "TOWARMUP",
  "ATARMSLENGTH",
  "BEHINDHER",
  "EACHBREATH",
  "ANDBACK",
  `${alt(PREPS)} ${PP_OBJECT}`,
  `(?:to|on) ${HIPS}`,
  // Her shoulder is a place to look over, rest on or reach to, never one something slips off (the re-review's «adjusts her robe, slipping off her shoulders»).
  `(?:over|on|onto|behind|to|toward|towards|at|across) ${SHOULDER}`,
  `(?:on|onto|around|over|to|against) ${KNEE}`,
  `infrontof ${PP_OBJECT}`,
]);
/** The tail of a hand that strokes or slides (runs, trails, slides, rubs): only to a place, a prop, her hair, a pocket or «the other» (never along her body). */
const STROKE_TAIL_ITEM = alt([MANNER, alt(DEGREES), alt(DIRECTIONS), "TOWARMUP", "INPLACE", `${alt(PREPS)} ${alt([PLACE, PROP, HAIR, "#OTHER", "#SPOT"])}`]);
const tail = (more: readonly string[] = []): string => `(?: ${alt([TAIL_ITEM, ...more])})*`;
/** The tail of what she wears: the manner and the shape's own words alone (never a direction, a degree or a place that would move it: «a little lower», «off her shoulder»). */
const keptTail = (more: readonly string[] = []): string => `(?: ${alt([MANNER, ...more])})*`;
const forms = (verbs: readonly string[]): string => alt(verbs.flatMap(formsOf));
/** The worn classes the closed list holds (never an unknown garment). */
const WORN = "#(?:OUTER|TOP|LOWER|SKIRT|STRAP|SLEEVE|INNER|TOWEL|OUTFIT|PART)";
const WEAR_PP = `in ${WORN}`;

/** The generic shape of a verb: «she», adverbs, the verb, a particle, an object it may take, the tail (and «in her dress» for a verb she may do in it). */
function verbShape(verb: string, rule: VerbRule): RegExp {
  const objects = rule.objects.length === 0 ? "" : `(?: ${alt([...rule.objects, "#PRON"])})?`;
  const more = [...(rule.wear === true ? [WEAR_PP] : []), ...(rule.extra === undefined ? [] : [rule.extra])];
  const rest = rule.strokes === true ? `(?: ${alt([STROKE_TAIL_ITEM, ...more])})*` : tail(more);
  const shape = `^she(?: ${ADV})* ${forms([verb])}(?: ${alt(DIRECTIONS)})?(?: ${ADV})*${objects}${rest}$`;
  // Her hair, and only her hair, may be moved off or from her shoulder («brushes her hair off her shoulder»).
  const hair = rule.objects.includes(HAIR) ? `|^she(?: ${ADV})* ${forms([verb])}(?: ${alt(DIRECTIONS)})?(?: ${ADV})* ${HAIR}${tail([...more, `(?:off|from) ${SHOULDER}`])}$` : "";
  return new RegExp(`${shape}${hair}`);
}
const VERB_SHAPES: ReadonlyMap<string, RegExp> = new Map([...VERBS].map(([verb, rule]) => [verb, verbShape(verb, rule)]));

/** A shape over the tagged clause, and what its own words must also say or must not say. */
interface Shape {
  readonly shape: RegExp;
  readonly needs?: RegExp;
  readonly unless?: RegExp;
}
const she = (verbs: string, rest: string, more: readonly string[] = []): RegExp => new RegExp(`^she(?: ${ADV})* ${forms(list(verbs))}(?: ${ADV})* ${rest}${tail(more)}$`);
/** A shape of what she wears: its tail is the manner and its own words alone. */
const kept = (verbs: string, rest: string, more: readonly string[] = []): RegExp => new RegExp(`^she(?: ${ADV})* ${forms(list(verbs))}(?: ${ADV})* ${rest}${keptTail(more)}$`);
const SMALL = /\b(?:a little|a bit|slightly)\b/;

/** The dressing forms: what she wears, moved only to keep it on or put it on. */
const DRESSING: readonly Shape[] = [
  // adjusts, straightens, fixes, smooths it (in the mirror; a strap back on her shoulder; a skirt or a dress over her knees; smoothed down).
  { shape: kept("adjusts straightens fixes", WORN, ["in #PLACE", `infrontof #PLACE`, `(?:back )?(?:on|onto|over) ${SHOULDER}`]) },
  { shape: kept("smooths", `(?:out )?(?:${WORN}|#COVER)`, ["out", "in #PLACE", `infrontof #PLACE`, `over ${KNEE}`]) },
  // smoothed down: only what down covers (a skirt, a hem, a top, her outfit, a sheet); never what covers her legs, a strap, a waistband or her underwear, which down lowers.
  { shape: kept("smooths", `(?:down )?#(?:SKIRT|TOP|OUTFIT|COVER)`, ["down", "out", "in #PLACE", `infrontof #PLACE`, `over ${KNEE}`]) },
  // tucks in a top (into her jeans or her skirt).
  { shape: kept("tucks", "(?:in )?#TOP", ["in", "into #(?:LOWER|SKIRT)"]) },
  // tugs (at) it a little.
  { shape: kept("tugs", `(?:at )?${WORN}`), needs: SMALL },
  // tugs at her sleeve; rolls, pushes or pulls up her sleeves (to her elbows); pulls them down or over her hands.
  { shape: kept("tugs", "at #SLEEVE") },
  { shape: kept("rolls pushes pulls", "(?:up )?#SLEEVE", ["up", "to #HAND"]), needs: /\bup\b/ },
  { shape: kept("pulls tugs", "(?:down )?#SLEEVE", ["down", "over #HAND"]), needs: /\b(?:down|over)\b/ },
  // pulls up what covers her legs, a strap, a waistband or a neckline (back onto her shoulder); never higher.
  { shape: kept("pulls tugs slides", "(?:(?:back )?up )?#(?:LOWER|STRAP)", ["up", "back up", `(?:back )?(?:on|onto) ${SHOULDER}`]), needs: /\b(?:up|on|onto)\b/, unless: /\bshorts\b/ },
  // turns up, pops or pulls up her collar.
  { shape: kept("turns pops pulls", "(?:up )?#STRAP", ["up"]), needs: /\bcollar\b/ },
  // pulls or tugs her skirt or her hem down (over her knees), holds or keeps it down in the wind; a dress only over her knees or in the wind.
  {
    shape: kept("pulls tugs holds keeps", "(?:down )?#SKIRT", ["down", `over ${KNEE}`, "in #PLACE"]),
    needs: /\b(?:down|over)\b/,
    // A dress only over her knees (pulled down in the breeze it may be a strapless one lowered: the re-review's «pulls her silk dress down in the breeze»).
    unless: /\bdress(?:es)?\b(?!.*\bover (?:her )?knees\b)/,
  },
  // pulls, tugs, holds or wraps an outer layer closed, closer, tighter or around her; closes it.
  { shape: kept("pulls tugs holds wraps", "#OUTER", ["closed", "shut", "tighter", "closer", "around her", `around her ${SHOULDER}`, `over ${SHOULDER}`]), needs: /\b(?:closed|shut|tighter|closer|around|over)\b/ },
  { shape: kept("closes", "#OUTER") },
  // puts on, slips on or into, pulls on an outer layer.
  { shape: kept("puts slips pulls", "(?:on )?#OUTER", ["on"]), needs: /\bon\b/ },
  { shape: kept("slips", "into #OUTER") },
  // zips or buttons it (up).
  { shape: kept("zips buttons fastens", "(?:up )?#(?:OUTER|TOP|SKIRT|OUTFIT)", ["up"]) },
  // the bank's own: lets the strap settle on her shoulder; tugs the coat closer and the waistband up; slides the strap up.
  { shape: kept("lets", "#STRAP settles?", [`(?:back )?(?:on|onto) ${SHOULDER}`]) },
];

/** What she lies under: pulled up, closer or over her; smoothed; snuggled under (a place then). */
const COVERING: readonly Shape[] = [
  { shape: kept("pulls tugs draws", "(?:up )?#COVER", ["up", "higher", "closer", "over her", `over ${SHOULDER}`, `to ${FACE}`, `up to ${FACE}`]), needs: /\b(?:up|higher|closer|over)\b/ },
  { shape: kept("tucks", "#COVER", ["in", "around her"]) },
];

/** A towel or a blanket she lays out or picks up off the sand (a prop there, never what she wears). */
const LAID_OUT: readonly Shape[] = [
  { shape: kept("lifts spreads lays shakes", "#(?:TOWEL|COVER)", [`${alt(["off", "on", "onto", "from", "across"])} #PLACE`]), needs: /\b(?:off|on|onto|from|across) the (?:sand|grass|lounger|beach|ground)\b/ },
];

/** Her body at rest: lying or rolling onto her stomach, her back or her side; her chest rising and falling; a hand on her stomach; her arms over her chest; her knees hugged to it. */
const POSTURE: readonly Shape[] = [
  { shape: she("lies rests stays", `(?:(?:back|down|flat) )?(?:FACEDOWN )?(?:on|onto) #(?:TRUNK|BACK|SIDE)`, ["with #FEET up"]), unless: /\bchest\b/ },
  { shape: she("lies rests stays", "FACEDOWN") },
  { shape: she("rolls turns flips", "(?:(?:over|back) )?(?:onto|on) #(?:TRUNK|BACK|SIDE)"), unless: /\bchest\b/ },
  { shape: she("crosses folds wraps", `${HAND} (?:over|across|around) #TRUNK`), needs: /\barms\b/, unless: /\b(?:stomach|belly)\b/ },
  { shape: she("hugs pulls draws", `${KNEE}(?: up)? (?:to|against|into) #TRUNK`), unless: /\b(?:stomach|belly)\b/ },
  { shape: she("rests places lays puts keeps", `${HAND} (?:on|over) #TRUNK`), unless: /\bchest\b/ },
  { shape: she("props", "herself up", [`on ${HAND}`]) },
  { shape: she("keeps", alt(list("jogging walking smiling swaying turning laughing rocking breathing stretching"))) },
  { shape: she("brushes", `${PLACE} (?:off|from) #(?:FEET|LEGS|KNEE|HAND|HAIR|FACE)`), needs: /\b(?:sand|dust|water|grass|snow|leaves|petals)\b/ },
];

/** A clause whose subject is a part of her or what she wears, with what it may do. */
const SUBJECT_FORMS: readonly Shape[] = [
  { shape: new RegExp(`^${HAIR}(?: ${ADV})* ${alt(list("lifts lift stirs stir sways sway flutters flutter ripples ripple billows billow moves move falls fall blows blow slips slip swaying fluttering"))}${tail([`(?:off|from) ${SHOULDER}`])}$`) },
  { shape: new RegExp(`^${FEET}(?: ${ADV})* ${alt(list("swing swings sway sways kick kicks bounce bounces swinging swaying"))}${tail()}$`) },
  { shape: new RegExp(`^${SHOULDER}(?: ${ADV})* ${alt(list("rise rises fall falls relax relaxes drop drops rising falling"))}${tail()}$`) },
  { shape: new RegExp(`^#TRUNK(?: ${ADV})* ${alt(list("rises rise rising falls fall falling"))}${tail()}$`), needs: /\bchest\b/ },
];
/** The curated breeze form, read on the whole text: «her hair and dress sway a little in the wind», «her skirt flutters in the breeze». */
const BREEZE = new RegExp(
  `^#(?:HAIR|SKIRT)(?: and (?:her )?#(?:HAIR|SKIRT))?(?: ${ADV})* ${alt(list("sways sway flutters flutter ripples ripple"))}(?: ${MANNER})* in #PLACE(?: ${MANNER})*$|^${HAIR}(?: ${ADV})* ${alt(list("billows billow"))}(?: ${MANNER})* in #PLACE(?: ${MANNER})*$`,
);
/** An absolute tail after a comma: «the water at her feet». */
const ABSOLUTE = new RegExp(`^${PLACE}(?: ${alt(PREPS)} ${PP_OBJECT})?(?: ${MANNER})*$`);

// ---------- reading a text ----------

/** A text's tokens, its fixed phrases folded into one word each. */
function tokensOf(text: string): string[] {
  let folded = text.toLowerCase();
  for (const [phrase, word] of PHRASES) folded = folded.replace(phrase, word);
  return folded.match(/[a-z0-9'-]+|,|[A-Z]+/g) ?? [];
}

/** One clause and the joiner that opened it (none for the first). */
interface Clause {
  readonly words: string[];
  readonly joiner: string;
}

/** Clauses, opened by a joiner; «and back» is a tail, never a clause. */
function clausesOf(tokens: readonly string[]): Clause[] {
  const clauses: Clause[] = [{ words: [], joiner: "" }];
  for (const word of tokens) {
    const current = clauses[clauses.length - 1] ?? { words: [], joiner: "" };
    if (JOINERS.has(word) && current.words.length > 0) clauses.push({ words: [], joiner: word });
    else current.words.push(word);
  }
  return clauses;
}

/** The class of the noun at `i`, read in its place («the towel» after «on» is a place, «her top knee» is no top), or null. */
function nounAt(tokens: readonly string[], i: number): NounClass | null {
  const word = tokens[i] ?? "";
  const prev = tokens[i - 1] ?? "";
  const next = tokens[i + 1] ?? "";
  if (word === "back") return prev === "her" ? "BACK" : null;
  if (word === "top" && TOP_NOT.has(next)) return next === "of" ? "OTHER" : null;
  const cls = NOUNS.get(word);
  if (cls === undefined) return null;
  // What she wears before a pocket only names the pocket («her jeans pockets»).
  if ((WORN_CLASSES as readonly string[]).includes(cls) && (next === "pocket" || next === "pockets")) return null;
  if (PLACE_IN_CONTEXT.has(word)) {
    let j = i - 1;
    while (j >= 0 && (DETERMINERS.has(tokens[j] ?? "") || ADJECTIVES.has(tokens[j] ?? "") || NOUNS.get(tokens[j] ?? "") === "PLACE")) j--;
    const prep = tokens[j] ?? "";
    if (PLACE_PREPS.has(prep)) return "PLACE";
    // The final touch: never bedding she lies under (getting off or out from the sheets leaves it), never after «out» («steps out from the towel» leaves it on the floor).
    if (LEAVING_PREPS.has(prep) && tokens.slice(j + 1, i).includes("the") && /^(?:towels?|blankets?)$/.test(word) && tokens[j - 1] !== "out") {
      let k = j - 1;
      while (k >= 0 && (PARTICLES.has(tokens[k] ?? "") || ADVERBS.has(tokens[k] ?? ""))) k--;
      if (BODY_MOVES.has(tokens[k] ?? "")) return "PLACE";
    }
  }
  return cls;
}

/** Whether a word may describe the noun that follows it (an adjective, or a noun used as one: «her denim jacket», «the coffee cup», «her bikini strap», «her jeans pockets»). */
const describes = (word: string): boolean => ADJECTIVES.has(word) || (NOUNS.has(word) && NOUNS.get(word) !== "PRON");

/** The class of a noun phrase from its head and what it is «of»: «a strand of hair» → her hair, «the strap of her bag» → a prop, «the hem of her dress» → a skirt. */
function phraseClass(head: string, headClass: NounClass, modifiers: readonly string[], ofClass: NounClass | null): NounClass {
  if (PARTS_OF_THINGS.has(head) && modifiers.some((m) => NOT_HERS.has(m))) return "PROP";
  // The final touch (M-A): a prop or an accessory word that names part of what she wears («her bra cup», «the clip of her bra», «the laces of her dress», «the hood of
  // her robe») is that garment's part, never a held thing; her shoes stay her shoes («her dress shoes»).
  const wornWord = (word: string): boolean => (WORN_CLASSES as readonly string[]).includes(NOUNS.get(word) ?? "");
  const wornOf = ofClass !== null && (WORN_CLASSES as readonly string[]).includes(ofClass);
  if ((headClass === "PROP" || headClass === "ACC") && !FOOTWEAR.has(head) && (modifiers.some(wornWord) || wornOf)) return "PART";
  if (ofClass === null) {
    // «bikini bottoms» are what covers her legs; «her jeans pockets» a pocket.
    if (head === "bottoms" && modifiers.some((m) => m === "bikini" || m === "swimsuit")) return "LOWER";
    return headClass;
  }
  if (PARTITIVES.has(head) || headClass === "OTHER") return ofClass;
  if (PARTS_OF_THINGS.has(head) && (ofClass === "PROP" || ofClass === "ACC" || ofClass === "PLACE")) return "PROP";
  return headClass;
}

/**
 * The clause with each noun phrase folded into its class («the hem of her dress» → `#SKIRT`, «a small sip» → `#BREATH`), its adverbs into `ADV`; the verb (at `verbAt`) is
 * never a noun («she zips the bag», «she brushes»).
 */
function tagged(tokens: readonly string[], verbAt: number): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const word = tokens[i] ?? "";
    if (i === verbAt) {
      out.push(word);
      i++;
      continue;
    }
    if (ADVERBS.has(word)) {
      out.push(ADV);
      i++;
      continue;
    }
    if (NOUNS.get(word) === "PRON") {
      out.push("#PRON");
      i++;
      continue;
    }
    // A noun phrase: a determiner, words that describe, a head noun; then «of» another.
    let j = i;
    if (DETERMINERS.has(word)) j++;
    const start = j;
    let head = -1;
    while (j < tokens.length && j !== verbAt && (describes(tokens[j] ?? "") || nounAt(tokens, j) !== null)) {
      if (nounAt(tokens, j) !== null) head = j;
      j++;
    }
    if (head < start) {
      out.push(word);
      i++;
      continue;
    }
    const headWord = tokens[head] ?? "";
    const headClass = nounAt(tokens, head) ?? "OTHER";
    const modifiers = tokens.slice(start, head);
    let end = head + 1;
    let ofClass: NounClass | null = null;
    if (tokens[end] === "of") {
      let k = end + 1;
      if (DETERMINERS.has(tokens[k] ?? "")) k++;
      let ofHead = -1;
      while (k < tokens.length && describes(tokens[k] ?? "")) {
        if (nounAt(tokens, k) !== null) ofHead = k;
        k++;
      }
      if (ofHead >= 0) {
        ofClass = nounAt(tokens, ofHead);
        end = ofHead + 1;
      }
    }
    out.push(`#${phraseClass(headWord, headClass, modifiers, ofClass)}`);
    i = Math.max(end, head + 1);
  }
  return out;
}

/** How a clause was read: by a form of what she wears (dressing, covering, laid out), by a verb whose object is an accessory or something she holds, or by any other form. */
export type ClauseRoute = "kept" | "held" | "free";

/** What a reading found besides yes or no: how each clause was read (the old takes-off forms' veto reads it), and for the code of a refusal what it names. */
export interface MotionReading {
  /** Every clause reads. */
  readonly ok: boolean;
  /** Each clause as written, with how it was read («free» for one it cannot read). */
  readonly clauses: readonly { readonly text: string; readonly route: ClauseRoute }[];
  /** The clauses it cannot read, as written. */
  readonly unread: readonly string[];
  /** The text names undressing: what she wears (or «it» with nothing it may stand for) with a verb or a direction that takes it off, opens, lifts or lowers it; or her hands let go of what she held closed. */
  readonly undresses: boolean;
  /** The body words it names that only show her body (thighs, cleavage, midriff …). */
  readonly bodyShown: readonly string[];
  /** It poses her body: toward the mirror, an arched back with her hips, her arms squeezed together, her knees apart. */
  readonly poses: boolean;
}


/** Verbs that take what she wears off, open, lift or lower it, in any form. */
const UNDRESS_VERBS = new Set(
  list(
    "untie unties untying unclasp unclasps unclasping unhook unhooks unhooking unbutton unbuttons unbuttoning unzip unzips unzipping undo undoes undoing unfasten unfastens " +
      "unfastening unwrap unwraps unwrapping unlace unlaces unlacing unbelt unbelts undrape undrapes unwind unwinds undress undresses undressing strip strips stripping peel " +
      "peels peeling shed sheds shedding remove removes removing release releases releasing loosen loosens loosening drop drops dropping lower lowers lowering lift lifts " +
      "lifting raise raises raising hike hikes hiking hitch hitches hitching gather gathers gathering bunch bunches bunching flip flips flipping hoist hoists hoisting inch inches " +
      "inching nudge nudges nudging slip slips slipping slide slides sliding fall falls falling ride rides riding creep creeps creeping hang hangs hanging open opens opening part " +
      "parts parting spread spreads spreading ease eases easing shrug shrugs shrugging let lets letting appears appearing changes changing swaps hook hooks hooking",
  ),
);
/** Verbs that name undressing with no object at all («she slowly undresses», «she reaches back and unclasps»). */
const UNDRESS_ALONE = new Set(list("undress undresses undressing strip strips stripping unclasp unclasps unclasping unhook unhooks unhooking unbutton unbuttons unbuttoning unfasten unfastens unfastening unlace unlaces unbelt unbelts"));
/** Directions that take any garment off, open or loose. */
const OFF_WORDS = new Set(list("off open apart aside away lower higher loose looser undone upward upwards knot"));
/** «down» takes these off (never a skirt, a hem, a sleeve or a top, which it covers); «up» lifts these (never what covers her legs, a strap or a sleeve, which it dresses). */
const DOWN_TAKES_OFF: ReadonlySet<NounClass> = new Set<NounClass>(["LOWER", "STRAP", "INNER", "OUTER", "PART", "TOWEL", "COVER"]);
const UP_LIFTS: ReadonlySet<NounClass> = new Set<NounClass>(["SKIRT", "TOP", "INNER"]);
/** Outer layers that lowering covers (a sweater pulled down covers her midriff), and those lifting bares (a robe lifted shows her legs). */
const KNITWEAR = /\b(?:sweaters?|jumpers?|hoodies?|sweatshirts?|pullovers?)\b/;
const ROBES = /\b(?:robes?|bathrobes?|kimonos?)\b/;
/** Garments «brushes off» cleans rather than takes off. */
const BRUSHED_CLEAN: ReadonlySet<NounClass> = new Set<NounClass>(["SKIRT", "TOP", "LOWER", "OUTER", "OUTFIT", "SLEEVE"]);

/** Whether a refused text names undressing (see `MotionReading.undresses`). */
function namesUndressing(tokens: readonly string[], text: string, pronounAlone: boolean): boolean {
  const classes = tokens.map((_, i) => nounAt(tokens, i));
  const worn = classes.filter((cls): cls is WornClass => cls !== null && (WORN_CLASSES as readonly string[]).includes(cls));
  const wears = worn.length > 0 || classes.includes("COVER") || pronounAlone;
  if (tokens.some((word) => UNDRESS_ALONE.has(word)) && !/\b(?:unzips?|unzipping) (?:her |the )?(?:bag|purse|clutch|backpack|suitcase)\b/.test(text)) return true;
  if (!wears) return false;
  const kinds = new Set<NounClass>([...worn, ...(classes.includes("COVER") ? (["COVER"] as const) : []), ...(pronounAlone ? (["OUTER"] as const) : [])]);
  const brushes = tokens.some((word) => /^brush/.test(word));
  /** «off» that takes nothing off: «show off», «the sand off», a skirt brushed off. */
  const offCleans = (i: number): boolean => {
    const prev = tokens[i - 1] ?? "";
    const before = classes[i - 1];
    return /^show/.test(prev) || before === "PLACE" || before === "PROP" || (brushes && [...kinds].every((kind) => BRUSHED_CLEAN.has(kind)));
  };
  if (tokens.some((word, i) => UNDRESS_VERBS.has(word) || (OFF_WORDS.has(word) && !(word === "off" && offCleans(i))))) return true;
  if (/\b(?:no|without)\b/.test(text)) return true;
  if (/\baround her (?:waist|hips|ankles|feet)\b|\bover the (?:chair|bed|floor|sofa|couch)\b|\bat her feet\b/.test(text)) return true;
  // The final touch's LOW: zipped down; out of or out from what she wears («steps out from her towel», «rises out of her top»).
  if (/\b(?:un)?zip\w*\b.*\bdown\b|\bout (?:of|from)\b/.test(text)) return true;
  // A part of what she wears (a ring, a clip, laces, a cup) pulled or tugged at undoes it («pulls the ring of her bikini top»).
  if (/\b(?:pull|tug)\w*\b/.test(text) && /\b(?:ring|clip|laces|lace|cup|clasp|hook|tie|knot)\b/.test(text)) return true;
  // A hand or a garment under, inside or into what she wears («slides her hand under her skirt», «tucks her skirt into her waistband»).
  if (tokens.some((word, i) => /^(?:under|beneath|inside|into)$/.test(word) && tokens.slice(i + 1, i + 4).some((_, k) => (WORN_CLASSES as readonly string[]).includes(classes[i + 1 + k] ?? "")))) return true;
  const knitOnly = KNITWEAR.test(text) && !ROBES.test(text) && [...kinds].every((kind) => kind === "OUTER");
  if (tokens.includes("down") && !knitOnly && [...kinds].some((kind) => DOWN_TAKES_OFF.has(kind))) return true;
  return tokens.includes("up") && ([...kinds].some((kind) => UP_LIFTS.has(kind)) || ROBES.test(text));
}

/** Whether a shape reads the clause, its own words held to the shape's needs. */
const reads = (shapes: readonly Shape[], said: string, plain: string): boolean =>
  shapes.some(({ shape, needs, unless }) => shape.test(said) && (needs === undefined || needs.test(plain)) && (unless === undefined || !unless.test(plain)));

/** Tags of what «it» or «them» may stand for: a part of her or something she holds, never what she wears. */
const ANTECEDENTS = new Set([FACE, HAND, FEET, LEGS, KNEE, HAIR, PROP, ACC, BREATH]);
/** Tags a clause names that keep «it» from reading at all: what she wears, a cover, her body. */
const NO_PRONOUN = /#(?:OUTER|TOP|LOWER|SKIRT|STRAP|SLEEVE|INNER|TOWEL|OUTFIT|PART|XWORN|COVER|BODYX|TRUNK)\b/;

/** Verbs that let go of what her hands held (the re-review's M2: «holds her robe closed and drops her hands»). */
const RELEASES = new Set(list("drops drop dropping lowers lower lowering relaxes relax relaxing releases release releasing lets let letting loosens loosen loosening"));
/** Verbs that move her arms with no object (the final touch's M-B: «holds her robe closed and stretches»). */
const ARM_MOVES = new Set(list("stretches stretch stretching reaches reach reaching waves wave waving raises raise raising lifts lift lifting spreads spread spreading"));
/** Verbs of a dressing form that hold what she wears closed or in place. */
const HOLDS = new Set(list("holds hold holding pulls pull pulling wraps wrap wrapping closes close closing tugs tug tugging keeps keep keeping"));
/** A pose of her body the grammar never reads (the re-review's M4 and LOW). */
const MIRROR = /\b(?:towards?|to|at|into|infrontof|facing) (?:the |her )?mirror\b/;
const POSE_VERBS = new Set(list("bends bend bending arches arch arching pushes push pushing sticks stick sticking presses press pressing"));
const LIFT_VERBS = new Set(list("lifts lift lifting raises raise raising"));

/** Whether a clause poses her body: toward the mirror bending, arching, pushing or lifting her hips or a leg, leaning forward; her arms squeezed together; her knees apart. */
function posesHer(plain: string, words: readonly string[], verbWord: string): boolean {
  if (MIRROR.test(plain)) {
    if (POSE_VERBS.has(verbWord)) return true;
    if (LIFT_VERBS.has(verbWord) && /\b(?:hips?|legs?|knees?|bottom|butt)\b/.test(plain)) return true;
    if (/^lean/.test(verbWord) && /\b(?:forward|over|down)\b/.test(plain)) return true;
  }
  if (/\b(?:press|squeez)\w*\s+(?:her\s+)?arms\b/.test(plain)) return true;
  // The final touch (M-D): a hand slid or run up her knee or her leg.
  if (/^(?:slid|run|brings?|bringing)/.test(verbWord) && words.some((word) => word === KNEE || word === LEGS) && /\b(?:higher|up|upward|upwards|further)\b/.test(plain)) return true;
  return words.some((word) => word === KNEE || word === LEGS) && /\b(?:out|aside|apart|wide|wider|open)\b|SIDETOSIDE/.test(plain);
}

/** A bare verb that moves her hand along her body when it follows a clause that moved her hand («brings her hand to her lips and lower»). */
const BARE_MOVES = new Set(list("lower lowers raise raises lift lifts slide slides drop drops move moves"));
/** Slipping, sliding, falling or dropping at her shoulder (only her hair may: «her hair slips over her shoulder»). */
const SLIPS_AT_SHOULDER = /\b(?:slip|slid|fall|fell|drop)\w*\b.*\bshoulders?\b/;
/** What she wore, lying at her feet or around her ankles (the final touch's LOW: «the towel at her feet»). */
const AT_HER_FEET = /\b(?:towels?|sheets?|robes?|dress(?:es)?|skirts?|tops?|clothes|bra|bikini|panties|shorts|jeans|outfit)\b[^,]{0,24}\b(?:at her feet|around her ankles)\b/;

/** Reads a motion text (see the module's comment). Pure. */
export function readMotion(text: string): MotionReading {
  const tokens = tokensOf(text);
  const plainText = tokens.join(" ");
  const bodyShown = tokens.filter((word, i) => BODY_SHOWN.has(word) && !(word === "bottom" && tokens[i + 1] === "of"));
  // An arched back with her hips, anywhere in the text (the re-review's E: «arches her back and lifts her hips»).
  // Her knees or legs named, then «them» or «it» moved aside, apart or open, whichever noun came last («lifts her knees over a book, lowering them aside»).
  const kneesApart = /\b(?:knees?|legs?)\b/.test(plainText) && /\b(?:them|it)\b/.test(plainText) && /\b(?:aside|apart|wide|wider|open|opening|out|spread\w*)\b/.test(plainText);
  const archHips = (/\barch\w*\b/.test(plainText) && /\bhips?\b/.test(plainText)) || kneesApart;
  const empty = { clauses: [], unread: [plainText], bodyShown, poses: archHips };
  if (tokens.length === 0 || tokens.length > 40 || tokens.some((word) => OTHER_OPENERS.has(word))) return { ok: false, undresses: namesUndressing(tokens, plainText, false), ...empty };
  // The breeze form reads the whole text at once («her hair and dress sway a little in the wind»).
  if (BREEZE.test(tagged(tokens, -1).join(" ")) && /\bin the (?:breeze|wind)\b/.test(plainText)) {
    return { ok: true, clauses: [{ text: plainText, route: "free" }], unread: [], undresses: false, bodyShown, poses: false };
  }
  const all = tagged(tokens, -1).join(" ");
  const pronounBarred = NO_PRONOUN.test(all);
  /** What «it» or «them» stands for: the last part of her or thing she holds a clause named. */
  let antecedent: string | null = null;
  let pronounAlone = false;
  let subject = "she";
  let subjectWords = "";
  /** A dressing form held what she wears closed or in place; a later clause moving her hands or her arms lets it go (the final touch's M-B). */
  let held = false;
  /** What the last clause moved: a bare «and lower» after it moves the same (along her body after her hand; off her after what she wears). */
  let lastObject: string | null = null;
  let released = false;
  let poses = archHips;
  const read: { text: string; route: ClauseRoute }[] = [];
  const unread: string[] = [];
  for (const { words: clause, joiner } of clausesOf(tokens)) {
    const plain = clause.join(" ");
    const first = clause[0] ?? "";
    // Who acts: «she»; a part of her or what she wears, first; a place, after a comma (an absolute tail); or the last clause's subject.
    let said: string;
    if (first === "she") {
      const v = clause.findIndex((word, k) => k > 0 && !ADVERBS.has(word));
      said = tagged(clause, v).join(" ");
      subject = "she";
    } else if (first === "her" || NOUNS.get(first) === "TRUNK") {
      said = tagged(clause, -1).join(" ");
      subject = said.split(" ")[0] ?? "";
      subjectWords = plain;
    } else if (DETERMINERS.has(first) && joiner === ",") {
      said = tagged(clause, -1).join(" ");
      subject = "other";
      const ok = ABSOLUTE.test(said);
      read.push({ text: plain, route: "free" });
      if (!ok) unread.push(plain);
      continue;
    } else {
      const v = clause.findIndex((word) => !ADVERBS.has(word));
      const rest = tagged(clause, v).join(" ");
      said = subject === "she" ? `she ${rest}` : `${subject} ${rest}`;
    }
    // «it» and «them» are what they stand for (the re-review's H2: «lifts her legs and spreads them» spreads her legs).
    if (said.split(" ").includes("#PRON")) {
      if (pronounBarred || antecedent === null) {
        if (antecedent === null) pronounAlone = true;
        read.push({ text: plain, route: "free" });
        unread.push(plain);
        continue;
      }
      said = said.split(" ").map((word) => (word === "#PRON" ? (antecedent ?? word) : word)).join(" ");
    }
    const words = said.split(" ");
    const verbWord = words.find((word, k) => k > 0 && word !== ADV) ?? "";
    const verb = FORM_OF.get(verbWord);
    // A clause that keeps the last one's subject reads its words too («her chest slowly rises and falls»).
    const own = first === "she" || first === "her" || NOUNS.get(first) === "TRUNK" || subject === "she" ? plain : `${subjectWords} ${plain}`;
    const kept = reads(DRESSING, said, own) || reads(COVERING, said, own) || reads(LAID_OUT, said, own);
    const generic = words[0] === "she" && verb !== undefined && (VERB_SHAPES.get(verb)?.test(said) ?? false);
    const ok = kept || generic || reads(POSTURE, said, own) || reads(SUBJECT_FORMS, said, own);
    const movesArms = words.slice(1).includes(HAND) || ARM_MOVES.has(verbWord) || (RELEASES.has(verbWord) && /\b(?:go|grip)\b/.test(plain));
    const letsGo = held && movesArms;
    const bare = words.filter((word) => word !== ADV).length === 2 && BARE_MOVES.has(verbWord);
    const slipsAtShoulder = words[0] === "she" && SLIPS_AT_SHOULDER.test(plain) && !words.includes(HAIR);
    // A bare verb after a clause that moved something moves it again: her hand along her body (content), what she wears off her (takes-off), else no motion it reads.
    const wornBefore = lastObject !== null && /^#(?:OUTER|TOP|LOWER|SKIRT|STRAP|SLEEVE|INNER|TOWEL|OUTFIT|PART|XWORN|COVER)$/.test(lastObject);
    if (bare && (held || wornBefore)) released = true;
    const posed = posesHer(plain, words, verbWord) || (bare && lastObject === HAND);
    const elided = bare && lastObject !== null;
    if (slipsAtShoulder) released = true;
    if (letsGo) released = true;
    if (posed) poses = true;
    if (!ok || letsGo || posed || slipsAtShoulder || elided) {
      read.push({ text: plain, route: "free" });
      unread.push(plain);
    } else {
      const holdsObject = words.slice(2).some((word) => word === ACC || word === PROP);
      read.push({ text: plain, route: kept ? "kept" : generic && holdsObject ? "held" : "free" });
    }
    if (kept && HOLDS.has(verbWord)) held = true;
    lastObject = words.slice(2).find((word) => word.startsWith("#")) ?? null;
    const named = words.filter((word, k) => k > 0 && ANTECEDENTS.has(word));
    if (named.length > 0) antecedent = named[named.length - 1] ?? antecedent;
  }
  // Each clause may read alone and the two still pose her: an arched back with her hips lifted; what she wore left at her feet.
  if (archHips && unread.length === 0) unread.push(plainText);
  if (AT_HER_FEET.test(plainText)) {
    released = true;
    if (unread.length === 0) unread.push(plainText);
  }
  if (unread.length === 0) return { ok: true, clauses: read, unread: [], undresses: false, bodyShown, poses: false };
  return { ok: false, clauses: read, unread, undresses: released || namesUndressing(tokens, plainText, pronounAlone), bodyShown, poses };
}
