import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Round 2, L-2: every element that loads from `studio-media://` goes through the ONE retry hook, none keeps a one-strike `onError`, and the video cards' posters
// and covers are lazy, so a long list does not queue every poster ahead of other pictures (the library has two disk slots, mediaProtocol.ts).

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const COMPONENTS = ["./Portrait.tsx", "../screens/photos/PhotoViewer.tsx", "../screens/photos/VideoPlayer.tsx", "../screens/photos/VideoCards.tsx"] as const;

test.each(COMPONENTS.map((path) => [path] as const))("%s uses useMediaRetry, puts its key and onError on the element, and keeps no one-strike onError", (path) => {
  const source = read(path);
  expect(source).toContain("useMediaRetry(");
  // The key makes the second try a new element; the handler is what counts the failures. Either missing and the hook does nothing.
  expect(source).toMatch(/key=\{.*retry\.key/);
  expect(source).toContain("onError={retry.onError}");
  expect(source).not.toMatch(/onError=\{\(\) => set\w*\(/);
});

test("the pictures that show an alt text are not drawn while their retry waits", () => {
  expect(read("./Portrait.tsx")).toMatch(/retry\.waiting/);
  expect(read("../screens/photos/PhotoViewer.tsx")).toMatch(/retry\.waiting/);
});

test("the video cards' poster and cover images are lazy", () => {
  const source = read("../screens/photos/VideoCards.tsx");
  expect(source).toMatch(/<img key=\{retry\.key\} className="video-poster-img"[^>]*loading="lazy"/);
  expect(source).toMatch(/<img key=\{retry\.key\} className="video-cover"[^>]*loading="lazy"/);
});
