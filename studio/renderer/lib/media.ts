import { Id } from "../../shared/engine";

/**
 * The only way the UI addresses a library image (invariant 12): by id, through
 * main's `studio-media://` protocol. Null for ids that break the contract.
 */
export function photoUrl(avatarId: string, photoId: string): string | null {
  if (!Id.safeParse(avatarId).success || !Id.safeParse(photoId).success) return null;
  return `studio-media://photo/${avatarId}/${photoId}`;
}

// Neutral placeholder gradients (warm and cool greys, as in the mockup) for
// the mock engine, which has no real images.
const PLACEHOLDERS = [
  ["#eadfd0", "#c4ab90"],
  ["#ddd3da", "#9a8796"],
  ["#d7dee4", "#8c9dab"],
  ["#e6d8c5", "#ad8d69"],
  ["#dee1d3", "#97a087"],
  ["#dad1db", "#8b778f"],
  ["#e8dbd1", "#b58e7b"],
  ["#d5dce1", "#7c90a0"],
] as const;

/** A stable gradient per id, so the same placeholder shows everywhere. */
export function placeholderGradient(seed: string): string {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  const [from, to] = PLACEHOLDERS[hash % PLACEHOLDERS.length] ?? PLACEHOLDERS[0];
  return `linear-gradient(170deg, ${from} 0%, ${to} 100%)`;
}
