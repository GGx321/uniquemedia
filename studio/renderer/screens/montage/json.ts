/**
 * Deep equality of JSON-shaped values (a montage spec, a draft's name): objects by their own keys whatever the
 * order, arrays in order, everything else by value. The editor compares versions by content, because a spec
 * rebuilt by a spread or parsed back from the engine is a new object with the same meaning.
 */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => sameJson(item, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => Object.hasOwn(b, key) && sameJson(Reflect.get(a, key), Reflect.get(b, key)));
}
