// The large-screen audit (H2): the import takes a photo of any size (only a maximum is enforced), and a small one makes a master
// portrait that is soft in every card and a weak reference for every photo run. The import screen advises against it next to the
// picked size. Advice only: the engine has no floor and the import goes ahead (the owner's rule: no new gates).

/** Under this many pixels on its short side, a picked photo gets the advice. */
export const IMPORT_SMALL_SHORT_SIDE = 768;
/** What the advice recommends instead, on the short side. */
export const IMPORT_GOOD_SHORT_SIDE = 1024;

/** Whether a picked photo is small enough to advise against. A size that is not known (zero, negative, not finite) gets no advice. */
export function isSmallImportPhoto(size: { readonly width: number; readonly height: number }): boolean {
  const known = (side: number): boolean => Number.isFinite(side) && side > 0;
  if (!known(size.width) || !known(size.height)) return false;
  return Math.min(size.width, size.height) < IMPORT_SMALL_SHORT_SIDE;
}
