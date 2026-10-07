import { createContext, useContext } from "react";
import type { RunForm } from "./runForm";

// CS.7 L4: the run's form on each avatar's Photos screen — how many photos, which categories (a category made here comes «уже включена в запуск»), which
// poses — kept by the window while it runs, as the montage picks are (picks.ts). The screen unmounts on any navigation (a look at Settings, where the
// review itself sends the owner: «Перейти к сверке», the models), and the form must not go with it. One per window (App provides it), never saved: a new
// window starts from the defaults.

export class RunForms {
  readonly #forms = new Map<string, RunForm>();

  /** The form last left on `avatarId`'s screen, or null when it was never changed in this window. */
  get(avatarId: string): RunForm | null {
    return this.#forms.get(avatarId) ?? null;
  }

  set(avatarId: string, form: RunForm): void {
    this.#forms.set(avatarId, form);
  }

  /** Forgets every avatar's form: the library was switched, its avatars and categories are another library's. */
  clear(): void {
    this.#forms.clear();
  }
}

const RunFormsContext = createContext<RunForms | null>(null);

export const RunFormsProvider = RunFormsContext.Provider;

export function useRunForms(): RunForms {
  const forms = useContext(RunFormsContext);
  if (!forms) throw new Error("useRunForms must be used inside <RunFormsProvider>");
  return forms;
}
