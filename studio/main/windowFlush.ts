// Before quitting, main asks every window to save what its owner is editing, and waits for each to answer (3d.2
// review, HIGH 2: the montage editor's autosave waits for a quiet spell, and Cmd+Q inside it must not lose the
// edit). Each ask has its own id, so only the answer to that ask counts; the bound on the whole wait is the quit
// flow's (quitFlow.ts), so a window that never answers cannot keep the app open.

/** One window as the flush sees it: `send` delivers the ask (the preload answers with its id). */
export interface FlushTarget {
  send(id: string): void;
  isDestroyed(): boolean;
}

export interface WindowFlush {
  /** Asks every open window to save; resolves once each of them answered. */
  request(): Promise<void>;
  /** A window's answer, from IPC: anything but the id of an open ask is ignored. */
  acknowledge(id: unknown): void;
}

export function createWindowFlush(deps: { targets: () => readonly FlushTarget[]; newId: () => string }): WindowFlush {
  const waiting = new Map<string, () => void>();
  return {
    request() {
      const answers: Promise<void>[] = [];
      for (const target of deps.targets()) {
        if (target.isDestroyed()) continue;
        const id = deps.newId();
        const answered = new Promise<void>((resolve) => waiting.set(id, resolve));
        try {
          target.send(id);
        } catch {
          // The window went away between the check and the send: nothing to wait for.
          waiting.delete(id);
          continue;
        }
        answers.push(answered);
      }
      return Promise.all(answers).then(() => undefined);
    },
    acknowledge(id) {
      if (typeof id !== "string") return;
      const resolve = waiting.get(id);
      if (resolve === undefined) return;
      waiting.delete(id);
      resolve();
    },
  };
}
