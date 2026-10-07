import { isPhoneInHandShot, type Pose } from "./schema";
import { rngPick, type Rng } from "./rngUtil";
import type { Shot } from "./types";

// T5c: the pose draw. Owner decision (2026-09-27): every slot now carries a
// pose (front, three-quarter, profile, back). A selfie or mirror shot always
// faces the camera (front or three-quarter only — schema.ts's own refine
// pins this too, as a second, independent enforcement). Every other shot may
// also draw profile or back, but only when the run's settings allow it; front
// and three-quarter are always allowed. The draw itself is a weighted mix
// (POSE_WEIGHTS below), mostly front/three-quarter with profile/back at a
// modest share, using its own rng stream (planner.ts's poseSeed) so adding
// pose can never perturb the existing location/outfit/shot draws for the
// same seed.

/** Which poses beyond front/three-quarter this run allows (owner decision,
 *  2026-09-27); front and three-quarter are always allowed and are never
 *  gated here. */
export interface PoseAllowance {
  profile: boolean;
  back: boolean;
}

/** The default when a caller gives no pose allowance at all: every shot draws only front/three-quarter. */
export const NO_EXTRA_POSES: PoseAllowance = { profile: false, back: false };

/**
 * The pose draw's weighted mix (T5c, owner decision 2026-09-27): mostly
 * front and three-quarter, profile and back only at a modest share, and only
 * when the run's settings allow them (poses.test.ts pins the actual
 * proportions this produces). Plain integer weights — the deck below is
 * built by simple repetition, so there is no floating-point rounding to get
 * wrong. The one place these numbers live: buildDeck below is the only
 * reader.
 */
export const POSE_WEIGHTS: Record<Pose, number> = {
  front: 5,
  "three-quarter": 5,
  profile: 1,
  back: 1,
};

function repeated(pose: Pose, times: number): Pose[] {
  return Array.from({ length: times }, () => pose);
}

/** front/three-quarter only, at their configured weights — every selfie/mirror shot's deck, and the base of every other shot's. */
const FRONT_ONLY_DECK: readonly Pose[] = [...repeated("front", POSE_WEIGHTS.front), ...repeated("three-quarter", POSE_WEIGHTS["three-quarter"])];

/** The weighted pool `drawPose` samples from for a shot that is not phone-in-hand: front/three-quarter always, profile/back added only when `allowed` says so. Never empty. */
function fullDeck(allowed: PoseAllowance): readonly Pose[] {
  return [
    ...FRONT_ONLY_DECK,
    ...(allowed.profile ? repeated("profile", POSE_WEIGHTS.profile) : []),
    ...(allowed.back ? repeated("back", POSE_WEIGHTS.back) : []),
  ];
}

/**
 * Draws one slot's pose. A selfie or mirror shot always draws front or
 * three-quarter (one hand holds the phone, so the shot cannot look "from
 * behind" or "in profile" either) — this is the planner's own enforcement of
 * the shot -> pose constraint, alongside schema.ts's refine on the slot
 * itself. Every other shot draws from the full weighted mix, profile/back
 * included only when `allowed` says so.
 */
export function drawPose(rng: Rng, shot: Shot, allowed: PoseAllowance): Pose {
  return rngPick(rng, isPhoneInHandShot(shot) ? FRONT_ONLY_DECK : fullDeck(allowed));
}

/**
 * The shot a back or profile slot takes when the shot it drew has a phone in hand and the category's deck has no other: nobody holds a phone for a friend. Never the
 * photographer: a deck with no non-phone shot has no photographers either, so its category is finished as a phone photo, and a photographer shot would contradict it.
 */
export const FALLBACK_SHOT: Shot = "friend";

/**
 * CS.8a: one slot's pose and shot for a custom category whose description named its angles. The pose is drawn uniformly from the category's own list (the run's
 * toggles are not asked: the angle is the owner's description, not the run's setting). A selfie or a mirror shot cannot face away or sideways, so when the pose
 * drawn is back or profile and the shot has a phone in hand, the slot takes one of the deck's other shots instead (drawn from the same stream, so nothing else
 * moves), or a friend when the deck holds none. A pose the phone allows leaves the shot as it was. Never returns a phone-in-hand shot with back or profile.
 */
export function drawFromPoses(rng: Rng, shot: Shot, poses: readonly Pose[], deck: readonly Shot[]): { pose: Pose; shot: Shot } {
  const pose = rngPick(rng, poses);
  if (!isPhoneInHandShot(shot) || pose === "front" || pose === "three-quarter") return { pose, shot };
  const others = deck.filter((candidate) => !isPhoneInHandShot(candidate));
  return { pose, shot: others.length === 0 ? FALLBACK_SHOT : rngPick(rng, others) };
}
