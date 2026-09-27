import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FACE_MODELS, verifyModelBytes } from "./modelSource";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

test("both models declare a pinned https URL and a 64-character lowercase hex sha256", () => {
  for (const model of Object.values(FACE_MODELS)) {
    expect(model.url).toMatch(/^https:\/\//);
    expect(model.sha256).toMatch(/^[0-9a-f]{64}$/);
  }
});

test("both URLs are pinned to a specific opencv_zoo commit, not a moving branch like main", () => {
  // Review fix (2c): the sha256 already guards against a corrupted or
  // substituted download, but a URL pointing at `main` still means the next
  // fetch could 404 or serve a different file if history is rewritten —
  // pin the ref itself too.
  for (const model of Object.values(FACE_MODELS)) {
    expect(model.url).toMatch(/^https:\/\/github\.com\/opencv\/opencv_zoo\/raw\/[0-9a-f]{40}\//);
  }
});

test("verifyModelBytes accepts bytes matching the pinned hash", () => {
  const bytes = new TextEncoder().encode("hello");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  expect(() => verifyModelBytes(bytes, sha256, "test-model")).not.toThrow();
});

test("verifyModelBytes throws a clear, named error when the hash does not match", () => {
  const bytes = new TextEncoder().encode("hello");
  const wrongHash = createHash("sha256").update(new TextEncoder().encode("goodbye")).digest("hex");
  expect(() => verifyModelBytes(bytes, wrongHash, "yunet")).toThrow(/yunet/);
});
