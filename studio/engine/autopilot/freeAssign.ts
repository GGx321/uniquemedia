import type { VideoShape } from "../../shared/engine/autopilot";
import type { CategoryRef } from "../../shared/engine/categories";
import type { FileVideo, LaunchFile } from "./launchFile";
import { assignGenerated, planLaunch, poolOf, type PlanAvatarInput, type PlannedVideo, type PlanPhoto } from "./planner";

// Stage 4 (plan §5.3, §5.4, §6.4, A7): the pure half of the free path. Which photos go into which videos of a launch, given the launch file and a FRESH snapshot of each avatar's photos
// (never the plan-time one: the owner may have rejected, used or drafted a photo since). Nothing here reads a library or writes a file; the steps feed it snapshots and apply the answer.
//
// ONE definition of a photo a video of this launch may take (A7), the planner's own `poolOf`: eligible, not rejected, not used, not reserved, not held by a saved draft, of the avatar,
// of a chosen category. The launch's own photos are marked reserved before it is asked, so no photo goes into two videos.

/** What the steps know of one avatar right now. `ready` is false while its usage or its drafts are not known: nothing is picked for it and nothing is dropped (it waits). */
export interface AvatarFacts {
  avatarId: string;
  ready: boolean;
  photos: readonly PlanPhoto[];
  /**
   * The photos of the launch's own slices while the avatar still has generated videos waiting for photos: they belong to those videos, so a library pick, a leftover pick and a re-pick never
   * take one (`assignArrived` is the one that does).
   */
  withheld?: ReadonlySet<string>;
}

/** A video's photos as assigned: its shape and size may be smaller than planned (a degrade). */
export interface VideoPick {
  key: string;
  shape: VideoShape;
  size: number;
  category: CategoryRef;
  photoIds: readonly string[];
}

export interface PickOutcome {
  picks: VideoPick[];
  /** Keys of the videos that cannot get photos any more (`not-enough-photos`). */
  dropped: string[];
  /** Photos the plan wanted and did not get, for the log's `degrade` line. */
  missingPhotos: number;
}

const EMPTY: PickOutcome = { picks: [], dropped: [], missingPhotos: 0 };

const keyPart = (key: string): [number, number] => {
  const [avatar, video] = key.split("-");
  return [Number(avatar), Number(video)];
};
const byKey = (a: { key: string }, b: { key: string }): number => {
  const [aa, av] = keyPart(a.key);
  const [ba, bv] = keyPart(b.key);
  return aa - ba || av - bv;
};

/** The photos videos of the launch hold: every video that is not dropped, except the one named (its own photos are its own). */
export function takenPhotos(videos: readonly FileVideo[], exceptKey?: string): Set<string> {
  const taken = new Set<string>();
  for (const video of videos) {
    if (video.state === "dropped" || video.key === exceptKey) continue;
    for (const photoId of video.photoIds) taken.add(photoId);
  }
  return taken;
}

const plannedOf = (video: FileVideo): PlannedVideo => ({ key: video.key, shape: video.shape, size: video.size, source: video.source, category: video.category, photoIds: video.photoIds });

function inputOf(facts: AvatarFacts, taken: ReadonlySet<string>): PlanAvatarInput {
  return {
    avatarId: facts.avatarId,
    usage: { state: "ok" },
    hasOpenSet: false,
    draftsKnown: facts.ready,
    // A photo a video of the launch already holds counts as reserved: the planner's pool leaves it out.
    photos: facts.photos.map((photo) => (taken.has(photo.id) ? { ...photo, reserved: true } : photo)),
  };
}

const rowOf = (file: LaunchFile, avatarId: string): readonly FileVideo[] => file.avatars.find((a) => a.avatarId === avatarId)?.videos ?? [];

/** The candidates for a pick: the avatar's free photos once the launch's own are set aside (and, unless `forGenerated`, the photos of its slices that generated videos are still waiting for). */
function candidates(file: LaunchFile, facts: AvatarFacts, held: ReadonlySet<string>, taken: ReadonlySet<string>, forGenerated = false): PlanPhoto[] {
  const set = forGenerated || facts.withheld === undefined ? taken : new Set([...taken, ...facts.withheld]);
  return poolOf(inputOf(facts, set), { draft: file.draft, draftHeldPhotoIds: held });
}

/**
 * The library videos of the plan, given their photos from a fresh snapshot (§5.3). The planner is run again on the fresh photos with the launch's own set aside: the same seed gives the same
 * slots, so a start and its first assignment agree when nothing changed. A library video the fresh plan cannot fill from the pool is tried once more against what is left; if that fails
 * too it is dropped. An avatar that is not `ready` waits: nothing is picked for it and nothing is dropped.
 */
export function assignLibrary(file: LaunchFile, facts: ReadonlyMap<string, AvatarFacts>, held: ReadonlySet<string>): { byAvatar: Map<string, PickOutcome>; waiting: ReadonlySet<string> } {
  const byAvatar = new Map<string, PickOutcome>();
  const waiting = new Set<string>();
  const pendingOf = (avatarId: string): FileVideo[] => rowOf(file, avatarId).filter((v) => v.source === "library" && v.state === "planned");
  const wanting = file.avatars.filter((a) => pendingOf(a.avatarId).length > 0);
  if (wanting.length === 0) return { byAvatar, waiting };

  for (const row of wanting) if (facts.get(row.avatarId)?.ready !== true) waiting.add(row.avatarId);

  const plan = planLaunch({
    draft: file.draft,
    avatars: file.draft.avatarIds.map((avatarId) => {
      const known = facts.get(avatarId);
      const taken = takenPhotos(rowOf(file, avatarId));
      return inputOf(known ?? { avatarId, ready: false, photos: [] }, known?.withheld === undefined ? taken : new Set([...taken, ...known.withheld]));
    }),
    draftHeldPhotoIds: held,
    customPoses: new Map(),
  });

  for (const row of wanting) {
    const known = facts.get(row.avatarId);
    if (known === undefined || !known.ready) continue;
    const pending = pendingOf(row.avatarId).sort(byKey);
    const fresh = plan.avatars.find((a) => a.avatarId === row.avatarId)?.videos.filter((v) => v.source === "library") ?? [];
    const picks: VideoPick[] = [];
    const unfilled: FileVideo[] = [];
    for (const video of pending) {
      const found = fresh.find((v) => v.key === video.key);
      if (found === undefined) unfilled.push(video);
      else picks.push({ key: found.key, shape: found.shape, size: found.photoIds.length, category: found.category, photoIds: found.photoIds });
    }
    const dropped: string[] = [];
    if (unfilled.length > 0) {
      // The fresh plan may have spent photos on slots the file planned as generated; what is left is tried before a video is given up.
      const used = new Set([...takenPhotos(rowOf(file, row.avatarId)), ...picks.flatMap((p) => p.photoIds)]);
      const leftover = candidates(file, known, held, used);
      const second = assignGenerated(unfilled.map(plannedOf), leftover);
      for (const v of second.videos) picks.push({ key: v.key, shape: v.shape, size: v.photoIds.length, category: v.category, photoIds: v.photoIds });
      for (const d of second.dropped) dropped.push(d.key);
    }
    const asked = new Map(pending.map((v) => [v.key, v.size]));
    const got = picks.reduce((sum, p) => sum + Math.max(0, (asked.get(p.key) ?? 0) - p.size), 0);
    const lost = dropped.reduce((sum, key) => sum + (asked.get(key) ?? 0), 0);
    byAvatar.set(row.avatarId, { picks: picks.sort(byKey), dropped: dropped.sort((a, b) => byKey({ key: a }, { key: b })), missingPhotos: got + lost });
  }
  return { byAvatar, waiting };
}

/**
 * After a slice (§5.4): the photos that arrived go into the avatar's generated videos by category and key. While the draw goes on, only the videos that can be filled IN FULL are taken, and
 * in each category only those before the first one that cannot be (a shortage that a later slice may still fill is not a degrade yet). Once the draw is over (`over`) the rest degrade or are
 * dropped by the planner's rules (§6.4): the shortage lands on the highest keys.
 */
export function assignArrived(file: LaunchFile, avatarId: string, facts: AvatarFacts, held: ReadonlySet<string>, arrived: ReadonlySet<string>, over: boolean): PickOutcome {
  if (!facts.ready) return EMPTY;
  const row = rowOf(file, avatarId);
  const pending = row.filter((v) => v.source === "generated" && (v.state === "planned" || v.state === "waiting-photos") && v.photoIds.length === 0).sort(byKey);
  if (pending.length === 0) return EMPTY;
  const free = candidates(file, facts, held, takenPhotos(row), true).filter((photo) => arrived.has(photo.id));
  const result = assignGenerated(pending.map(plannedOf), free);
  const asked = new Map(pending.map((v) => [v.key, v.size]));
  const shaped = (v: PlannedVideo): VideoPick => ({ key: v.key, shape: v.shape, size: v.photoIds.length, category: v.category, photoIds: v.photoIds });
  if (over) {
    const picks = result.videos.map(shaped);
    const missing = picks.reduce((sum, p) => sum + Math.max(0, (asked.get(p.key) ?? p.size) - p.size), 0) + result.dropped.reduce((sum, d) => sum + (asked.get(d.key) ?? 0), 0);
    return { picks, dropped: result.dropped.map((d) => d.key), missingPhotos: missing };
  }
  const picked = new Map(result.videos.map((v) => [v.key, v]));
  const broken = new Set<CategoryRef>();
  const picks: VideoPick[] = [];
  for (const video of pending) {
    const got = picked.get(video.key);
    if (broken.has(video.category) || got === undefined || got.photoIds.length !== video.size) {
      broken.add(video.category);
      continue;
    }
    picks.push(shaped(got));
  }
  return { picks, dropped: [], missingPhotos: 0 };
}

/**
 * A video whose photo was taken meanwhile (`PHOTO_UNAVAILABLE`, §5.4): another free photo of its category, from what the launch has left or the library pool; its own photos are among the
 * candidates when they are still free. A video that finds none degrades or is dropped. The caller has already checked that no pending intent holds the photo (L1).
 */
export function repick(file: LaunchFile, avatarId: string, key: string, facts: AvatarFacts, held: ReadonlySet<string>): PickOutcome {
  if (!facts.ready) return EMPTY;
  const row = rowOf(file, avatarId);
  const video = row.find((v) => v.key === key);
  if (video === undefined) return EMPTY;
  const free = candidates(file, facts, held, takenPhotos(row, key));
  const result = assignGenerated([{ ...plannedOf(video), photoIds: [] }], free);
  const picks: VideoPick[] = result.videos.map((v) => ({ key: v.key, shape: v.shape, size: v.photoIds.length, category: v.category, photoIds: v.photoIds }));
  const missing = picks.reduce((sum, p) => sum + Math.max(0, video.size - p.size), 0) + (result.dropped.length > 0 ? video.size : 0);
  return { picks, dropped: result.dropped.map((d) => d.key), missingPhotos: missing };
}
