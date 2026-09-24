import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AvatarDescriptor, Draft, type AvatarTraits } from "../../shared/engine";
import { candidatePrompt, promptSubject } from "./prompts";

const GOOD = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose.";
const DESCRIPTOR: AvatarDescriptor = { age: 25, text: GOOD };

describe("the avatar in an image prompt is her descriptor, and nothing else of the traits", () => {
  test("the candidate prompt is the spike's portrait wording around the descriptor", () => {
    expect(candidatePrompt(DESCRIPTOR)).toBe(
      "Head-and-shoulders portrait photo of a 25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, " +
        "athletic build, light freckles across the nose, looking straight at the camera with a relaxed, slight smile. Soft natural daylight, " +
        "plain light grey background. Natural skin texture, minimal makeup, smartphone photo, no retouching, no beauty filter.",
    );
  });

  test("a draft's vibe never reaches the prompt: only its descriptor goes in", () => {
    const traits: AvatarTraits = {
      age: 25, ethnicity: "european", skinTone: "light-olive", hairColor: "chestnut", hairLength: "shoulder", hairTexture: "wavy",
      eyeColor: "hazel", build: "athletic", marks: ["freckles"], vibe: "zebra lantern marmalade",
    };
    const draft = Draft.parse({ avatarId: "draft-00000001", traits, descriptor: DESCRIPTOR, candidates: [], estimate: null });

    expect(candidatePrompt(draft.descriptor)).not.toContain("zebra");
    expect(promptSubject(draft.descriptor)).toBe(GOOD.replace(/\.$/, ""));
  });

  test.each([
    ["a descriptor stored before a stricter rule", "25-year-old European woman with a youthful smile."],
    ["another age", "25-year-old European woman who looks 17."],
  ])("%s is refused before any prompt is built", (_label, text) => {
    expect(() => promptSubject({ age: 25, text })).toThrow("descriptor");
    expect(() => candidatePrompt({ age: 25, text })).toThrow("descriptor");
  });

  test("the prompt builders take the descriptor alone", () => {
    expect([candidatePrompt.length, promptSubject.length]).toEqual([1, 1]);
  });
});

// Structural rule for 2b: the vibe is stored with the avatar (it only feeds
// the descriptor LLM) but must never reach an image or scene prompt. This
// scan follows every engine module: only the descriptor prompt may read it.
const ENGINE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = [ENGINE_DIR, resolve(ENGINE_DIR, "..", "node")];
const MAY_READ_THE_VIBE = new Set([join("engine", "avatars", "descriptor.ts")]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "testing" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function mentionsTheVibe(path: string): boolean {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if ((ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isPrivateIdentifier(node)) && /^#?vibe$/i.test(node.text)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

test("only the descriptor prompt reads the vibe: no other engine module (image, scene or run prompts included) touches it", () => {
  const studio = resolve(ENGINE_DIR, "..");
  const readers = SCANNED.flatMap(sources)
    .filter(mentionsTheVibe)
    .map((path) => relative(studio, path));

  expect(readers).toEqual([...MAY_READ_THE_VIBE]);
});

test("the scan sees a module that reads the vibe (it is not vacuous)", () => {
  expect(mentionsTheVibe(join(ENGINE_DIR, "avatars", "descriptor.ts"))).toBe(true);
  expect(mentionsTheVibe(join(ENGINE_DIR, "avatars", "prompts.ts"))).toBe(false);
});
