import type { PoolShot } from "../../engine";

/** Every category but Photoshoot: 2 friend, 1 selfie, 1 mirror, 1 candid (engine/scenes/pools.ts, kept). */
export const DEFAULT_SHOT_DECK: readonly PoolShot[] = ["friend", "selfie", "mirror", "candid", "friend"];

/** Photoshoot's own deck: 3 photographer, 2 candid (kept). */
export const PHOTOSHOOT_SHOT_DECK: readonly PoolShot[] = ["photographer", "photographer", "photographer", "candid", "candid"];
