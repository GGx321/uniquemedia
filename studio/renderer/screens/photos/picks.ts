import { createContext, useContext } from "react";

// Slice review 5-L3: the photos the owner picked on an avatar's Photos screen for «Монтаж из выбранных», kept by the window while it runs, per
// avatar and in the order picked. The screen unmounts on any navigation (a look at Settings, the editor and back); the picks must not go with it.
// A draft made of them clears them. One per window (App provides it), never saved: a new window starts with none.

export class MontagePicks {
  readonly #picked = new Map<string, readonly string[]>();

  /** The photos picked for `avatarId`, in the order they were picked. */
  get(avatarId: string): ReadonlySet<string> {
    return new Set(this.#picked.get(avatarId) ?? []);
  }

  /** The picks of `avatarId` are now `picked` (none: forgotten). */
  set(avatarId: string, picked: ReadonlySet<string>): void {
    if (picked.size === 0) this.#picked.delete(avatarId);
    else this.#picked.set(avatarId, [...picked]);
  }
}

const MontagePicksContext = createContext<MontagePicks | null>(null);

export const MontagePicksProvider = MontagePicksContext.Provider;

export function useMontagePicks(): MontagePicks {
  const picks = useContext(MontagePicksContext);
  if (!picks) throw new Error("useMontagePicks must be used inside <MontagePicksProvider>");
  return picks;
}
