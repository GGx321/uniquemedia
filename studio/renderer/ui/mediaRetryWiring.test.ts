import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Round 2, L-2: every element that loads from `studio-media://` goes through the ONE retry hook, none keeps a one-strike `onError`, and the video cards' posters
// and covers are lazy, so a long list does not queue every poster ahead of the video the owner is playing (the protocol has two disk slots).

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const COMPONENTS = ["./Portrait.tsx", "../screens/photos/PhotoViewer.tsx", "../screens/photos/VideoPlayer.tsx", "../screens/photos/VideoCards.tsx"] as const;

test.each(COMPONENTS.map((path) => [path] as const))("%s uses useMediaRetry and keeps no one-strike onError", (path) => {
  const source = read(path);
  expect(source).toContain("useMediaRetry(");
  expect(source).not.toMatch(/onError=\{\(\) => set\w*\(/);
});

test("the video cards' poster and cover images are lazy", () => {
  const source = read("../screens/photos/VideoCards.tsx");
  expect(source).toMatch(/<img key=\{retry\.key\} className="video-poster-img"[^>]*loading="lazy"/);
  expect(source).toMatch(/<img key=\{retry\.key\} className="video-cover"[^>]*loading="lazy"/);
});
