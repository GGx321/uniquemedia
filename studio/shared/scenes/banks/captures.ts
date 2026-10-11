import type { CaptureKind, CaptureSpec } from "./types";

// How each capture kind is taken. The five stored shots are drawn today (their capture lines live in engine/scenes/phoneLook.ts). The owner's style
// references (2026-10-11) add the rest as HOOKS: a moment may already name them in `captures`, but no slot draws them until a capture line exists and
// the contract stores them. `propped`: probe P-5a2 drew an arm's-length selfie or a phone on the table in 3 of 4 frames, but the owner's «Улица»
// (2026-10-11) takes it back with a wording that works («both of her hands are empty and nobody holds a phone; her whole body is in the picture»), so it
// is a hook like the rest until plan r1.2 gives it a capture line.
export const CAPTURES: Readonly<Record<CaptureKind, CaptureSpec>> = {
  friend: { shot: "friend", handHeld: false, faceVisible: true, status: "drawn" },
  selfie: { shot: "selfie", handHeld: true, faceVisible: true, status: "drawn" },
  mirror: { shot: "mirror", handHeld: true, faceVisible: true, status: "drawn" },
  candid: { shot: "candid", handHeld: false, faceVisible: true, status: "drawn" },
  photographer: { shot: "photographer", handHeld: false, faceVisible: true, status: "drawn" },
  // A mirror selfie with the phone held in front of her face: no likeness to check (marked or skipped, like «Ножки»).
  "mirror-face-hidden": { shot: "mirror", handHeld: true, faceVisible: false, status: "hook" },
  // A close selfie from above while she lies on the bed.
  "selfie-above": { shot: "selfie", handHeld: true, faceVisible: true, status: "hook" },
  // Her own view down at her legs and feet («селфи вниз», kept by probe P-5a2 for S5.8a).
  "pov-legs": { shot: "selfie", handHeld: true, faceVisible: false, status: "hook" },
  // The phone propped on a ledge on a timer, a couple of metres away.
  propped: { shot: "friend", handHeld: false, faceVisible: true, status: "hook" },
  // Posing by an object (a car, a wall, a shop window), taken by a friend.
  "by-object": { shot: "friend", handHeld: false, faceVisible: true, status: "hook" },
};

/** The capture kinds a slot may draw today. */
export function isDrawnCapture(kind: CaptureKind): boolean {
  return CAPTURES[kind].status === "drawn";
}
