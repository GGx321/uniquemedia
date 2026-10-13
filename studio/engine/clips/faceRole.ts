/**
 * Whether a clip's face is judged (I5.52): `judged` only when the photo itself was judged by the gate; `profile` (a profile photo) and `hidden` (a marked photo: mirror-hidden, pov-legs, back,
 * low-feet, a legs framing) are skipped, and say why. V5's `frameFacts.ts` computes the role; V4b's `faceCheck.ts` takes it as an argument and never derives it. One type, here, for both.
 */
export type ClipFaceRole = "judged" | "profile" | "hidden";
