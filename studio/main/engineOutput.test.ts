import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { forwardEngineOutput } from "./engineOutput";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

function sink(): { write(chunk: string | Uint8Array): unknown; text(): string } {
  const chunks: string[] = [];
  return { write: (c) => chunks.push(typeof c === "string" ? c : Buffer.from(c).toString("utf8")), text: () => chunks.join("") };
}

test("copies the engine's stdout to main's stdout and its stderr to main's stderr", () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const out = sink();
  const err = sink();
  forwardEngineOutput(child, out, err);
  child.stdout.write("studio engine: hello\n");
  child.stderr.write("studio engine: oops\n");
  expect(out.text()).toBe("studio engine: hello\n");
  expect(err.text()).toBe("studio engine: oops\n");
});

test("keeps draining a stream with no reader waiting, so the engine can never block on a full pipe", () => {
  const child = { stdout: new PassThrough(), stderr: new PassThrough() };
  const out = sink();
  forwardEngineOutput(child, out, sink());
  for (let i = 0; i < 2_000; i++) child.stdout.write("x".repeat(1_000));
  expect(out.text().length).toBe(2_000_000);
});

test("does nothing, and does not throw, for a child that has no output streams", () => {
  expect(() => forwardEngineOutput({ stdout: null, stderr: null }, sink(), sink())).not.toThrow();
});
