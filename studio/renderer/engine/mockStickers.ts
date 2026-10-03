import { stickerById, type StickerCategoryId } from "../../shared/stickers/manifest";

// The dev mock's stand-in for a built-in sticker's picture (3d.3b): the dev build has no `studio-media://sticker/<id>`, so
// the mock client hands a small SVG data URL instead, a sparkle in the colour of the sticker's category. Not the
// sticker: never design on its look (the real one is an APNG from the generated set, 3b.5).

const CATEGORY_COLOURS: Record<StickerCategoryId, string> = {
  love: "#ff6b8b",
  sparkle: "#ffd166",
  mood: "#ff9a52",
  nature: "#7fd6ff",
  party: "#c58bff",
  abstract: "#8fb0ff",
  pointer: "#4fe0b0",
};

/** A data URL standing in for built-in sticker `stickerId`, or null when the set does not have it. */
export function mockStickerUrl(stickerId: string): string | null {
  const sticker = stickerById(stickerId);
  if (sticker === undefined) return null;
  const colour = CATEGORY_COLOURS[sticker.category];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z" fill="${colour}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
