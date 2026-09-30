// Before quitting, main asks every window to save what its owner is editing, and waits for each to answer whether it
// did (3d.2 review, HIGH 2, and its re-review: the montage editor's autosave waits for a quiet spell, and Cmd+Q inside
// it must not lose the edit; a window that could not save refuses the quit instead of losing it silently). Each ask
// has its own id, so only the answer to that ask counts, and the wait is bounded: a window that never answers cannot
// keep the app open, and its ask is forgotten.

/** One window as the flush sees it: `send` delivers the ask (the preload answers `{id, ok}`). */
export interface FlushTarget {
  send(id: string): void;
  /** Closed, or its renderer crashed: nothing there can answer. */
  isGone(): boolean;
}

/** `saved`: every window saved (or had nothing to save); `refused`: one could not; `timeout`: one did not answer in time. */
export type FlushOutcome = "saved" | "refused" | "timeout";

export interface WindowFlush {
  /** Asks every live window to save; resolves once each answered, or when the wait runs out. */
  request(): Promise<FlushOutcome>;
  /** A window's answer, from IPC: anything but `{id, ok}` for an open ask is ignored. */
  acknowledge(answer: unknown): void;
}

export interface WindowFlushDeps {
  targets: () => readonly FlushTarget[];
  newId: () => string;
  /** How long the windows get before the wait ends as `timeout`. */
  timeoutMs: number;
}

function parseAnswer(answer: unknown): { id: string; ok: boolean } | null {
  if (typeof answer !== "object" || answer === null) return null;
  const id: unknown = Reflect.get(answer, "id");
  const ok: unknown = Reflect.get(answer, "ok");
  return typeof id === "string" && typeof ok === "boolean" ? { id, ok } : null;
}

export function createWindowFlush(deps: WindowFlushDeps): WindowFlush {
  const waiting = new Map<string, (ok: boolean) => void>();
  return {
    request() {
      const asked: string[] = [];
      const answers: Promise<boolean>[] = [];
      for (const target of deps.targets()) {
        if (target.isGone()) continue;
        const id = deps.newId();
        const answered = new Promise<boolean>((resolve) => waiting.set(id, resolve));
        try {
          target.send(id);
        } catch {
          // The window went away between the check and the send: nothing to wait for.
          waiting.delete(id);
          continue;
        }
        asked.push(id);
        answers.push(answered);
      }
      const all = Promise.all(answers).then((oks): FlushOutcome => (oks.every(Boolean) ? "saved" : "refused"));
      return new Promise<FlushOutcome>((resolve) => {
        const timer = setTimeout(() => {
          for (const id of asked) waiting.delete(id);
          resolve("timeout");
        }, deps.timeoutMs);
        void all.then((outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },
    acknowledge(answer) {
      const parsed = parseAnswer(answer);
      if (parsed === null) return;
      const resolve = waiting.get(parsed.id);
      if (resolve === undefined) return;
      waiting.delete(parsed.id);
      resolve(parsed.ok);
    },
  };
}
