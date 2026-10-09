import type { AvatarUsage } from "../../shared/engine/state";
import type { PhotoState } from "../library/eligibility";
import type { PhotoSidecar } from "../library/schemas";
import type { PlanAvatarInput, PlanPhoto } from "./planner";

// Reads one avatar out of the library into the planner's plain input. The narrow `LibraryReads` is what the planner needs of `Library`, so a test can
// stand in for it and the real class satisfies it structurally.

export interface LibraryReads {
  photosByAvatar(avatarId: string): PhotoSidecar[];
  photoStates(avatarId: string): Map<string, PhotoState>;
  /** Empty exactly when the avatar's usage can be trusted (`Library.usageReasons`). */
  usageReasons(avatarId: string): AvatarUsageReason[];
}

type AvatarUsageReason = Extract<AvatarUsage, { state: "unknown" }>["reasons"][number];

export function planAvatarInput(library: LibraryReads, avatarId: string, hasOpenSet: boolean): PlanAvatarInput {
  const reasons = library.usageReasons(avatarId);
  const usage: AvatarUsage = reasons.length === 0 ? { state: "ok" } : { state: "unknown", reasons };
  const states = library.photoStates(avatarId);
  const photos: PlanPhoto[] = library.photosByAvatar(avatarId).map((sidecar) => {
    const state = states.get(sidecar.id);
    return {
      id: sidecar.id,
      avatarId: sidecar.avatarId,
      category: sidecar.source.kind === "generated" ? sidecar.source.category : undefined,
      pdq: sidecar.qa.pdq,
      faceCos: sidecar.qa.faceCos,
      // A photo the library has no verdict on is not eligible: fail closed.
      eligible: state?.eligible ?? false,
      rejected: state?.rejected ?? true,
      reserved: state?.reserved ?? true,
      usedIn: state?.usedIn ?? [],
    };
  });
  return { avatarId, usage, hasOpenSet, photos };
}
