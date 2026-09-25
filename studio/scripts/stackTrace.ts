// Tells apart an app's clean, one-line messages from an uncaught exception's
// stack trace in captured process output. Used by smoke-engine.ts's
// production check to confirm the remote-debugging refusal (studio/main/main.ts)
// never degrades into a crash: a launch it refuses must print one line back,
// not leak an internal stack.

/** True when `output` contains a JS stack trace frame or an unhandled-error marker. */
export function looksLikeAStackTrace(output: string): boolean {
  return /\bat \S+ \(|\bUncaught\b|\bunhandledRejection\b/.test(output);
}
