// A child process for processGuards.test.ts: installs the engine's guards, then raises the error named in argv[2].
// The message carries a fake path and key, which must never reach the log line.
import { installProcessGuards } from "../processGuards";

const SECRET = "/Users/owner/library/photo.jpg Zq7-fake-key-M4xk-91Bd-NotReal";

installProcessGuards({ on: (event, listener) => { process.on(event, listener); }, role: "engine", log: console.error, exit: (code) => process.exit(code) });

const mode = process.argv[2];
if (mode === "reject") {
  void Promise.reject(new Error(SECRET));
  // The process must still be alive after the rejection has been reported.
  setTimeout(() => {
    console.log("still running");
    process.exit(0);
  }, 150);
} else if (mode === "throw") {
  setTimeout(() => {
    throw Object.assign(new TypeError(SECRET), { code: "ERR_SOMETHING" });
  }, 10);
  // Never reached if the guard exits the process, as it must.
  setTimeout(() => {
    console.log("still running");
    process.exit(0);
  }, 3_000);
} else {
  throw new Error(`unknown mode ${String(mode)}`);
}
