import { createContext, useContext } from "react";
import { realScheduler, type Scheduler } from "../../engine/scheduler";

// The clock of the photo lists' re-read wait (`usePhotoPages`). One per window: App provides it, and the real timers are the default, so a
// screen mounted without a provider behaves as it always did. A test gives App a manual one and drives the wait itself.

const PagesSchedulerContext = createContext<Scheduler>(realScheduler);

export const PagesSchedulerProvider = PagesSchedulerContext.Provider;

export function usePagesScheduler(): Scheduler {
  return useContext(PagesSchedulerContext);
}
