import { boldLevelNeeded, legsNeedsBuiltIn, type SceneLevel, type SceneReason } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";

// CS.7: a scene-set command's own VALIDATION always says why, as a closed code (`EngineError.sceneReason`) and, when the refusal is about one scene, which
// scene (`sceneId`). The English `detail` stays for the log and for a human reading a trace; no window reads it.

/** The `sceneReason` (and `sceneId`, when there is one) of a refusal, ready to spread into an EngineError. */
export function reasonFields(sceneReason: SceneReason, sceneId?: number): { sceneReason: SceneReason; sceneId?: number } {
  return sceneId === undefined ? { sceneReason } : { sceneReason, sceneId };
}

/**
 * «Ножки» (S5.8a, I5.29): legs are drawn from the built-in banks only. A request that asks for a share above 0 and names no built-in category is refused, for free and
 * before anything is priced, reserved or written, with `legs-built-in-only`.
 */
export function assertLegsFit(request: { categories: readonly string[]; legsShare?: number | undefined }): void {
  if (legsNeedsBuiltIn(request)) throw sceneRefusal("«Ножки» are drawn from the built-in categories only; the request names none", "legs-built-in-only");
}

/**
 * «Смелая» categories (5a.3, S5.9c, I5.42): «Ночнушки и бельё» and «Пляж и бассейн» are drawn only under «Подача: Смелая». A request that names one at another level is refused,
 * for free and before anything is priced, reserved or written, with `bold-level-needed`.
 */
export function assertBoldFit(request: { categories: readonly string[]; level?: SceneLevel | undefined }): void {
  if (boldLevelNeeded(request)) throw sceneRefusal("«Ночнушки и бельё» and «Пляж и бассейн» are drawn at the «Смелая» level only; the request names one at another level", "bold-level-needed");
}

/** A VALIDATION that names its reason. */
export function sceneRefusal(detail: string, sceneReason: SceneReason, sceneId?: number): EngineFailure {
  return new EngineFailure({ code: "VALIDATION", detail, ...reasonFields(sceneReason, sceneId) });
}
