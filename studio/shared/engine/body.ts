import { z } from "zod";

// Stage 5, S5.2a: the avatar's body traits. ONE schema (`AvatarBody`) whose keys are also keys of `AvatarTraits` (avatar.ts spreads its shape), and ONE function that
// renders them into the phrase that ends the descriptor in every prompt (`bodyPhrase`). The engine, the renderer's live preview and the mock all call this module, so
// the three can never word a body differently (I5.8). Pure: no I/O, no clock.

export const BodyHeight = z.enum(["short", "average", "tall"]);
export const BodyBust = z.enum(["small", "medium", "full"]);
export const BodyFigure = z.enum(["straight", "hourglass", "pear", "inverted-triangle", "apple"]);
export const LegLength = z.enum(["average", "long"]);
export const LegShape = z.enum(["slim", "toned"]);
export const BottomSize = z.enum(["small", "medium", "full"]);
export const BottomShape = z.enum(["round", "heart", "toned", "wide"]);
/** A tattoo or a mole on the body, from a fixed list. The side is fixed by code, so it never flips between photos. */
export const BodyMark = z.enum(["tattoo-ankle", "tattoo-hip", "tattoo-blade", "tattoo-ribs", "mole-collarbone", "mole-shoulder", "mole-back"]);
/** At most two body marks. */
export const BODY_MARKS_MAX = 2;

/** The eight optional body traits. «Телосложение» (`build`) is not here: it is the existing required trait and stays in the model-written text. */
export const AvatarBody = z.strictObject({
  height: BodyHeight.optional(),
  bust: BodyBust.optional(),
  figure: BodyFigure.optional(),
  legLength: LegLength.optional(),
  legShape: LegShape.optional(),
  bottomSize: BottomSize.optional(),
  bottomShape: BottomShape.optional(),
  bodyMarks: z
    .array(BodyMark)
    .max(BODY_MARKS_MAX)
    .refine((marks) => new Set(marks).size === marks.length, "body marks must not repeat")
    .optional(),
});
export type AvatarBody = z.infer<typeof AvatarBody>;

/** The body keys, in the order the phrase uses them. */
export const BODY_KEYS = ["height", "bust", "figure", "legLength", "legShape", "bottomSize", "bottomShape", "bodyMarks"] as const satisfies readonly (keyof AvatarBody)[];
export type BodyKey = (typeof BODY_KEYS)[number];

/**
 * The body a photo import read, waiting for the owner (S5.2b writes it; S5.2a stores, shows and clears it). `values` are the traits the vision call was sure of (a key it
 * could not see is left out), `seen` says per key whether the photo showed it, and `at` when it was read. Nothing here is a trait until the owner saves it with `avatars.setBody`.
 */
export const BodyProposalSeen = z.enum(["photo", "not-visible"]);
export const BodyProposal = z.strictObject({
  values: AvatarBody,
  seen: z.strictObject({
    height: BodyProposalSeen.optional(),
    bust: BodyProposalSeen.optional(),
    figure: BodyProposalSeen.optional(),
    legLength: BodyProposalSeen.optional(),
    legShape: BodyProposalSeen.optional(),
    bottomSize: BodyProposalSeen.optional(),
    bottomShape: BodyProposalSeen.optional(),
    bodyMarks: BodyProposalSeen.optional(),
  }),
  at: z.iso.datetime(),
}).refine((proposal) => bodyPhrase(proposal.values) !== undefined, {
  message: "an empty proposal is not stored: at least one body trait must be set",
  path: ["values"],
});
export type BodyProposal = z.infer<typeof BodyProposal>;

const HEIGHT: Record<z.infer<typeof BodyHeight>, string> = { short: "below-average height", average: "average height", tall: "tall" };
const BUST: Record<z.infer<typeof BodyBust>, string> = { small: "a small bust", medium: "a medium bust", full: "a full bust" };
const FIGURE: Record<z.infer<typeof BodyFigure>, string> = {
  straight: "a straight figure",
  hourglass: "an hourglass figure",
  pear: "a pear-shaped figure",
  "inverted-triangle": "an inverted-triangle figure with shoulders broader than her hips",
  apple: "an apple-shaped figure with a softer waist",
};
const LEG_LENGTH: Record<z.infer<typeof LegLength>, string> = { average: "average-length", long: "long" };
const LEG_SHAPE: Record<z.infer<typeof LegShape>, string> = { slim: "slim", toned: "toned" };
const BOTTOM_SIZE: Record<z.infer<typeof BottomSize>, string> = { small: "small", medium: "medium-sized", full: "full" };
const BOTTOM_SHAPE: Record<Exclude<z.infer<typeof BottomShape>, "wide">, string> = { round: "round", heart: "heart-shaped", toned: "toned" };
/** The side of a tattoo or a mole is fixed here, so a photo series never flips it. */
const MARK: Record<z.infer<typeof BodyMark>, string> = {
  "tattoo-ankle": "a small tattoo on her left ankle",
  "tattoo-hip": "a small tattoo on her right hip",
  "tattoo-blade": "a small tattoo on her left shoulder blade",
  "tattoo-ribs": "a small tattoo on her ribs",
  "mole-collarbone": "a small mole on her left collarbone",
  "mole-shoulder": "a small mole on her right shoulder",
  "mole-back": "a small mole on her lower back",
};

function legsPhrase(body: AvatarBody): string | undefined {
  const words = [body.legLength === undefined ? undefined : LEG_LENGTH[body.legLength], body.legShape === undefined ? undefined : LEG_SHAPE[body.legShape]].filter((w) => w !== undefined);
  return words.length === 0 ? undefined : `${words.join(" ")} legs`;
}

/** Size and shape as one phrase: «a small round bottom», «wide hips with a full bottom». «with», not «and»: the join's «and» stays the only one. */
function bottomPhrase(body: AvatarBody): string | undefined {
  const size = body.bottomSize === undefined ? undefined : BOTTOM_SIZE[body.bottomSize];
  if (body.bottomShape === "wide") return size === undefined ? "wide hips" : `wide hips with a ${size} bottom`;
  const shape = body.bottomShape === undefined ? undefined : BOTTOM_SHAPE[body.bottomShape];
  const words = [size, shape].filter((w) => w !== undefined);
  return words.length === 0 ? undefined : `a ${words.join(" ")} bottom`;
}

/**
 * The phrase that ends the descriptor in every prompt, written by code from the traits (never by the model): height, bust, figure, legs, bottom, then the body marks
 * (in the list's fixed order, whatever order they were picked in), joined by commas with «and» before the last. An unset slot adds nothing; undefined when nothing is
 * set. No item holds a comma, so the commas are always the joins.
 */
export function bodyPhrase(body: AvatarBody): string | undefined {
  const items = [
    body.height === undefined ? undefined : HEIGHT[body.height],
    body.bust === undefined ? undefined : BUST[body.bust],
    body.figure === undefined ? undefined : FIGURE[body.figure],
    legsPhrase(body),
    bottomPhrase(body),
    ...BodyMark.options.filter((mark) => body.bodyMarks?.includes(mark) === true).map((mark) => MARK[mark]),
  ].filter((item) => item !== undefined);
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The longest body phrase any combination renders to; a test builds the longest body and pins this to its real length. */
export const BODY_PHRASE_MAX = 249;

/**
 * The body keys of a stored traits record (`avatar.json`), or undefined for none. A key that does not parse drops the WHOLE body, never the avatar: a half body would be
 * a different woman.
 */
export function bodyFromRecord(record: Readonly<Record<string, unknown>>): AvatarBody | undefined {
  const picked: Record<string, unknown> = {};
  for (const key of BODY_KEYS) if (record[key] !== undefined) picked[key] = record[key];
  const parsed = AvatarBody.safeParse(picked);
  if (!parsed.success) return undefined;
  // «No marks» is an absent key, never an empty list (as `avatars.setBody` stores it).
  const { bodyMarks, ...rest } = parsed.data;
  const body: AvatarBody = bodyMarks === undefined || bodyMarks.length === 0 ? rest : { ...rest, bodyMarks };
  return bodyPhrase(body) === undefined ? undefined : body;
}
