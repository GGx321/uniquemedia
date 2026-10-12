import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { faceVisibleOf } from "../../shared/scenes/captures";
import { PLAN_FILE, RUNS_DIR } from "../library/layout";
import type { PhotoSidecar } from "../library/schemas";

// S5.7b (the S5.7a review): a photo stored before the face gate wrote `qa.faceMarked` carries a likeness the gate never judged (a face-hidden or back frame was checked under the
// `body` pose and kept its number), and a number like 0.82 reads as a verified match. The autopilot would pick it for a single-photo video. The mark is RESTORED from the slot the photo
// was made for, in its run's plan.json: a frame whose face does not show (`faceVisibleOf` no or maybe: the phone over it, the legs, a back pose, an old slot included) is marked.
//
// Read once per (library, avatar) and cached: the answer cannot change (a photo made after S5.7a carries its own mark), the callers are synchronous (the free steps' snapshot), and a
// plan.json is small. Never a throw: a plan that is missing, unreadable or in another shape marks nothing, and the photo stays as it was.

const SlotShape = z.looseObject({ attemptIdBase: z.string(), shot: z.string(), pose: z.string(), capture: z.string().optional(), framing: z.string().optional() });
const PlanShape = z.looseObject({ scenes: z.looseObject({ slots: z.array(SlotShape) }) });
type SlotFacts = z.infer<typeof SlotShape>;

/** The run a generated photo was made by: the prefix of its `attemptId`, `${runId}:slot-N#k`. */
export function runIdOfAttempt(attemptId: string): string | null {
  return /^(.+):slot-\d+#\d+$/.exec(attemptId)?.[1] ?? null;
}

/** What `faceVisibleOf` reads of a stored slot, or null for a slot whose texts are not the planner's own. */
function faceFactsOf(slot: SlotFacts): Parameters<typeof faceVisibleOf>[0] | null {
  const shots = ["friend", "selfie", "mirror", "candid", "photographer"] as const;
  const poses = ["front", "three-quarter", "profile", "back"] as const;
  const shot = shots.find((s) => s === slot.shot);
  const pose = poses.find((p) => p === slot.pose);
  if (shot === undefined || pose === undefined) return null;
  const parsed = slot.capture === undefined ? undefined : z.enum(["mirror-hidden", "mirror", "above", "prone", "over-shoulder", "selfie", "timer", "friend", "candid", "pov-legs", "low-feet"]).safeParse(slot.capture);
  return { shot, pose, ...(parsed?.success === true ? { capture: parsed.data } : {}), ...(slot.framing === "legs" ? { framing: "legs" as const } : {}) };
}

function slotsOfRun(root: string, runId: string): ReadonlyMap<string, SlotFacts> | null {
  try {
    const parsed = PlanShape.safeParse(JSON.parse(readFileSync(join(root, RUNS_DIR, runId, PLAN_FILE), "utf8")));
    return parsed.success ? new Map(parsed.data.scenes.slots.map((slot) => [slot.attemptIdBase, slot] as const)) : null;
  } catch {
    return null;
  }
}

/** The ids of an avatar's photos that carry no mark but were made for a slot whose face does not show. Pure over the plans it is given. */
export function legacyMarkedIds(photos: readonly PhotoSidecar[], slotsOf: (runId: string) => ReadonlyMap<string, SlotFacts> | null): Set<string> {
  const marked = new Set<string>();
  const runs = new Map<string, ReadonlyMap<string, SlotFacts> | null>();
  for (const photo of photos) {
    if (photo.source.kind !== "generated" || photo.qa.faceMarked === true || photo.source.slot === undefined) continue;
    const runId = runIdOfAttempt(photo.source.attemptId);
    if (runId === null) continue;
    if (!runs.has(runId)) runs.set(runId, slotsOf(runId));
    const slot = runs.get(runId)?.get(photo.source.slot);
    const facts = slot === undefined ? null : faceFactsOf(slot);
    if (facts !== null && faceVisibleOf(facts) !== "yes") marked.add(photo.id);
  }
  return marked;
}

const cache = new WeakMap<object, Map<string, { photos: string; marks: ReadonlySet<string> }>>();

/**
 * The restored marks of one avatar's photos, read once per library object and again only when the avatar's set of photos changed (a new photo is read against its run; an old
 * one cannot appear). Empty for a library that does not say where it lives.
 */
export function legacyMarksOf(library: { readonly root?: string }, avatarId: string, photos: readonly PhotoSidecar[]): ReadonlySet<string> {
  if (library.root === undefined) return new Set();
  const root = library.root;
  const perLibrary = cache.get(library) ?? new Map<string, { photos: string; marks: ReadonlySet<string> }>();
  cache.set(library, perLibrary);
  // Keyed by the photo-id set, not its size: a photo swapped for another is read again.
  const key = photos.map((photo) => photo.id).sort().join(",");
  const known = perLibrary.get(avatarId);
  if (known !== undefined && known.photos === key) return known.marks;
  const marks = legacyMarkedIds(photos, (runId) => slotsOfRun(root, runId));
  perLibrary.set(avatarId, { photos: key, marks });
  return marks;
}
