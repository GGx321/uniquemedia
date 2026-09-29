/** The part of a readable stream that is used (Electron types the utilityProcess streams as a plain `ReadableStream`). */
export interface DataSource {
  on(event: "data", listener: (chunk: string | Uint8Array) => void): unknown;
}

/** What `forwardEngineOutput` writes to: `process.stdout` and `process.stderr` in main. */
export interface OutputSink {
  write(chunk: string | Uint8Array): unknown;
}

/**
 * Copies the engine utilityProcess's stdout and stderr into main's own. The engine is forked with `stdio: "pipe"`
 * rather than the default `"inherit"`: on Windows the inherited stream did not reach whoever launched the app (the
 * packaged smoke saw nothing the engine printed, neither the text rasteriser's ready line nor a load error), while
 * main's own stdout does reach it, so main relays. A piped stream must be drained, or the engine would block on a
 * full pipe: the `data` listeners drain it for as long as the engine lives.
 */
export function forwardEngineOutput(child: { stdout: DataSource | null; stderr: DataSource | null }, out: OutputSink, err: OutputSink): void {
  child.stdout?.on("data", (chunk: string | Uint8Array) => out.write(chunk));
  child.stderr?.on("data", (chunk: string | Uint8Array) => err.write(chunk));
}
