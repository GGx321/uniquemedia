import {
  type AvatarBody,
  BodyFigure,
  BodyHeight,
  BodyBust,
  BodyMark,
  BODY_KEYS,
  BottomShape,
  BottomSize,
  type BodyProposal,
  bodyFromRecord,
  bodyPhrase,
  DESCRIPTOR_MAX_CHARS,
  LegLength,
  LegShape,
} from "../../shared/engine";
import type { Choice, Traits } from "./traits";

// Stage 5, S5.2d: the body traits as the window shows them — the Russian labels of the fixed choices (in the mockup's order, each list checked
// against its enum in the tests), the «Тело N / 6» count, «Случайно», the summary on «Внешность», and where an import's proposal came from. The
// English phrase is never written here: `bodyPhrase` (shared/engine/body.ts) is the one writer, for the engine, the mock and this window alike.

type Height = NonNullable<AvatarBody["height"]>;
type Bust = NonNullable<AvatarBody["bust"]>;
type Figure = NonNullable<AvatarBody["figure"]>;
type LegLengthValue = NonNullable<AvatarBody["legLength"]>;
type LegShapeValue = NonNullable<AvatarBody["legShape"]>;
type BottomSizeValue = NonNullable<AvatarBody["bottomSize"]>;
type BottomShapeValue = NonNullable<AvatarBody["bottomShape"]>;
type Mark = NonNullable<AvatarBody["bodyMarks"]>[number];

export const HEIGHTS: readonly Choice<Height>[] = [
  { value: "short", label: "Невысокий" },
  { value: "average", label: "Средний" },
  { value: "tall", label: "Высокий" },
];

export const BUSTS: readonly Choice<Bust>[] = [
  { value: "small", label: "Небольшая" },
  { value: "medium", label: "Средняя" },
  { value: "full", label: "Большая" },
];

export const FIGURES: readonly Choice<Figure>[] = [
  { value: "straight", label: "Прямая" },
  { value: "hourglass", label: "Песочные часы" },
  { value: "pear", label: "Груша" },
  { value: "inverted-triangle", label: "Перевёрнутый треугольник" },
  { value: "apple", label: "Яблоко" },
];

export const LEG_LENGTHS: readonly Choice<LegLengthValue>[] = [
  { value: "average", label: "Средние" },
  { value: "long", label: "Длинные" },
];

export const LEG_SHAPES: readonly Choice<LegShapeValue>[] = [
  { value: "slim", label: "Стройные" },
  { value: "toned", label: "Подтянутые" },
];

export const BOTTOM_SIZES: readonly Choice<BottomSizeValue>[] = [
  { value: "small", label: "Небольшая" },
  { value: "medium", label: "Средняя" },
  { value: "full", label: "Большая" },
];

export const BOTTOM_SHAPES: readonly Choice<BottomShapeValue>[] = [
  { value: "round", label: "Округлая" },
  { value: "heart", label: "Сердечком" },
  { value: "toned", label: "Подтянутая" },
  { value: "wide", label: "Широкая" },
];

/** A body mark: its row («Тату» or «Родинка»), the place as the chip says it, and its full name for a screen reader and the summary. */
export interface MarkChoice {
  readonly value: Mark;
  readonly row: "tattoo" | "mole";
  readonly place: string;
  readonly label: string;
}

export const BODY_MARKS: readonly MarkChoice[] = [
  { value: "tattoo-ankle", row: "tattoo", place: "щиколотка", label: "Тату на щиколотке" },
  { value: "tattoo-hip", row: "tattoo", place: "бедро", label: "Тату на бедре" },
  { value: "tattoo-blade", row: "tattoo", place: "лопатка", label: "Тату на лопатке" },
  { value: "tattoo-ribs", row: "tattoo", place: "рёбра", label: "Тату на рёбрах" },
  { value: "mole-collarbone", row: "mole", place: "ключица", label: "Родинка на ключице" },
  { value: "mole-shoulder", row: "mole", place: "плечо", label: "Родинка на плече" },
  { value: "mole-back", row: "mole", place: "поясница", label: "Родинка на пояснице" },
];

/** The enums the body's choice lists must cover, for the coverage test. */
export const BODY_ENUMS = {
  height: BodyHeight.options,
  bust: BodyBust.options,
  figure: BodyFigure.options,
  legLength: LegLength.options,
  legShape: LegShape.options,
  bottomSize: BottomSize.options,
  bottomShape: BottomShape.options,
  bodyMarks: BodyMark.options,
};

/** The six fields «Тело N / 6» counts: «Ноги» and «Попа» are one field of two parts each, «Тату и родинки» one field of up to two marks. */
export type BodyField = "height" | "bust" | "figure" | "legs" | "bottom" | "marks";
export const BODY_FIELDS: readonly BodyField[] = ["height", "bust", "figure", "legs", "bottom", "marks"];

export const FIELD_LABEL: Record<BodyField, string> = {
  height: "Рост",
  bust: "Грудь",
  figure: "Фигура",
  legs: "Ноги",
  bottom: "Попа",
  marks: "Тату и родинки на теле",
};

/** The same names as the object of a sentence («…на фото не видно»). */
const FIELD_ACCUSATIVE: Record<BodyField, string> = {
  height: "рост",
  bust: "грудь",
  figure: "фигуру",
  legs: "ноги",
  bottom: "попу",
  // «или»: in a list joined by «и» («…, попу и тату или родинки») a second «и» would read as two items.
  marks: "тату или родинки",
};

/** The stored keys each field is made of. */
const FIELD_KEYS: Record<BodyField, readonly (keyof AvatarBody)[]> = {
  height: ["height"],
  bust: ["bust"],
  figure: ["figure"],
  legs: ["legLength", "legShape"],
  bottom: ["bottomSize", "bottomShape"],
  marks: ["bodyMarks"],
};

/** A field counts as set when any of its parts is chosen; an empty list of marks is not a choice. */
export function fieldSet(body: AvatarBody, field: BodyField): boolean {
  return FIELD_KEYS[field].some((key) => {
    const value = body[key];
    return Array.isArray(value) ? value.length > 0 : value !== undefined;
  });
}

/** «Тело N / 6»: how many of the six fields are set. */
export function bodySetCount(body: AvatarBody): number {
  return BODY_FIELDS.filter((field) => fieldSet(body, field)).length;
}

/** The body the traits hold (the wizard keeps it inside its traits, as `avatars.createDraft` takes it); empty when none is set. */
export function bodyOfTraits(traits: Traits): AvatarBody {
  return bodyFromRecord(traits) ?? {};
}

/** The traits with their body replaced by `body`: every body key goes, then the set ones come back. «No marks» is no key, never an empty list. */
export function withBody(traits: Traits, body: AvatarBody): Traits {
  const { height: _height, bust: _bust, figure: _figure, legLength: _legLength, legShape: _legShape, bottomSize: _bottomSize, bottomShape: _bottomShape, bodyMarks: _bodyMarks, ...rest } =
    traits;
  return { ...rest, ...tidyBody(body) };
}

/** The body without its unset keys, and without an empty list of marks: what `avatars.setBody` is sent and what the summary compares. */
export function tidyBody(body: AvatarBody): AvatarBody {
  const out: AvatarBody = {};
  for (const key of BODY_KEYS) {
    const value = body[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) continue;
    Object.assign(out, { [key]: value });
  }
  return out;
}

/** Whether two bodies say the same (key by key, marks as a set). */
export function sameBody(a: AvatarBody, b: AvatarBody): boolean {
  const x = tidyBody(a);
  const y = tidyBody(b);
  return BODY_KEYS.every((key) => {
    const left = x[key];
    const right = y[key];
    if (Array.isArray(left) || Array.isArray(right)) {
      const l = Array.isArray(left) ? left : [];
      const r = Array.isArray(right) ? right : [];
      return l.length === r.length && l.every((mark) => r.includes(mark));
    }
    return left === right;
  });
}

function pickOrUnset<T>(items: readonly T[], rng: () => number): T | undefined {
  // «не задано» is one more choice, as likely as each value.
  const index = Math.floor(rng() * (items.length + 1)) % (items.length + 1);
  return index === 0 ? undefined : items[index - 1];
}

/** «Случайно» for the body (owner's decision): each field a random value or «не задано», and 0–1 marks. */
export function randomBody(rng: () => number = Math.random): AvatarBody {
  const mark = rng() < 0.5 ? undefined : BODY_MARKS[Math.floor(rng() * BODY_MARKS.length) % BODY_MARKS.length]?.value;
  return tidyBody({
    height: pickOrUnset(HEIGHTS, rng)?.value,
    bust: pickOrUnset(BUSTS, rng)?.value,
    figure: pickOrUnset(FIGURES, rng)?.value,
    legLength: pickOrUnset(LEG_LENGTHS, rng)?.value,
    legShape: pickOrUnset(LEG_SHAPES, rng)?.value,
    bottomSize: pickOrUnset(BOTTOM_SIZES, rng)?.value,
    bottomShape: pickOrUnset(BOTTOM_SHAPES, rng)?.value,
    bodyMarks: mark === undefined ? undefined : [mark],
  });
}

const labelOf = <T extends string>(list: readonly Choice<T>[], value: T | undefined): string | null =>
  value === undefined ? null : (list.find((c) => c.value === value)?.label ?? null);

/** Two parts as one value: «Длинные · стройные», «Небольшая · подтянутая»; one part alone as it is labelled. */
function pair(first: string | null, second: string | null): string | null {
  if (first === null) return second;
  return second === null ? first : `${first} · ${second.toLowerCase()}`;
}

/** What the summary on «Внешность» says for a field: «Длинные · стройные», «Тату на щиколотке · Родинка на ключице»; null for «не задано». */
export function fieldValue(body: AvatarBody, field: BodyField): string | null {
  switch (field) {
    case "height":
      return labelOf(HEIGHTS, body.height);
    case "bust":
      return labelOf(BUSTS, body.bust);
    case "figure":
      return labelOf(FIGURES, body.figure);
    case "legs":
      return pair(labelOf(LEG_LENGTHS, body.legLength), labelOf(LEG_SHAPES, body.legShape));
    case "bottom":
      return pair(labelOf(BOTTOM_SIZES, body.bottomSize), labelOf(BOTTOM_SHAPES, body.bottomShape));
    case "marks": {
      const marks = BODY_MARKS.filter((m) => body.bodyMarks?.includes(m.value) === true).map((m) => m.label);
      return marks.length === 0 ? null : marks.join(" · ");
    }
  }
}

// ---------- a change of the body phrase, slot by slot (mockup 08) ----------

/** A run of the phrase: kept, struck out or inserted (the same shape as the look tab's text diff). */
export interface BodyDiffPart {
  readonly kind: "same" | "del" | "ins";
  readonly text: string;
}

/** The phrase's slots in its own order: height, bust, figure, legs, bottom, then each mark in the list's fixed order. */
const SLOTS: readonly string[] = ["height", "bust", "figure", "legs", "bottom", ...BodyMark.options];

/** Each set slot as `bodyPhrase` words it alone (one item: no joins), so this file never writes an English word of its own. */
function slotPhrases(body: AvatarBody): Map<string, string> {
  const slots = new Map<string, string>();
  const add = (slot: string, part: AvatarBody): void => {
    const phrase = bodyPhrase(tidyBody(part));
    if (phrase !== undefined) slots.set(slot, phrase);
  };
  add("height", { height: body.height });
  add("bust", { bust: body.bust });
  add("figure", { figure: body.figure });
  add("legs", { legLength: body.legLength, legShape: body.legShape });
  add("bottom", { bottomSize: body.bottomSize, bottomShape: body.bottomShape });
  for (const mark of BodyMark.options) if (body.bodyMarks?.includes(mark) === true) add(mark, { bodyMarks: [mark] });
  return slots;
}

/**
 * The phrase `after` writes, with what `before` wrote struck out slot by slot where it changed or went: «<del>tall</del> <ins>average height</ins>, a
 * small bust<del>, a straight figure</del> and …». The kept and inserted runs read exactly `bodyPhrase(after)` (its commas and its «and» before the last
 * item); a slot that went is struck out where it stood, with its own comma. A word-level diff would match the joins' «a» and «and» across slots and
 * scatter the change.
 */
export function bodyPhraseDiff(before: AvatarBody, after: AvatarBody): BodyDiffPart[] {
  const was = slotPhrases(before);
  const now = slotPhrases(after);
  const items = SLOTS.filter((slot) => now.has(slot)).length;
  const parts: BodyDiffPart[] = [];
  // Kept runs join up; each struck or inserted item stays its own run, so two slots never read as one.
  const push = (kind: BodyDiffPart["kind"], text: string): void => {
    const last = parts.at(-1);
    if (kind === "same" && last !== undefined && last.kind === "same") parts[parts.length - 1] = { kind, text: last.text + text };
    else parts.push({ kind, text });
  };
  let placed = 0;
  let gone = 0;
  for (const slot of SLOTS) {
    const old = was.get(slot);
    const next = now.get(slot);
    if (next === undefined) {
      if (old === undefined) continue;
      // After a kept item the comma goes with it; before the first one, the comma after it; with nothing left, between the struck ones.
      if (placed > 0) push("del", `, ${old}`);
      else if (items > 0) push("del", `${old}, `);
      else push("del", gone > 0 ? `, ${old}` : old);
      gone += 1;
      continue;
    }
    if (placed > 0) push("same", placed === items - 1 ? " and " : ", ");
    placed += 1;
    if (old === next) push("same", next);
    else {
      if (old !== undefined) push("del", old);
      push("ins", next);
    }
  }
  return parts;
}

// ---------- the descriptor as a prompt carries it ----------

/** The descriptor text as a prompt starts it: without its closing period (`promptSubject` drops it before «; » and the body phrase). */
export function descriptorHead(text: string): string {
  return text.replace(/[.\s]+$/, "");
}

/** How long the description itself may be beside her body phrase: 600, less «; » and the phrase (L10). */
export function textLimit(phrase: string | undefined): number {
  return phrase === undefined ? DESCRIPTOR_MAX_CHARS : DESCRIPTOR_MAX_CHARS - 2 - phrase.length;
}

// ---------- «Телосложение» on «Внешность» (D1: read-only there; it lives in the model-written text) ----------

export type BuildValue = Traits["build"];

/** A build word as the descriptor model writes it («athletic build», «curvy figure»); a «soft» that is not about the body («soft jawline») is not one. */
const BUILD_IN_TEXT = /\b(slim|athletic|soft|curvy)\s+(?:build|figure|frame|physique|body)\b/i;

/** The build the description names, or null when it names none this window can read: shown read-only, it is changed in the text. */
export function buildInText(text: string): BuildValue | null {
  const word = BUILD_IN_TEXT.exec(text)?.[1]?.toLowerCase();
  return word === "slim" || word === "athletic" || word === "soft" || word === "curvy" ? word : null;
}

// ---------- an import's proposal (S5.2b writes it; this window shows it) ----------

/** Where a value of a proposal came from: read from the photo, or not on it. */
export type BodySource = "photo" | "none";

export interface ProposalSources {
  readonly fields: Partial<Record<BodyField, BodySource>>;
  /** «Телосложение»: read from the photo when it showed the body, guessed from the face when it showed only the face. */
  readonly build: "photo" | "guess";
}

/** Per field, what the photo showed: «с фото» when any part was seen, «не видно на фото» when none was and some part was looked for. */
export function proposalSources(proposal: BodyProposal): ProposalSources {
  const fields: Partial<Record<BodyField, BodySource>> = {};
  for (const field of BODY_FIELDS) {
    const seen = FIELD_KEYS[field].map((key) => proposal.seen[key]);
    if (seen.includes("photo")) fields[field] = "photo";
    else if (seen.includes("not-visible")) fields[field] = "none";
  }
  const anySeen = Object.values(fields).includes("photo");
  return { fields, build: anySeen ? "photo" : "guess" };
}

/** The hint beside «Тело» while a proposal waits, as the mockup's 05 and 06 say it. */
export function proposalHint(proposal: BodyProposal): string {
  const { fields } = proposalSources(proposal);
  const hidden = BODY_FIELDS.filter((field) => fields[field] === "none");
  if (!BODY_FIELDS.some((field) => fields[field] === "photo")) return "на фото только лицо — тело выберите сами или оставьте «не задано»";
  if (hidden.length === 0) return "тело прочитано с фото — проверьте и сохраните";
  const names = hidden.map((field) => FIELD_ACCUSATIVE[field]);
  const list = names.length === 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} и ${names[names.length - 1] ?? ""}`;
  return `${list} на фото не видно — выберите сами или оставьте «не задано»`;
}

/** The body to start the edit from while a proposal waits: hers, with what the photo showed on top. */
export function proposedBody(current: AvatarBody | undefined, proposal: BodyProposal): AvatarBody {
  return tidyBody({ ...current, ...proposal.values });
}
