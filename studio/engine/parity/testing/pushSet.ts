// Which parity stories a push plays, and which only the nightly (heavy) run plays. The golden file is not touched by this: a story is only MOVED, never dropped, and the heavy run
// plays every key of `golden.ts` (parity.plan.test.ts proves it).
//
// A story belongs to the family of commands its name starts with (the text before the first «:»; a story with no colon is a family of its own). A family of one story is always on
// a push. A family of several is on a push by its PICKS below, and the rest of its stories wait for the nightly run: a new story added to a big family is therefore nightly-only until
// someone picks it, and a new family is on a push from its first story.

export interface ParityPick {
  /** The family: the name up to its first «:». */
  readonly family: string;
  /** How the rest of the name (after the «:») begins; it must name exactly one story of the family. */
  readonly startsWith: string;
}

/** `sweep`: a plain test for the push run and a `[heavy]` twin for the heavy run. `heavy`: a `[heavy]` test only. */
export type Registration = "sweep" | "heavy";

export interface ParityEntry {
  readonly name: string;
  readonly family: string;
  readonly registration: Registration;
}

/**
 * One story per family of several, and more where the family guards money, a recovery or «Смелая» (the route, the price, the origin): a clip, a batch and a motion call settle
 * exactly, a reserve left open or an uncertain submit is held for the reconcile, a launch is held by a 402 or a quit and goes on, and the minor-age guard refuses a motion text.
 */
export const PUSH_PICKS: readonly ParityPick[] = [
  // the render queue and the export folder
  { family: "cancel", startsWith: "a running render ends when its work stops" },
  { family: "delete while queued", startsWith: "the draft of a queued render is deleted" },
  { family: "engine.snapshot", startsWith: "what a window resyncs from" },
  { family: "export folder", startsWith: "why a render is refused" },
  // music, text previews, own media
  { family: "music", startsWith: "a trending track the store does not hold" },
  { family: "music", startsWith: "a damaged quota log refuses a refresh at no cost" },
  { family: "text preview", startsWith: "a drawn caption answers an id" },
  { family: "music list and peaks", startsWith: "with nothing stored" },
  { family: "own media", startsWith: "an import is a job that ends in a record" },
  { family: "own photos", startsWith: "a render holds its media against media.delete" },
  { family: "own stickers", startsWith: "a render holds its sticker against media.delete" },
  { family: "own music", startsWith: "a draft judges its track by the library" },
  { family: "own video clips", startsWith: "a render holds its video against media.delete" },
  // scene sets and categories
  { family: "custom categories", startsWith: "the library lists its category" },
  { family: "scene sets", startsWith: "the open set a closed Studio left" },
  // the batch autopilot
  { family: "autopilot", startsWith: "what the contract refuses is refused by both engines" },
  { family: "autopilot (pending the orchestrator)", startsWith: "the preview plans per avatar" },
  { family: "autopilot (running)", startsWith: "a launch with the review off composes, draws, montages and renders" },
  { family: "autopilot (running)", startsWith: "a start below the engine's worst case is PRICE_CHANGED and writes nothing" },
  { family: "autopilot (running)", startsWith: "OpenRouter's 402 holds the paid work" },
  { family: "autopilot (running)", startsWith: "the app is quit with a request in flight" },
  { family: "autopilot (running)", startsWith: "a slice job that ends INTERNAL holds the launch" },
  { family: "autopilot (estimate)", startsWith: "the plan card is filled" },
  // avatars
  { family: "editDescriptor", startsWith: "the owner's text is stored folded" },
  { family: "checkDescriptor", startsWith: "the check is priced for a saved avatar" },
  { family: "setBody", startsWith: "the body is stored beside the description" },
  { family: "importBodyProposal", startsWith: "a check of an avatar that holds the import's body proposal is priced" },
  { family: "portraits", startsWith: "the batch is priced for any avatar" },
  { family: "portraits", startsWith: "a batch is drawn and ranked" },
  // template launches and the scene writer
  { family: "template launch (running)", startsWith: "a compose and a run on «Дом» write every scene at once" },
  { family: "template launch (running)", startsWith: "OpenRouter's 402 and 401 meet the first PHOTO" },
  { family: "scene writer (running launch)", startsWith: "a compose whose writer is rejected twice" },
  // «Смелая»: the route, the price and the origin of a photo run
  { family: "photo runs, «Смелая» (S5.9f)", startsWith: "a run from the composed set draws every scene" },
  { family: "photo runs, «Смелая» (S5.9f)", startsWith: "Seedream's refusal ends only the slot it met" },
  { family: "photo runs, «Смелая» (S5.9f)", startsWith: "a Seedream answer with no image ends its slot settled" },
  // clips
  { family: "clips", startsWith: "the sheet tells each photo apart" },
  { family: "clips", startsWith: "every refusal of a create is free" },
  { family: "clips", startsWith: "a clip is made" },
  { family: "clips", startsWith: "in mode auto a content refusal proven free is followed by Grok" },
  { family: "clips", startsWith: "a refusal that is not proven free stops the clip" },
  { family: "clips", startsWith: "a frame of «Смелая» runs on Kling alone" },
  { family: "clips", startsWith: "a submit with no answer ends the clip at once" },
  { family: "clips", startsWith: "a clip that never comes ends `late`" },
  { family: "clips in the montage", startsWith: "a ready clip becomes the editor's own video" },
  { family: "clips in the montage", startsWith: "a montage that holds a copy renders" },
  { family: "clip batch", startsWith: "the sheet tells each photo and the sums" },
  { family: "clip batch", startsWith: "the month holds a batch whole or not at all" },
  { family: "clip batch", startsWith: "a clean batch is made one clip at a time" },
  { family: "clip batch", startsWith: "a «Смелая» member is Kling's alone" },
  { family: "clip batch", startsWith: "a cancel in the middle cancels the queue for free" },
  { family: "clip batch", startsWith: "an uncertain submit ends the queue" },
  { family: "price cache", startsWith: "a single clip reads the book the sheet read" },
  { family: "clip motions", startsWith: "the estimates are free, a suggestion is paid" },
  { family: "clip motions", startsWith: "on a frame of «Смелая» an idea that takes clothing off is accepted" },
  { family: "clip motions", startsWith: "an attempt is reserved for the message it sends" },
  { family: "clip motions", startsWith: "a bill above the reserve stops the ledger" },
  { family: "clip motions", startsWith: "the age guard refuses a suggestion and an idea that name an age" },
];

/** The family of commands a story belongs to: its name up to the first «:» (the whole name when it has none). */
export function familyOf(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(0, colon);
}

function pickedName(names: readonly string[], pick: ParityPick): string {
  const found = names.filter((name) => familyOf(name) === pick.family && name.slice(pick.family.length + 1).trimStart().startsWith(pick.startsWith));
  const [only] = found;
  if (found.length !== 1 || only === undefined) throw new Error(`parity push pick «${pick.family}: ${pick.startsWith}…» names ${found.length} stories, not one`);
  return only;
}

/**
 * How each story registers: a `sweep` (push + heavy twin) for a family of one and for every pick, a heavy-only test for the rest. Throws on a pick that names no story or
 * several, so a renamed story cannot silently fall out of the push run.
 */
export function planParity(names: readonly string[], picks: readonly ParityPick[] = PUSH_PICKS): ParityEntry[] {
  const picked = new Set(picks.map((pick) => pickedName(names, pick)));
  const size = new Map<string, number>();
  for (const name of names) size.set(familyOf(name), (size.get(familyOf(name)) ?? 0) + 1);
  return names.map((name) => {
    const family = familyOf(name);
    return { name, family, registration: size.get(family) === 1 || picked.has(name) ? "sweep" : "heavy" };
  });
}
