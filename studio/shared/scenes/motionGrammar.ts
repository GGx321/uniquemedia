// Stage 5, 5b.2, S5.WC2b round 2 (the controller's decision after the adversarial review): the POSITIVE motion grammar. A model's text (a vision text on any frame, an own idea
// on an ordinary frame; motionText.ts decides the scope) is read against what a motion may say, and anything it cannot read is refused as no motion it knows (`not-motion`,
// which a repair may fix):
//
//   «she» + adverbs + ONE main verb + an object the verb may take + tails (degree, direction, a place), clause by clause («and», «as», «while», a comma);
//   a few subject-first forms («her hair stirs in the wind», «her raised feet swing slowly», «her chest rises a little», «her robe falls open»).
//
// The verbs and the objects are the bank's own: `BANK_VERBS` is every clause verb of the 271 bank motions and the 7 code motions (derived mechanically;
// motionGrammar.test.ts proves the list is exactly theirs and that every one of those motions reads), generalised by the class of what each verb moves (her face, her hands,
// her feet, a prop …), plus a curated extension (`CURATED_VERBS`). «it» and «them» read only where the text has named something they may stand for. A second object after
// «and» is a clause of its own, so it is read on its own.
//
// S5.WC2c (the owner, 2026-10-17: «убери ограничения везде»): the grammar reads a motion, never what it shows. What she wears is moved by the dressing forms (adjusts, smooths,
// tucks in, pulls … closed, zips up …) and by the undressing forms (takes off, unbuttons, slides … off her shoulder, pulls … over her head, lets … fall, slips out of, «her robe
// falls open»); her body is shown (bares, reveals, shows, uncovers), touched, stroked or posed like any other part of her. Each clause says how it was read
// (`MotionReading.clauses`), and a reading says whether one of its clauses undresses or bares her (`undresses`): the prompt then says «Nothing new appears.» alone. What stays a
// refusal is the grammar's own: a text that is not one motion of hers it can read. Pure: no clock, no I/O, nothing imported.

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

/** The curated extension: motions the bank does not happen to say (each with the objects it may take, below). S5.WC2c adds touching, undressing and baring. */
export const CURATED_VERBS = list(
  "nods shakes shrugs yawns sighs giggles grins winks waves opens parts spreads arches bends rubs touches plays fiddles holds puts places lays drops lies sits stands " +
    "poses waits spins snuggles props hugs wraps pushes does flashes adjusts straightens fixes removes slips grips hooks sets brings digs gets " +
    "caresses strokes cups grabs licks bites sucks kisses moans gasps masturbates undresses strips sticks spanks clutches releases picks drapes",
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
/** What she wears, by the way it may move: an outer layer, a top, what covers her legs, a skirt or a dress, a strap or a neckline, a sleeve, underwear or swimwear, a towel, her outfit, a fastening; and a garment by another name. */
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

const DETERMINERS = new Set(list("her the a an one both each some"));
const ADVERBS = new Set(list("slowly gently softly slightly lightly carefully calmly quietly lazily absently idly casually smoothly playfully shyly just still again"));
/** Words that only describe what follows («her raised feet», «a small sip», «her denim jacket», «her inner thigh»). */
const ADJECTIVES = new Set(
  list(
    "raised crossed lifted bent dangling small deep little half big soft warm gentle slight long light thin thick white black red blue green pink beige grey gray brown navy cream yellow purple orange " +
      "denim leather wool woollen woolen cotton linen knit knitted cozy cosy oversized favorite favourite summer winter rain picnic beach bath hotel morning evening fluffy fuzzy chunky " +
      "inner upper lower bare tube strapless crop off-shoulder low sheer",
  ),
);
/** What she wears on her feet: a garment word before it only names the kind («her dress shoes»). */
const FOOTWEAR = new Set(list("heels shoes sandals sneakers boots slippers flip-flops"));
/** A noun that names a part of what follows «of»: «a strand of hair» is her hair, «the top of her head» is her head. */
const PARTITIVES = new Set(list("strand strands lock locks piece bit edge corner end top shoulder shoulders"));
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

const PREPS = list("in on onto into to toward towards through along against behind at from over under across around above near beside by off with up down past below out between");
const DIRECTIONS = list("up down in out back away forward forwards off over around aside along on upward upwards downward downwards sideways across");
const DEGREES = list("more further higher lower closer deeper wider tight together again");
/** S5.WC2c: what she is when she stands, poses or turns as she is («she slowly poses nude», «she slowly turns, naked»). */
const STATES = list("naked nude topless bottomless undressed");
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
  [/\bon all fours\b/g, "ONALLFOURS"],
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
const TRUNK = "#TRUNK";
const BODYX = "#BODYX";
const BREATH = "#BREATH";
const PROP = "#PROP";
const ACC = "#ACC";
const PLACE = "#PLACE";
/** What she wears, any of it (and a cover she lies under), as one tag. */
const WORN_ANY = "#(?:OUTER|TOP|LOWER|SKIRT|STRAP|SLEEVE|INNER|TOWEL|OUTFIT|PART|XWORN|COVER)";
/** Herself, as the object of a touch («she slowly touches herself»). */
const HERSELF = "herself";
/** Her body below her face: what a hand may touch, stroke or rest on, and what she may show. */
const BODY = [LEGS, KNEE, HIPS, SHOULDER, BACK, TRUNK, BODYX, FEET, "#SIDE"] as const;

/** Each verb (third person) with the objects it may take; none: it takes no object (a place or a direction may still follow). `wear`: «in her dress» may follow. */
interface VerbRule {
  readonly objects: readonly string[];
  readonly wear?: true;
  readonly extra?: string;
}
const VERBS: ReadonlyMap<string, VerbRule> = new Map<string, VerbRule>([
  // the bank's own, each with the classes of what the bank moves with it (S5.WC2c: and her body where a hand or a part of her may act on it)
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
  ["lifts", { objects: [FEET, LEGS, KNEE, PROP, ACC, HIPS, HAND, FACE, HAIR, BODYX] }],
  ["looks", { objects: [] }],
  ["lowers", { objects: [HAND, FEET, LEGS, KNEE, PROP, ACC, FACE] }],
  ["pats", { objects: [FACE, HAIR] }],
  ["peeks", { objects: [] }],
  ["pins", { objects: [HAIR] }],
  ["points", { objects: [FEET, HAND] }],
  ["presses", { objects: [FEET, FACE, HAND, PROP, LEGS, KNEE, TRUNK, BODYX] }],
  ["pulls", { objects: [HAND, PROP, LEGS, KNEE, ACC] }],
  ["raises", { objects: [PROP, ACC, HAND, FACE, SHOULDER, LEGS, KNEE] }],
  ["reaches", { objects: [] }],
  ["relaxes", { objects: [SHOULDER, HAND, FACE], wear: true }],
  ["rests", { objects: [FACE, HAND, FEET], wear: true }],
  ["rises", { objects: [] }],
  ["rocks", { objects: [FEET, LEGS, KNEE, HIPS] }],
  ["rolls", { objects: [SHOULDER, FACE, HIPS] }],
  ["runs", { objects: [HAND] }],
  ["scrolls", { objects: [PROP] }],
  ["settles", { objects: [] }],
  ["shifts", { objects: [FEET, LEGS, KNEE, HIPS, SHOULDER, PROP] }],
  ["sinks", { objects: [] }],
  ["sips", { objects: [PROP] }],
  ["slides", { objects: [HAND, FEET, LEGS, KNEE, ACC] }],
  ["smiles", { objects: [], wear: true }],
  ["smooths", { objects: [HAIR] }],
  ["squeezes", { objects: [HAIR, HAND, LEGS, KNEE, TRUNK, BODYX] }],
  ["steps", { objects: [] }],
  ["stirs", { objects: [PROP] }],
  ["stretches", { objects: [HAND, FEET, LEGS, KNEE, FACE, BACK, BODYX] }],
  ["sways", { objects: [FEET, LEGS, KNEE, HIPS, BODYX], wear: true }],
  ["sweeps", { objects: [HAIR] }],
  ["swings", { objects: [FEET, LEGS, KNEE, PROP, HIPS] }],
  ["swirls", { objects: [FEET, PROP] }],
  ["takes", { objects: [BREATH, ACC] }],
  ["taps", { objects: [FEET, HAND, PROP, ACC] }],
  ["tightens", { objects: [HAIR] }],
  ["tilts", { objects: [FACE, FEET, PROP, ACC, HIPS] }],
  ["trails", { objects: [HAND] }],
  ["tucks", { objects: [HAIR, PROP, ACC] }],
  ["tugs", { objects: [ACC] }],
  ["turns", { objects: [FACE, HIPS, FEET, PROP, ACC], wear: true }],
  ["twirls", { objects: [PROP, HAIR], wear: true }],
  ["walks", { objects: [], wear: true }],
  ["watches", { objects: [PLACE], extra: "fade" }],
  ["wiggles", { objects: [FEET, HAND, HIPS, BODYX] }],
  ["zips", { objects: [PROP] }],
  // the curated extension
  ["nods", { objects: [] }],
  ["shakes", { objects: [FACE, HIPS, BODYX] }],
  ["shrugs", { objects: [SHOULDER] }],
  ["yawns", { objects: [] }],
  ["sighs", { objects: [] }],
  ["giggles", { objects: [] }],
  ["grins", { objects: [] }],
  ["winks", { objects: [] }],
  ["waves", { objects: [HAND] }],
  ["opens", { objects: [FACE, PROP, LEGS, KNEE, BODYX] }],
  ["parts", { objects: [FACE, LEGS, KNEE, BODYX] }],
  ["spreads", { objects: [HAND, LEGS, KNEE, BODYX] }],
  ["arches", { objects: [BACK, BODYX] }],
  ["bends", { objects: [LEGS, KNEE, FACE] }],
  ["rubs", { objects: [HAND, ...BODY, HERSELF] }],
  ["touches", { objects: [ACC, PROP, HAIR, FACE, HAND, ...BODY, HERSELF, WORN_ANY] }],
  ["plays", { objects: [] }],
  ["fiddles", { objects: [] }],
  ["holds", { objects: [PROP, ACC, HAND, LEGS, KNEE, WORN_ANY] }],
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
  ["pushes", { objects: [ACC, HAIR, LEGS, KNEE, HIPS, TRUNK, BODYX] }],
  ["does", { objects: [BREATH], wear: true }],
  ["flashes", { objects: [BREATH] }],
  ["adjusts", { objects: [ACC, HAIR] }],
  ["straightens", { objects: [ACC] }],
  ["fixes", { objects: [ACC, HAIR] }],
  ["removes", { objects: [ACC] }],
  ["slips", { objects: [ACC] }],
  ["grips", { objects: [PROP, ACC, WORN_ANY] }],
  ["hooks", { objects: [HAND] }],
  ["sets", { objects: [PROP, ACC] }],
  ["brings", { objects: [PROP, ACC, HAND], extra: `to ${FACE}` }],
  ["digs", { objects: [FEET, HAND] }],
  ["gets", { objects: [] }],
  // S5.WC2c: touching her body, her mouth, the sounds a motion makes, and undressing said with no object
  ["caresses", { objects: [HAIR, FACE, HAND, ...BODY, HERSELF] }],
  ["strokes", { objects: [HAIR, FACE, HAND, ...BODY, HERSELF] }],
  ["cups", { objects: [FACE, HAND, TRUNK, BODYX] }],
  ["grabs", { objects: [HAIR, HAND, PROP, ACC, LEGS, KNEE, HIPS, TRUNK, BODYX] }],
  ["licks", { objects: [FACE, HAND, PROP] }],
  ["bites", { objects: [FACE, HAND, PROP] }],
  ["sucks", { objects: [HAND, PROP] }],
  ["kisses", { objects: [HAND, PROP, ACC] }],
  ["moans", { objects: [] }],
  ["gasps", { objects: [] }],
  ["masturbates", { objects: [] }],
  ["undresses", { objects: [] }],
  ["strips", { objects: [] }],
  ["sticks", { objects: [HIPS, TRUNK, BODYX, LEGS] }],
  ["clutches", { objects: [PROP, ACC, HAND, WORN_ANY] }],
  ["picks", { objects: [PROP, ACC, "#OUTER", "#TOWEL", "#COVER"] }],
  ["drapes", { objects: [] }],
  ["releases", { objects: [PROP, ACC, HAND, WORN_ANY] }],
  ["spanks", { objects: [HIPS, BODYX] }],
]);

/** The base and the -ing form of a third-person verb («tucks» → tuck, tucking; «rises» → rise, rising; «lies» → lie, lying). */
function formsOf(verb: string): string[] {
  const irregular: Record<string, readonly string[]> = {
    lies: ["lie", "lying"],
    does: ["do", "doing"],
    undoes: ["undo", "undoing"],
    ties: ["tie", "tying"],
    unties: ["untie", "untying"],
    buries: ["bury", "burying"],
  };
  const known = irregular[verb];
  if (known !== undefined) return [verb, ...known];
  const base = /(?:ch|sh|ss|x)es$/.test(verb) ? verb.slice(0, -2) : verb.slice(0, -1);
  const doubled = new Set(list("dip pat pin tug sip tap step nod shrug hug rub prop pop drop spin sit grip slip flip wrap swim skip let strip shed unzip unwrap cup grab"));
  const ing = doubled.has(base) ? `${base}${base.slice(-1)}ing` : /[^e]e$/.test(base) ? `${base.slice(0, -1)}ing` : `${base}ing`;
  return [verb, base, ing];
}
/** Every form of every verb, back to its third person. */
const FORM_OF: ReadonlyMap<string, string> = new Map([...VERBS.keys()].flatMap((verb) => formsOf(verb).map((form): [string, string] => [form, verb])));

// ---------- the clause shapes ----------

const alt = (items: readonly string[]): string => `(?:${items.join("|")})`;
const ADV = "ADV";
const MANNER = alt([ADV, "a little", "a bit", "a touch"]);
/** A noun a preposition may lead to: a place, a prop, or any part of her (S5.WC2c: her body too). */
const PP_OBJECT = alt([PLACE, PROP, ACC, FACE, HAND, FEET, HAIR, ...BODY, "#OTHER", "#SPOT", "her"]);
/**
 * What she wears after a preposition that leaves it on her («her hand on her skirt», «under her robe», «over her dress»). Never off, from, out of, up or down it: a generic verb
 * there («kicks off her towel», «pushes off the sheet», «pulls out the laces of her top») takes it off, and only an undressing form reads that.
 */
const WORN_PP = `${alt(list("in on onto over under into inside against across along through at with beside near above below behind toward towards to around"))} ${WORN_ANY}`;
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
  "ONALLFOURS",
  `${alt(PREPS)} ${PP_OBJECT}`,
  WORN_PP,
  `infrontof ${PP_OBJECT}`,
]);
const tail = (more: readonly string[] = []): string => `(?: ${alt([TAIL_ITEM, ...more])})*`;
/** The tail of what she wears kept on: the manner and the shape's own words alone (never a direction, a degree or a place that would move it: «a little lower», «off her shoulder»). */
const keptTail = (more: readonly string[] = []): string => `(?: ${alt([MANNER, ...more])})*`;
const forms = (verbs: readonly string[]): string => alt(verbs.flatMap(formsOf));
/** What she wears, as the dressing forms read it. */
const WORN = "#(?:OUTER|TOP|LOWER|SKIRT|STRAP|SLEEVE|INNER|TOWEL|OUTFIT|PART|XWORN)";
const WEAR_PP = `in ${WORN}`;

/** The generic shape of a verb: «she», adverbs, the verb, a particle, an object it may take, the tail (and «in her dress», «nude» for a verb she may do in it). */
function verbShape(verb: string, rule: VerbRule): RegExp {
  const objects = rule.objects.length === 0 ? "" : `(?: ${alt([...rule.objects, "#PRON"])})?`;
  const more = [...(rule.wear === true ? [WEAR_PP, alt(STATES)] : []), ...(rule.extra === undefined ? [] : [rule.extra])];
  return new RegExp(`^she(?: ${ADV})* ${forms([verb])}(?: ${alt(DIRECTIONS)})?(?: ${ADV})*${objects}${tail(more)}$`);
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

/** The dressing forms: what she wears, moved to keep it on or put it on. */
const DRESSING: readonly Shape[] = [
  // adjusts, straightens, fixes, smooths it (in the mirror; a strap back on her shoulder; a skirt or a dress over her knees; smoothed down).
  { shape: kept("adjusts straightens fixes", WORN, ["in #PLACE", `infrontof #PLACE`, `(?:back )?(?:on|onto|over) ${SHOULDER}`]) },
  { shape: kept("smooths", `(?:out )?(?:${WORN}|#COVER)`, ["out", "in #PLACE", `infrontof #PLACE`, `over ${KNEE}`, `${alt(list("over along across"))} #(?:BODYX|TRUNK|HIPS|LEGS|KNEE)`]) },
  // smoothed down: only what down covers (a skirt, a hem, a top, her outfit, a sheet).
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
    unless: /\bdress(?:es)?\b(?!.*\bover (?:her )?knees\b)/,
  },
  // pulls, tugs, holds or wraps an outer layer closed, closer, tighter or around her; closes it.
  { shape: kept("pulls tugs holds wraps", "#OUTER", ["closed", "shut", "tighter", "closer", "around her", `around her ${SHOULDER}`, `over ${SHOULDER}`]), needs: /\b(?:closed|shut|tighter|closer|around|over)\b/ },
  { shape: kept("closes", "#OUTER") },
  // S5.WC2c: a sweater or a hoodie pulled down covers her midriff (never a robe or a jacket, which down comes off her shoulders).
  { shape: kept("pulls tugs", "(?:down )?#OUTER", ["down"]), needs: /^(?=.*\bdown\b)(?=.*\b(?:sweaters?|jumpers?|hoodies?|sweatshirts?|pullovers?)\b)/, unless: /\b(?:robes?|bathrobes?|kimonos?|jackets?|coats?|blazers?|cardigans?|shawls?|parkas?|ponchos?)\b/ },
  // puts on, slips on or into, pulls on an outer layer.
  { shape: kept("puts slips pulls", "(?:on )?#OUTER", ["on"]), needs: /\bon\b/ },
  { shape: kept("slips", "into #OUTER") },
  // zips or buttons it (up).
  { shape: kept("zips buttons fastens", "(?:up )?#(?:OUTER|TOP|SKIRT|OUTFIT)", ["up"]) },
  // S5.WC2c: wraps, ties or belts it tighter or around her; wraps herself in it; drapes an outer layer or a cover over or around her (never around her waist or over a chair).
  { shape: kept("wraps ties belts", WORN, ["tighter", "closer", "closed", "shut", "around her", `around her ${SHOULDER}`]) },
  // (A cover after «in» reads as a place: «wraps herself in the blanket».)
  { shape: kept("wraps", `herself(?: ${alt(["tighter", "closer"])})? in (?:${WORN}|#COVER|#PLACE)`), needs: /\b(?:blankets?|sheets?|duvets?|quilts?|towels?|robes?|bathrobes?|kimonos?|coats?|jackets?|cardigans?|shawls?|hoodies?|sweaters?)\b/ },
  { shape: kept("drapes", `#(?:OUTER|TOWEL|COVER)`, [`${alt(list("over around across"))} (?:her|${SHOULDER}|#(?:BODYX|LEGS|KNEE|SPOT))`]), needs: /\b(?:over|around|across) her\b/ },
  // the bank's own: lets the strap settle on her shoulder; tugs the coat closer and the waistband up; slides the strap up.
  { shape: kept("lets", "#STRAP settles?", [`(?:back )?(?:on|onto) ${SHOULDER}`]) },
];

/** What she lies under: pulled up, closer or over her; smoothed; snuggled under (a place then). */
const COVERING: readonly Shape[] = [
  {
    shape: kept("pulls tugs draws", "(?:up )?#(?:COVER|TOWEL)", ["up", "higher", "closer", "over her", `over ${SHOULDER}`, `(?:up )?to #(?:FACE|TRUNK|SHOULDER)`]),
    needs: /\b(?:up|higher|closer|over)\b/,
    // S5.WC2c: a towel pulled up covers her only up to her chest or her shoulders («pulls the towel up a little» may bare her legs).
    unless: /\btowels?\b(?!.*\bto (?:her )?(?:chest|shoulders?|chin|neck)\b)/,
  },
  { shape: kept("tucks", "#COVER", ["in", "around her"]) },
];

/** A towel or a blanket she lays out or picks up off the sand (a prop there, never what she wears). */
const LAID_OUT: readonly Shape[] = [
  { shape: kept("lifts spreads lays shakes", "#(?:TOWEL|COVER)", [`${alt(["off", "on", "onto", "from", "across"])} #PLACE`]), needs: /\b(?:off|on|onto|from|across) the (?:sand|grass|lounger|beach|ground)\b/ },
];

/** Her body at rest: lying or rolling onto her stomach, her back or her side; her chest rising and falling; a hand on her stomach; her arms over her chest; her knees hugged to it. */
const POSTURE: readonly Shape[] = [
  { shape: she("lies rests stays", `(?:(?:back|down|flat) )?(?:FACEDOWN )?(?:on|onto) #(?:TRUNK|BACK|SIDE)`, ["with #FEET up"]) },
  { shape: she("lies rests stays", "FACEDOWN") },
  { shape: she("rolls turns flips", "(?:(?:over|back) )?(?:onto|on) #(?:TRUNK|BACK|SIDE)") },
  { shape: she("crosses folds wraps", `${HAND} (?:over|across|around) #(?:TRUNK|BODYX)`) },
  { shape: she("hugs pulls draws", `${KNEE}(?: up)? (?:to|against|into) #(?:TRUNK|BODYX)`) },
  { shape: she("rests places lays puts keeps", `${HAND} (?:on|over) #(?:TRUNK|BODYX)`) },
  { shape: she("props", "herself up", [`on ${HAND}`]) },
  { shape: she("keeps", alt(list("jogging walking smiling swaying turning laughing rocking breathing stretching"))) },
  { shape: she("brushes", `${PLACE} (?:off|from) (?:#(?:FEET|LEGS|KNEE|HAND|HAIR|FACE|BODYX|TRUNK)|${WORN_ANY})`), needs: /\b(?:sand|dust|water|grass|snow|leaves|petals)\b/ },
];

/** A clause whose subject is a part of her, with what it may do. */
const SUBJECT_FORMS: readonly Shape[] = [
  { shape: new RegExp(`^${HAIR}(?: ${ADV})* ${alt(list("lifts lift stirs stir sways sway flutters flutter ripples ripple billows billow moves move falls fall blows blow slips slip swaying fluttering"))}${tail([`(?:off|from) ${SHOULDER}`])}$`) },
  { shape: new RegExp(`^${FEET}(?: ${ADV})* ${alt(list("swing swings sway sways kick kicks bounce bounces swinging swaying"))}${tail()}$`) },
  { shape: new RegExp(`^${SHOULDER}(?: ${ADV})* ${alt(list("rise rises fall falls relax relaxes drop drops rising falling"))}${tail()}$`) },
  { shape: new RegExp(`^${TRUNK}(?: ${ADV})* ${alt(list("rises rise rising falls fall falling heaves heave heaving"))}${tail()}$`), needs: /\bchest\b/ },
];
/** The curated breeze form, read on the whole text: «her hair and dress sway a little in the wind», «her skirt flutters in the breeze». */
const BREEZE = new RegExp(
  `^#(?:HAIR|SKIRT)(?: and (?:her )?#(?:HAIR|SKIRT))?(?: ${ADV})* ${alt(list("sways sway flutters flutter ripples ripple"))}(?: ${MANNER})* in #PLACE(?: ${MANNER})*$|^${HAIR}(?: ${ADV})* ${alt(list("billows billow"))}(?: ${MANNER})* in #PLACE(?: ${MANNER})*$`,
);
/** An absolute tail after a comma: «the water at her feet»; S5.WC2c: what she is, «naked». */
const ABSOLUTE = new RegExp(`^${PLACE}(?: ${alt(PREPS)} ${PP_OBJECT})?(?: ${MANNER})*$`);
const STATE_ABSOLUTE = new RegExp(`^(?:(?:completely|fully|almost) )?${alt(STATES)}$`);

// ---------- S5.WC2c: undressing and baring her ----------

/** The verbs that take what she wears off, open it, loosen it, lift or lower it. */
const UNDRESS_VERBS = list(
  "takes pulls slips slides peels shrugs strips removes unbuttons unzips unties undoes unhooks unclasps unfastens unwraps unlaces unbelts loosens lowers lifts raises drops sheds " +
    "opens parts spreads eases pushes rolls draws hikes hitches inches tugs works gathers bunches flips kicks wriggles nudges hooks releases unwinds undrapes hoists brushes",
);
/** A particle or a word that says where it goes: off her, open, loose. */
const UNDRESS_PARTICLES = alt(["off", "down", "up", "away", "open", "aside", "apart", "back", "over", "out", "loose", "undone", "free"]);
/** What may follow the undressing: the generic tail, off or down her shoulder, the particles. */
const undressTail = (more: readonly string[] = []): string => tail([UNDRESS_PARTICLES, `(?:off|from|down|past|over) ${SHOULDER}`, ...more]);
/** What she shows: her body, what she wears, herself, more of it. */
const SHOWN = alt([...BODY, WORN_ANY, HERSELF, "more", "everything"]);

const UNDRESSING: readonly Shape[] = [
  // «she slowly takes off her robe», «she unbuttons her shirt», «she slides her strap off her shoulder», «she pulls her top over her head», «she lowers her bikini top a little».
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(UNDRESS_VERBS)}(?: ${UNDRESS_PARTICLES})?(?: ${ADV})* ${WORN_ANY}${undressTail()}$`) },
  // «she lets her dress fall to the floor», «she lets the strap slip off her shoulder», «she lets her robe fall open».
  {
    shape: new RegExp(
      `^she(?: ${ADV})* ${forms(["lets"])}(?: ${ADV})* ${WORN_ANY}(?: ${ADV})* ${alt(list("fall drop slip slide open part loosen hang go settle"))}${undressTail()}$`,
    ),
  },
  // «she slips out of her dress», «she steps out of her skirt», «she slips from her towel», «she pulls away from her towel», «she rolls out from the sheets».
  {
    shape: new RegExp(
      `^she(?: ${ADV})* ${forms(list("slips steps wriggles gets climbs shimmies wiggles slides pulls rolls"))}(?: ${alt(["out", "away", "free"])})?(?: ${ADV})* (?:of|from) ${WORN_ANY}${undressTail()}$`,
    ),
  },
  // «she holds her robe open», «she keeps her towel apart», «she holds her top up» (never «keeps her dress down in the breeze», which holds it on); «she puts her robe aside»,
  // «she sets her bra down»; «she zips her hoodie down a little».
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(list("holds keeps grips"))}(?: ${ADV})* ${WORN_ANY}(?: ${ADV})* ${alt(["open", "apart", "aside", "up", "off", "away", "loose"])}${undressTail()}$`) },
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(list("puts sets"))}(?: ${ADV})* ${WORN_ANY}(?: ${ADV})* ${alt(["aside", "down", "away", "off"])}${undressTail()}$`) },
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(["zips"])}(?: ${ADV})* ${WORN_ANY}(?: ${ADV})* ${alt(["down", "open"])}${undressTail()}$`) },
  // What she wears said with «she» as its subject: «she slowly adjusts her robe, slipping off her shoulders» (only her hair slips off her shoulder otherwise).
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(list("slips slides falls drops"))}(?: ${ADV})* (?:off|down|from) ${SHOULDER}${undressTail()}$`) },
  // «she ties her jacket around her waist», «she wraps her towel around her hips», «she drapes her robe over the chair», «she ties her shirt in a knot», «she picks up her
  // skirt a little».
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(list("ties wraps drapes"))}(?: ${ADV})* ${WORN_ANY}(?: ${ADV})* (?:around #(?:BODYX|HIPS)|over #PLACE|in a knot)${undressTail()}$`) },
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(["picks"])} up(?: ${ADV})* #(?:SKIRT|TOP|INNER|LOWER|XWORN)${undressTail()}$`) },
  // «she lets go of her towel», «she lets go».
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(["lets"])} go(?: of ${WORN_ANY})?${undressTail()}$`) },
  // A dressing verb said to undress her: «she adjusts her top a little lower», «she smooths her dress up her thighs», «she wraps her towel a little looser», «she ties her
  // shirt above her navel», «she tucks her top up a little».
  {
    shape: new RegExp(
      `^she(?: ${ADV})* ${forms(list("adjusts smooths straightens fixes buttons fastens wraps ties tucks tugs settles"))}(?: ${UNDRESS_PARTICLES})?(?: ${ADV})* ${WORN_ANY}${undressTail([alt(["looser", "lower", "higher"])])}$`,
    ),
    needs: /\b(?:lower|higher|looser|open|off|up|down|aside|apart|loose|above|into|under|at)\b/,
  },
  // Her body shown by itself: «she lets her chest show», «she lets her cleavage peek out».
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(["lets"])}(?: ${ADV})* ${alt([...BODY])}(?: ${ADV})* ${alt(list("show peek"))}${undressTail()}$`) },
  // «she slowly undresses», «she strips down».
  { shape: new RegExp(`^she(?: ${ADV})* ${forms(list("undresses strips"))}(?: ${alt(["down", "off", "naked", "bare"])})?${undressTail()}$`) },
  // «she bares her shoulder», «she reveals her cleavage», «she shows off her stomach», «she uncovers her chest».
  {
    shape: new RegExp(
      `^she(?: ${ADV})* ${forms(list("bares reveals shows exposes uncovers displays flaunts flashes"))}(?: off)?(?: ${ADV})* (?:(?:a little|a bit) )?${SHOWN}${undressTail()}$`,
    ),
  },
];
/** What she wears doing it itself: «her robe falls open», «her strap slips off her shoulder», «her top rides up a little», «her dress settles around her ankles». */
const WORN_SUBJECT = new RegExp(
  `^${WORN_ANY}(?: ${ADV})* ${forms(list("falls slips slides drops opens parts loosens rides creeps hangs gapes comes lifts rises shifts moves settles"))}${undressTail()}$`,
);
/** What she wears only moving with her: «her dress sways a little», «her shirt ripples in the breeze», «her skirt swishes as she walks». */
const WORN_MOVES = new RegExp(`^${WORN_ANY}(?: ${ADV})* ${forms(list("sways ripples flutters billows swirls swishes flows rustles"))}${tail()}$`);

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
  if (word === "back") return prev === "her" || (ADJECTIVES.has(prev) && tokens[i - 2] === "her") ? "BACK" : null;
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
    // Never bedding she lies under (getting off or out from the sheets leaves it), never after «out» («steps out from the towel» leaves it on the floor).
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
  // A prop or an accessory word that names part of what she wears («her bra cup», «the clip of her bra», «the laces of her dress», «the hood of her robe») is that garment's
  // part, never a held thing; her shoes stay her shoes («her dress shoes»).
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

/**
 * How a clause was read: by a dressing form (dressing, covering, laid out), by a verb whose object is an accessory or something she holds, by an undressing or baring form
 * (S5.WC2c), or by any other form («free», also for a clause it cannot read).
 */
export type ClauseRoute = "kept" | "held" | "undress" | "free";

/** What a reading found besides yes or no: how each clause was read, and what it cannot read. */
export interface MotionReading {
  /** Every clause reads. */
  readonly ok: boolean;
  /** Each clause as written, with how it was read («free» for one it cannot read). */
  readonly clauses: readonly { readonly text: string; readonly route: ClauseRoute }[];
  /** The clauses it cannot read, as written. */
  readonly unread: readonly string[];
  /** It reads, and one of its clauses undresses or bares her (an undressing or baring form): the prompt says «Nothing new appears.» alone (S5.WC2c). */
  readonly undresses: boolean;
}

/** Whether a shape reads the clause, its own words held to the shape's needs. */
const reads = (shapes: readonly Shape[], said: string, plain: string): boolean =>
  shapes.some(({ shape, needs, unless }) => shape.test(said) && (needs === undefined || needs.test(plain)) && (unless === undefined || !unless.test(plain)));

/** Tags of what «it» or «them» may stand for: a part of her, something she holds, what she wears or lies under (S5.WC2c: «unties her robe and lets it fall»). */
const ANTECEDENTS = new Set([FACE, HAND, FEET, LEGS, KNEE, HAIR, PROP, ACC, BREATH, HIPS, SHOULDER, BACK, TRUNK, BODYX, ...WORN_CLASSES.map((cls) => `#${cls}`), "#COVER"]);

/** Verbs that hold what she wears closed or in place. */
const HOLDS = new Set(list("holds hold holding pulls pull pulling wraps wrap wrapping closes close closing tugs tug tugging keeps keep keeping grips grip gripping clutches clutch clutching"));
/** One tag of what she wears or lies under. */
const WORN_TAG = new RegExp(`^${WORN_ANY}$`);
/** Verbs that move her arms with no object, or let go of what her hands held («holds her robe closed and drops her hands», «… and stretches»). */
const ARM_MOVES = new Set(list("stretches stretch stretching reaches reach reaching waves wave waving raises raise raising lifts lift lifting spreads spread spreading"));
const RELEASES = new Set(list("drops drop dropping lowers lower lowering relaxes relax relaxing releases release releasing lets let letting loosens loosen loosening"));

/** Reads a motion text (see the module's comment). Pure. */
export function readMotion(text: string): MotionReading {
  const tokens = tokensOf(text);
  const plainText = tokens.join(" ");
  const refused = (clauses: MotionReading["clauses"], unread: readonly string[]): MotionReading => ({ ok: false, clauses, unread, undresses: false });
  if (tokens.length === 0 || tokens.length > 40 || tokens.some((word) => OTHER_OPENERS.has(word))) return refused([], [plainText]);
  // The breeze form reads the whole text at once («her hair and dress sway a little in the wind»).
  if (BREEZE.test(tagged(tokens, -1).join(" ")) && /\bin the (?:breeze|wind)\b/.test(plainText)) {
    return { ok: true, clauses: [{ text: plainText, route: "free" }], unread: [], undresses: false };
  }
  /** What «it» or «them» stands for: the last part of her, thing she holds or garment a clause named. */
  let antecedent: string | null = null;
  let subject = "she";
  let subjectWords = "";
  /** A dressing form held what she wears closed or in place: a later clause moving her hands or her arms lets it go, and so undresses her (the re-review's M2, M-B). */
  let held = false;
  const read: { text: string; route: ClauseRoute }[] = [];
  const unread: string[] = [];
  for (const { words: clause, joiner } of clausesOf(tokens)) {
    const plain = clause.join(" ");
    const first = clause[0] ?? "";
    // What she is, after a comma: «she slowly turns, naked».
    if (joiner === "," && STATE_ABSOLUTE.test(plain)) {
      read.push({ text: plain, route: "free" });
      continue;
    }
    // Who acts: «she»; a part of her or what she wears, first («her robe falls open», «and the strap slips off her shoulder»); a place, after a comma (an absolute tail); or
    // the last clause's subject.
    let said: string;
    if (first === "she") {
      const v = clause.findIndex((word, k) => k > 0 && !ADVERBS.has(word));
      said = tagged(clause, v).join(" ");
      subject = "she";
    } else if (first === "her" || NOUNS.get(first) === "TRUNK" || (DETERMINERS.has(first) && joiner !== "," && joiner !== "")) {
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
      if (antecedent === null) {
        read.push({ text: plain, route: "free" });
        unread.push(plain);
        continue;
      }
      said = said.split(" ").map((word) => (word === "#PRON" ? (antecedent ?? word) : word)).join(" ");
    }
    // Her hands or her fingers as the subject act as she does: «her hands slowly smooth her skirt», «her fingers slowly adjust her strap».
    if (said.startsWith(`${HAND} `) && FORM_OF.has(said.split(" ").find((word, k) => k > 0 && word !== ADV) ?? "")) said = `she ${said.slice(HAND.length + 1)}`;
    const words = said.split(" ");
    const verbWord = words.find((word, k) => k > 0 && word !== ADV) ?? "";
    const verb = FORM_OF.get(verbWord);
    // A clause that keeps the last one's subject reads its words too («her chest slowly rises and falls»).
    const own = first === "she" || first === "her" || NOUNS.get(first) === "TRUNK" || subject === "she" ? plain : `${subjectWords} ${plain}`;
    const keptOn = reads(DRESSING, said, own) || reads(COVERING, said, own) || reads(LAID_OUT, said, own);
    // Undressing and baring read where no dressing form does, before the generic forms (whose objects and tails took nothing she wears before S5.WC2c, so a clause read
    // before is read as it was): «she holds her top up» undresses her, «she holds her top to her chest» is a generic hold.
    const undress = !keptOn && (reads(UNDRESSING, said, own) || WORN_SUBJECT.test(said));
    const generic = !undress && words[0] === "she" && verb !== undefined && (VERB_SHAPES.get(verb)?.test(said) ?? false);
    const other = !undress && (reads(POSTURE, said, own) || reads(SUBJECT_FORMS, said, own) || WORN_MOVES.test(said));
    if (!(keptOn || generic || other || undress)) {
      read.push({ text: plain, route: "free" });
      unread.push(plain);
    } else {
      const holdsObject = words.slice(2).some((word) => word === ACC || word === PROP);
      // Her hands moved, or her arms with nothing else named («… and stretches», «… and lowers»; never «… and lifts her chin»).
      const armsAlone = (ARM_MOVES.has(verbWord) || RELEASES.has(verbWord)) && !words.slice(2).some((word) => word.startsWith("#"));
      const letsGo = held && !keptOn && (words.slice(1).includes(HAND) || armsAlone);
      read.push({ text: plain, route: keptOn ? "kept" : undress || letsGo ? "undress" : generic && holdsObject ? "held" : "free" });
    }
    if (HOLDS.has(verbWord) && words.slice(2).some((word) => WORN_TAG.test(word))) held = true;
    const named = words.filter((word, k) => (k > 0 || word.startsWith("#")) && ANTECEDENTS.has(word));
    if (named.length > 0) antecedent = named[named.length - 1] ?? antecedent;
  }
  if (unread.length > 0) return refused(read, unread);
  return { ok: true, clauses: read, unread: [], undresses: read.some((clause) => clause.route === "undress") };
}
