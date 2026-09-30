// What Studio's two long-running processes do about an error nobody caught. Neither had a handler: in the engine
// utilityProcess an unhandled rejection ended the process with Node's default (a crash with the error printed, message
// and stack included, which can carry a library path or a key fragment) and in main Electron would open a dialog for an
// uncaught exception in the middle of a render.
//
//   unhandledRejection   logged by kind (and Node's error code), the process keeps running: a promise nobody awaited is a
//                        bug worth a log line, not worth the engine's in-memory state or a running render. The engine also
//                        raises an `engine-internal-error` notice (a count, no text) so the windows are not left in the dark;
//                        money stays protected by the ledger's own halt, whatever the rejected work was.
//   uncaughtException    in the ENGINE: logged, then the process exits with 1. Its state is unknown after an exception
//                        thrown outside every handler, and main already restarts a crashed engine once (engineHost.ts),
//                        tells the windows, and fails every waiting command. In MAIN: logged and ignored, so no dialog
//                        appears; main holds no money state, and quitting on it would take the windows and the engine down.
//
// A log line never carries the error's message or stack: they may contain the owner's paths or a key. Only the error's
// class name and its `code` (ENOENT, ERR_...), when that is a plain token.

export type ProcessRole = "engine" | "main";

interface ProcessGuardBase {
  /** Registers a listener for one of the two events: `process.on`, or a test's emitter. The engine entry may touch only a few members of `process` (runtime.test.ts), so it passes the call, not the object. */
  on: (event: "unhandledRejection" | "uncaughtException", listener: (error: unknown) => void) => unknown;
  /** One line per event; it cannot fail the handler (a throwing log is swallowed). */
  log: (line: string) => void;
  /** Called after a swallowed rejection is logged, so the windows can be told (a code and a count, never the error). A throw is swallowed like the log's. */
  onRejection?: () => void;
}

/** The engine ends its own process on an uncaught exception; main never does, so it is given no way to. */
export type ProcessGuardOptions = ProcessGuardBase & ({ role: "engine"; exit: (code: number) => void } | { role: "main" });

const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,40}$/;

/** `TypeError` or `Error (ENOENT)`: the error's class and its code when it is a plain token, never its text. */
export function describeError(error: unknown): string {
  try {
    if (!(error instanceof Error)) return typeof error;
    const name = /^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(error.name) ? error.name : "Error";
    const code: unknown = "code" in error ? error.code : undefined;
    return typeof code === "string" && CODE_TOKEN.test(code) ? `${name} (${code})` : name;
  } catch {
    // A getter on `name` or `code` that throws (a hostile or broken error object) must not fail the handler that reports it.
    return "unknown";
  }
}

/** Installs the policy above; call it once, first thing in the process. */
export function installProcessGuards(options: ProcessGuardOptions): void {
  const say = (line: string): void => {
    try {
      options.log(line);
    } catch {
      // A broken log must not turn a handled error into another one.
    }
  };
  options.on("unhandledRejection", (reason) => {
    say(`studio ${options.role}: an unhandled promise rejection (${describeError(reason)}); the ${options.role} keeps running`);
    try {
      options.onRejection?.();
    } catch {
      // Telling the windows must not turn a handled rejection into another error.
    }
  });
  options.on("uncaughtException", (error) => {
    if (options.role === "engine") {
      say(`studio engine: an uncaught exception (${describeError(error)}); the engine exits so main restarts it`);
      options.exit(1);
      return;
    }
    say(`studio main: an uncaught exception (${describeError(error)}); main keeps running`);
  });
}
