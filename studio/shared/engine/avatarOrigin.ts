import { z } from "zod";

// 5a.4 (S5.BA1, plan s5a4 I5.74, M7): where an avatar came from, and the ONE fail-closed reading of it. The engine fills `AvatarSummary.origin` (S5.BA5); every site that needs
// `TemplateContext.impliedNudity` (S5.BA3, S5.BA8) goes through `impliedNudityOf`, never through its own comparison.

/** `studio`: made in Studio from a generated candidate. `imported`: anything else (an imported photo, a `portrait-N` master). */
export const AvatarOrigin = z.enum(["studio", "imported"]);
export type AvatarOrigin = z.infer<typeof AvatarOrigin>;

/**
 * Whether an avatar may be shown an implied cover and an open coverage: only `origin === "studio"`. An absent origin, an unknown or malformed value, and an avatar that could not
 * be read at all (`null`, `undefined`) are all false, the imported side.
 */
export function impliedNudityOf(avatar: { readonly origin?: unknown } | null | undefined): boolean {
  return avatar?.origin === "studio";
}
