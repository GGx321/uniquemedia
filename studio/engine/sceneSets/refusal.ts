import type { SceneReason } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";

// CS.7: a scene-set command's own VALIDATION always says why, as a closed code (`EngineError.sceneReason`) and, when the refusal is about one scene, which
// scene (`sceneId`). The English `detail` stays for the log and for a human reading a trace; no window reads it.

/** The `sceneReason` (and `sceneId`, when there is one) of a refusal, ready to spread into an EngineError. */
export function reasonFields(sceneReason: SceneReason, sceneId?: number): { sceneReason: SceneReason; sceneId?: number } {
  return sceneId === undefined ? { sceneReason } : { sceneReason, sceneId };
}

/** A VALIDATION that names its reason. */
export function sceneRefusal(detail: string, sceneReason: SceneReason, sceneId?: number): EngineFailure {
  return new EngineFailure({ code: "VALIDATION", detail, ...reasonFields(sceneReason, sceneId) });
}
