import type * as nodePath from "node:path";

/**
 * The path flavour a rule runs on: the platform's own (`node:path`) unless a test plays another
 * (`path.win32` on macOS, `path.posix` on Windows). Taking it as a dependency is what lets Windows'
 * `\`, drive letters and UNC names be tested on any OS.
 */
export type PathFlavour = Pick<typeof nodePath.posix, "join" | "dirname" | "basename" | "normalize" | "isAbsolute" | "sep">;
