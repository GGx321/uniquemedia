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
