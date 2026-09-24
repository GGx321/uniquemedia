/** Every id in the library — avatars, photos, runs, videos — and every path
 *  segment built from one. No dots or separators, so an id can never walk out
 *  of the folder it names (invariant 12). */
export const LIBRARY_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

export function isLibraryId(value: string): boolean {
  return LIBRARY_ID_PATTERN.test(value);
}
