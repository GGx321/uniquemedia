import { expect, test } from "bun:test";
import { readWriterScenes } from "./writer";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// The full sweep of our own templates through the writer's reader runs nightly (template.coherence.heavy.test.ts, test diet B3). These two
// negative controls stay on every push: they prove the reader's gates are live (a gaze at the viewer from behind, a phone named in a selfie).
test("the reader's gates are live (negative controls)", () => {
  const viewerFromBehind = "On a park path, she walks along the path, wearing a denim jacket and jeans, looking straight at the viewer.";
  expect(readWriterScenes([{ slotIndex: 1, sentence: viewerFromBehind }], [{ slotIndex: 1, shot: "friend", pose: "back" }]).ok).toBe(false);
  const phoneInSelfie = "On her bed, she laughs at something on her phone, wearing silk pajamas.";
  expect(readWriterScenes([{ slotIndex: 1, sentence: phoneInSelfie }], [{ slotIndex: 1, shot: "selfie", pose: "front" }]).ok).toBe(false);
});
