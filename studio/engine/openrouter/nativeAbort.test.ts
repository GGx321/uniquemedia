import { expect, test } from "bun:test";
import { join } from "node:path";

// The race in sendOnce returns promptly on abort whatever fetch does, so a
// signal that never reached fetch would go unnoticed in-process. This runs the
// client with the native fetch and AbortController (outside the test preload)
// and checks the abort really tore down the socket.
test("an abort reaches the native fetch and closes the connection", async () => {
  const script = join(import.meta.dir, "testing", "nativeAbort.ts");
  const child = Bun.spawn([process.execPath, "run", script], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  const [stdout, stderr, code] = await Promise.all([Bun.readableStreamToText(child.stdout), Bun.readableStreamToText(child.stderr), child.exited]);

  expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
  const report = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
  expect(report.nativeGlobals).toBe(true);
  expect(report.result).toEqual({ status: "aborted", ledger: { action: "left-open", worstMicros: 50_000 } });
  expect(report.socketClosed).toBe(true);
}, 15_000);
