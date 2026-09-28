import { useEffect, useRef } from "react";

/** "фото" does not decline: one form for every count. */
export const PHOTO_FORMS = ["фото", "фото", "фото"] as const;

/**
 * The engine's face-gate retry line (engine/face/config.ts's
 * `defaultFaceGateConfig`, identity threshold). It is not in the contract, so
 * it is repeated here only to flag a stored photo that fell under it; keep the
 * two in step.
 */
export const FACE_GATE_THRESHOLD = 0.55;

/**
 * The one-attempt fallback image model on a moderation refusal
 * (engine/runs/plan.ts's `FALLBACK_IMAGE_MODEL`), copied here (L3) only to
 * describe the shot caption right: `runRoute` sends `quality: "low"` for the
 * settings' own image model, but `quality: null` when that model already is
 * this fallback (no lower quality to ask a fallback for). Not in the
 * contract, so it is not sent anywhere — only compared against
 * `settings.imageModel` to decide whether "low" belongs in the caption.
 */
export const SEEDREAM_FALLBACK_IMAGE_MODEL = "bytedance-seed/seedream-5-0-pro";

/** False once the component is gone: a paid step already under way must not set state on it. */
export function useMounted(): { readonly current: boolean } {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
