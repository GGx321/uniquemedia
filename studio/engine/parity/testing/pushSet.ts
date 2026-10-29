// Which parity stories a push plays, and which only the nightly (heavy) run plays. The golden file is not touched by this: a story is only MOVED, never dropped, and the heavy run
// plays every key of `golden.ts` (parity.plan.test.ts proves it).
//
// A story belongs to the family of commands its name starts with (the text before the first «:»; a story with no colon is a family of its own). EVERY story is on a push except the
// ones named in NIGHTLY_ONLY below, so a new story, in a big family or a new one, is on a push until someone sends it to the nightly run on purpose. A family can never be sent
// wholly to the nightly run: one story of it stays on a push (planParity refuses it, and the plan test checks every family).

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
 * The stories only the nightly run plays: the second and later stories of a big family that tell what another story of the family already tells on a push. What stays on a push is
 * every family's first-line story and, wherever the family guards money, a recovery, the minor-age guard or «Смелая» (the route, the price, the origin), the stories that guard it:
 * a clip, a batch and a motion call settle exactly, a reserve left open or an uncertain submit is held for the reconcile, a launch is held by a 402 or a quit and goes on.
 */
export const NIGHTLY_ONLY: readonly ParityPick[] = [
  { family: "cancel", startsWith: "a queued render ends at once and the running " },
  { family: "cancel", startsWith: "past the point of no return the cancel is ign" },
  { family: "cancel", startsWith: "a job that ended, and a job nobody knows" },
  { family: "delete while queued", startsWith: "a video is deleted while a render waits behin" },
  { family: "engine.snapshot", startsWith: "the latest 50 finished renders are kept, the " },
  { family: "export folder", startsWith: "a cancelled dialog changes nothing, another f" },
  { family: "export folder", startsWith: "a folder the owner moved is the same folder, " },
  { family: "export folder", startsWith: "a pick that cannot be the folder is refused w" },
  { family: "music", startsWith: "with an unavailable photo too, get lists the " },
  { family: "music", startsWith: "a quota log that counted requests, deleted wi" },
  { family: "text preview", startsWith: "the caption rules name the first rule broken," },
  { family: "text preview", startsWith: "a queued preview of the same layer is superse" },
  { family: "text preview", startsWith: "a refused caption holds the lane like a drawi" },
  { family: "text preview", startsWith: "past 64 pictures the oldest that is not a lay" },
  { family: "text preview", startsWith: "a layer's newest picture is kept even when it" },
  { family: "text preview", startsWith: "past four times the bound a caller inventing " },
  { family: "music list and peaks", startsWith: "the stored tracks in list order, highlights a" },
  { family: "music list and peaks", startsWith: "free and independent of the key and the quota" },
  { family: "music", startsWith: "a stored trending track is judged against its" },
  { family: "music", startsWith: "a track whose decode proved a shorter length " },
  { family: "own media", startsWith: "a cancelled dialog changes nothing, and a pic" },
  { family: "own media", startsWith: "a second import waits queued behind the first" },
  { family: "own media", startsWith: "without an importer a good photo is refused a" },
  { family: "own photos", startsWith: "a render that fails lets its media go, and a " },
  { family: "own photos", startsWith: "the photo importer refuses a picture inside i" },
  { family: "own media", startsWith: "a video is a job that ends in a record with t" },
  { family: "own stickers", startsWith: "a render that fails lets its sticker go, a me" },
  { family: "own stickers", startsWith: "the sticker importer refuses a file inside it" },
  { family: "own stickers", startsWith: "media.list by id answers the records named, o" },
  { family: "own music", startsWith: "a render that fails lets its track go, and a " },
  { family: "own music", startsWith: "the music importer refuses a track inside its" },
  { family: "own video clips", startsWith: "a clip that asks past the end of its video is" },
  { family: "own video clips", startsWith: "a render that fails lets its video go, a medi" },
  { family: "own media", startsWith: "an import has two stages, the copy in bytes a" },
  { family: "custom categories", startsWith: "a refusal names its reason, so the sheet can " },
  { family: "custom categories", startsWith: "the angles of a category are set, replaced an" },
  { family: "custom categories", startsWith: "a run names a category the library does not h" },
  { family: "scene sets", startsWith: "one open set, an empty set is free, a discard" },
  { family: "autopilot", startsWith: "an own track is flagged for the autopilot and" },
  { family: "autopilot (pending the orchestrator)", startsWith: "pause, resume with the remaining worst case, " },
  { family: "autopilot (pending the orchestrator)", startsWith: "the review hand-off draws now, or records the" },
  { family: "autopilot (pending the orchestrator)", startsWith: "a launch is listed and read, and an unreadabl" },
  { family: "autopilot", startsWith: "with no launch in the library the list is emp" },
  { family: "autopilot (running)", startsWith: "with the review on the scenes wait for the ow" },
  { family: "autopilot (running)", startsWith: "a launch is paused where nothing is in flight" },
  { family: "autopilot (running)", startsWith: "a stop ends the launch from its review wait a" },
  { family: "autopilot (running)", startsWith: "OpenRouter's 401 holds the launch and closes " },
  { family: "autopilot (running)", startsWith: "a full disk holds the renders (a free hold), " },
  { family: "autopilot (running)", startsWith: "with no track stored the videos wait for musi" },
  { family: "autopilot (running)", startsWith: "the price of drawing is free and told by the " },
  { family: "autopilot (estimate)", startsWith: "a plan with every photo new says what blocks " },
  { family: "autopilot (running)", startsWith: "a launch's composed set is the launch's — the" },
  { family: "autopilot (running)", startsWith: "a launch's drawn photos are the launch's run " },
  { family: "autopilot (running)", startsWith: "«Стоп» under a hold ends the launch with no h" },
  { family: "autopilot (running)", startsWith: "an approval given in a pause freezes the set " },
  { family: "autopilot (running)", startsWith: "while the launch's writer is out the set is b" },
  { family: "editDescriptor", startsWith: "every rule has its own reason, the stale chec" },
  { family: "editDescriptor", startsWith: "an unknown avatar is NOT_FOUND, a payload the" },
  { family: "editDescriptor", startsWith: "an edit is allowed while an autopilot launch " },
  { family: "checkDescriptor", startsWith: "the refusals that come before any spend are f" },
  { family: "checkDescriptor", startsWith: "a check is refused while an autopilot launch " },
  { family: "importBodyProposal", startsWith: "saving the proposal's own values («Сохранить " },
  { family: "setBody", startsWith: "an unknown avatar is NOT_FOUND, a body the co" },
  { family: "setBody", startsWith: "the description and the body phrase together " },
  { family: "setBody", startsWith: "the first body the owner saves takes the stor" },
  { family: "setBody", startsWith: "a body is allowed while an autopilot launch h" },
  { family: "portraits", startsWith: "the refusals that come before any spend are f" },
  { family: "portraits", startsWith: "a batch is refused while an autopilot launch " },
  { family: "portraits", startsWith: "the pick is idempotent, the imported photo ca" },
  { family: "portraits", startsWith: "the discard removes every pending portrait an" },
  { family: "template launch (running)", startsWith: "a frame whose face is hidden is marked, not r" },
  { family: "template launch (running)", startsWith: "paused and stopped after its photos were paid" },
  { family: "scene writer (running launch)", startsWith: "a «Другая сцена» whose writer is rejected twi" },
  { family: "clips", startsWith: "in mode offer the sheet's worst is Kling's al" },
  { family: "clips", startsWith: "a frame of «Смелая» is not suitable while BOL" },
  { family: "clips", startsWith: "a listing without Grok's price stops the shee" },
  { family: "clips", startsWith: "a pro clip of 10 s is a 1080 x 1920 file of 1" },
  { family: "clips", startsWith: "a face check marks and never decides: a misma" },
  { family: "clips", startsWith: "Kling and Grok both refuse, both free: the cl" },
  { family: "clips", startsWith: "a failure that is not a content refusal goes " },
  { family: "clips", startsWith: "a refusal at the submit that is not a content" },
  { family: "clips", startsWith: "in mode offer a refusal proven free offers Gr" },
  { family: "clips", startsWith: "one paid clip at a time, and no cancel once t" },
  { family: "clips", startsWith: "a clip that does not come in its lifetime goe" },
  { family: "clips", startsWith: "a paid clip whose file could not be fetched i" },
  { family: "clips", startsWith: "a file that is not a video is a paid failure " },
  { family: "clips", startsWith: "a clip is deleted with its record, and a seco" },
  { family: "clips", startsWith: "«Сохранить в папку» is an export job with pro" },
  { family: "clips", startsWith: "the export folder decides the export: unplugg" },
  { family: "clips", startsWith: "exports are saved one at a time in the order " },
  { family: "clips in the montage", startsWith: "the clip is held while its copy is made: a de" },
  { family: "clips in the montage", startsWith: "a photo and its clips are one frame: a frame " },
  { family: "clips in the montage", startsWith: "a video that holds a copy keeps its clip's fr" },
  { family: "clips in the montage", startsWith: "a copy whose import is cancelled leaves no re" },
  { family: "clip batch", startsWith: "every refusal of a create is free and comes i" },
  { family: "clip batch", startsWith: "a member refused for free is made on Grok bef" },
  { family: "clip batch", startsWith: "a member refused at the submit by moderation " },
  { family: "clip batch", startsWith: "a price that rose before a member's turn stop" },
  { family: "clip batch", startsWith: "a price that cannot be read at a member's tur" },
  { family: "clip batch", startsWith: "one queued member is cancelled alone, free, a" },
  { family: "clip batch", startsWith: "a cancel is final: the 429 of the member bein" },
  { family: "clip batch", startsWith: "a 429 at the submit is free and requeues the " },
  { family: "clip batch", startsWith: "a second 429 for the same photo is final: two" },
  { family: "clip batch", startsWith: "a photo removed from the gallery, or damaged," },
  { family: "clip batch", startsWith: "a rejected key (401 on a member) fails the la" },
  { family: "price cache", startsWith: "a single clip's sheet and a batch's sheet are" },
  { family: "clip batch", startsWith: "the engine's summary of a batch tells each me" },
  { family: "clips in the montage", startsWith: "a draft's copy whose frame went into a video " },
  { family: "clip motions", startsWith: "a suggestion nobody can use is paid for, the " },
  { family: "clip motions", startsWith: "a text that fails the check is repaired by th" },
  { family: "clip motions", startsWith: "an idea is translated, paid at the model's bi" },
  { family: "clip motions", startsWith: "an idea that fails the checks is rejected wit" },
  { family: "clip motions", startsWith: "a part C call waits for the clip money (clip-" },
  { family: "clip motions", startsWith: "one call per photo and kind: a second suggest" },
  { family: "clip motions", startsWith: "the ids of a source that ran out are `motions" },
  { family: "clip motions", startsWith: "every refusal before the money is free and co" },
  { family: "clip motions", startsWith: "the provider refuses the key: AUTH_INVALID, f" },
  { family: "clip motions", startsWith: "a frame of «Смелая» while bold clips are off " },
  { family: "clip motions", startsWith: "a model that repeats what is already stored i" },
  { family: "clip motions", startsWith: "a model that suggests a motion which left the" },
  { family: "clip motions", startsWith: "an idea that takes clothing off on an ordinar" },
  { family: "clip motions", startsWith: "an idea the translator refuses with its code " },
];

/** The family of commands a story belongs to: its name up to the first «:» (the whole name when it has none). */
export function familyOf(name: string): string {
  const colon = name.indexOf(":");
  return colon < 0 ? name : name.slice(0, colon);
}

function pickedName(names: readonly string[], pick: ParityPick): string {
  const found = names.filter((name) => familyOf(name) === pick.family && name.slice(pick.family.length + 1).trimStart().startsWith(pick.startsWith));
  const [only] = found;
  if (found.length !== 1 || only === undefined) throw new Error(`parity nightly-only entry «${pick.family}: ${pick.startsWith}…» names ${found.length} stories, not one`);
  return only;
}

/**
 * How each story registers: a `sweep` (push + heavy twin) for every story, a heavy-only test for the ones `nightlyOnly` names. Throws on an entry that names no story or several (a
 * renamed story cannot silently change run), and on a family sent wholly to the nightly run.
 */
export function planParity(names: readonly string[], nightlyOnly: readonly ParityPick[] = NIGHTLY_ONLY): ParityEntry[] {
  const later = new Set(nightlyOnly.map((pick) => pickedName(names, pick)));
  const entries = names.map((name): ParityEntry => ({ name, family: familyOf(name), registration: later.has(name) ? "heavy" : "sweep" }));
  const pushed = new Set(entries.filter((e) => e.registration === "sweep").map((e) => e.family));
  const lost = [...new Set(entries.map((e) => e.family))].filter((family) => !pushed.has(family));
  if (lost.length > 0) throw new Error(`parity: every story of ${lost.map((f) => `«${f}»`).join(", ")} is nightly-only; a push must play one`);
  return entries;
}
