import type { Cue, Gaze, Hairstyle } from "./types";

// The gaze, the cue and the hairstyle banks (plan s5a2 r1.2 §5.1-§5.3). Every text at most POOL_TEXT_MAX characters.
//
// K-2: a gaze never names a camera or a lens. A selfie gaze says «the viewer» (the words «selfie» and «front camera» draw a phone, C1); only a mirror
// gaze names her phone, as her phone in the mirror. The flirty items (level «flirty», 5a.2b) are drawn only on a flirty slot.
export const GAZE: readonly Gaze[] = [
  { text: "looking straight at the viewer", kind: "viewer" },
  { text: "glancing at the viewer", kind: "viewer" },
  { text: "looking at the viewer for a second", kind: "viewer" },
  { text: "looking off to the side", kind: "away" },
  { text: "glancing off to one side", kind: "away" },
  { text: "looking at something nearby", kind: "away" },
  { text: "her eyes on something far off", kind: "away" },
  { text: "looking down for a moment", kind: "down" },
  { text: "glancing down", kind: "down" },
  { text: "her eyes lowered", kind: "down" },
  { text: "her eyes on what her hands do", kind: "hands" },
  { text: "eyes on her hands", kind: "hands" },
  { text: "her eyes on her phone in the mirror", kind: "mirror", phone: true },
  { text: "checking her reflection", kind: "mirror" },
  { text: "looking at her reflection", kind: "mirror" },
  { text: "giving the viewer a playful look", kind: "viewer", level: "flirty" },
  { text: "looking up at the viewer", kind: "viewer", level: "flirty" },
];

// C1: one unsmiling expression at least. Never sexy, seductive, sultry (validated). «Дом»'s close selfies from above and the prone selfie add their
// own ordinary cues (the owner: «обычный домашний контент»).
export const CUES: readonly Cue[] = [
  { text: "a relaxed smile" },
  { text: "mid-laugh" },
  { text: "a small, easy smile" },
  { text: "a calm, neutral face" },
  { text: "a slight squint" },
  { text: "a half-smile" },
  { text: "a thoughtful face" },
  { text: "a wide, easy grin" },
  { text: "a quiet smile" },
  { text: "a slight pout", captures: ["above", "prone"] },
  { text: "a finger near her lips", captures: ["above", "prone"] },
  { text: "her hand at her cheek", captures: ["above", "prone"] },
  { text: "a slow smile", level: "flirty" },
  { text: "a small smirk", level: "flirty" },
  { text: "one eyebrow raised", level: "flirty" },
  { text: "a teasing half-smile", level: "flirty" },
];

const ALL = ["bob", "shoulder", "long"] as const;
const SHOULDER_UP = ["shoulder", "long"] as const;

// §5.3: by hair length (a bob's styles fit longer hair too). No pigtails, two braids or space buns (I5.29). A tied style goes only to a `tied`
// moment, at most 1 in 4 of a run (probe P-5a2; hair.ts). «half up in a tiny clip» became «half up in a small clip»: «tiny» is a youth word.
export const HAIRSTYLES: readonly Hairstyle[] = [
  { text: "tucked behind her ears", lengths: ALL, tied: false },
  { text: "blow-dried smooth", lengths: ALL, tied: false },
  { text: "a little tousled", lengths: ALL, tied: false },
  { text: "pinned back with a small claw clip", lengths: ALL, tied: true },
  { text: "half up in a small clip", lengths: ALL, tied: true },
  { text: "blow-dried straight and worn loose", lengths: SHOULDER_UP, tied: false },
  { text: "half up, half down", lengths: SHOULDER_UP, tied: true },
  { text: "in a low ponytail", lengths: SHOULDER_UP, tied: true },
  { text: "in a high ponytail", lengths: SHOULDER_UP, tied: true },
  { text: "twisted up in a claw clip", lengths: SHOULDER_UP, tied: true },
  { text: "in a messy bun", lengths: SHOULDER_UP, tied: true },
  { text: "in a sleek low bun", lengths: SHOULDER_UP, tied: true },
  { text: "in a loose side braid", lengths: ["long"], tied: true },
  { text: "in a long high ponytail", lengths: ["long"], tied: true },
  { text: "in a messy top bun", lengths: ["long"], tied: true },
  { text: "loose under a baseball cap", lengths: ALL, tied: false, cap: true },
];
