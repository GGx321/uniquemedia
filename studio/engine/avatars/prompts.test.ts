import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AvatarDescriptor, Draft, type AvatarTraits } from "../../shared/engine";
import { youthWords } from "../../shared/engine";
import { firstHit, NEGATED_LOOK } from "../scenes/testing/lookRules";
import { candidatePrompt, promptSubject, PromptSubjectError, referencePortraitPrompt } from "./prompts";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

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
    const draft = Draft.parse({ avatarId: "draft-00000001", traits, descriptor: DESCRIPTOR, candidates: [], hiddenBelowThreshold: 0, estimate: null });

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

  test("the refusal is its own error type, so a command can name it instead of answering INTERNAL", () => {
    expect(() => candidatePrompt({ age: 25, text: "25-year-old European woman who looks 17." })).toThrow(PromptSubjectError);
  });

  describe("her body phrase (Stage 5, S5.2a)", () => {
    const BODY = "tall, a full bust and long slim legs";

    test("is appended after «; » at the END of the descriptor, once, without the text's closing period", () => {
      expect(promptSubject({ age: 25, text: GOOD, body: BODY })).toBe(`${GOOD.replace(/\.$/, "")}; ${BODY}`);
    });

    test("a descriptor without a body is exactly what it was", () => {
      expect(promptSubject({ age: 25, text: GOOD })).toBe(GOOD.replace(/\.$/, ""));
    });

    test("the composite over 600 characters is refused before any prompt is built", () => {
      const text = `${GOOD} ${"x".repeat(600 - GOOD.length - 1)}`;
      expect(text).toHaveLength(600);
      expect(promptSubject({ age: 25, text })).toBe(text);
      expect(() => promptSubject({ age: 25, text, body: BODY })).toThrow(PromptSubjectError);
    });

    test("a body phrase that breaks the adult rules is refused", () => {
      expect(() => promptSubject({ age: 25, text: GOOD, body: "a petite figure" })).toThrow(PromptSubjectError);
    });

    test("the candidates prompt keeps the text alone: a head-and-shoulders portrait never carries the body", () => {
      expect(candidatePrompt({ age: 25, text: GOOD, body: BODY })).toBe(candidatePrompt({ age: 25, text: GOOD }));
      expect(candidatePrompt({ age: 25, text: GOOD, body: BODY })).not.toContain("full bust");
    });
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

/** A `vibe: ""` (or `"vibe": ""`) property assignment: setting the fixed empty string is not "reading" or "forwarding" anyone's vibe — the one shape T6c's import needs, since an imported avatar has no owner-entered vibe at all. Only this exact shape is exempt; any other mention of vibe anywhere, including a non-empty string or a read, still trips the rule below. */
function isSetToFixedEmptyString(node: ts.Node): boolean {
  return (
    ts.isPropertyAssignment(node) &&
    (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
    /^vibe$/i.test(node.name.text) &&
    ts.isStringLiteralLike(node.initializer) &&
    node.initializer.text === ""
  );
}

function mentionsTheVibe(path: string): boolean {
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (isSetToFixedEmptyString(node)) return; // exempt: neither this assignment's own name nor its value is a "read"
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

  // Sorted on both sides: readdirSync's order is filesystem-dependent, not a fact this rule cares about.
  expect([...readers].sort()).toEqual([...MAY_READ_THE_VIBE].sort());
});

test("the scan sees a module that reads the vibe (it is not vacuous)", () => {
  expect(mentionsTheVibe(join(ENGINE_DIR, "avatars", "descriptor.ts"))).toBe(true);
  expect(mentionsTheVibe(join(ENGINE_DIR, "avatars", "prompts.ts"))).toBe(false);
});

// L9: importDescribe.ts sets `vibe: ""` (an imported avatar has no
// owner-entered vibe) but does not read or forward anyone's vibe — the scan
// must see straight through that one exemption, on the real file, not just
// on a hand-built fixture.
test("L9: importDescribe.ts's fixed vibe: \"\" is exempt, but any other mention of vibe still trips the scan", () => {
  expect(mentionsTheVibe(join(ENGINE_DIR, "avatars", "importDescribe.ts"))).toBe(false);
  expect(isSetToFixedEmptyString(ts.factory.createPropertyAssignment("vibe", ts.factory.createStringLiteral("")))).toBe(true);
  expect(isSetToFixedEmptyString(ts.factory.createPropertyAssignment("vibe", ts.factory.createStringLiteral("zebra")))).toBe(false);
  expect(isSetToFixedEmptyString(ts.factory.createPropertyAssignment("vibeOther", ts.factory.createStringLiteral("")))).toBe(false);
});

describe("the reference portrait prompt (Stage 5, S5.3b)", () => {
  test("is the spike's wording around the descriptor, on one line, with the adult sentence closing it", () => {
    expect(referencePortraitPrompt(DESCRIPTOR)).toBe(
      "The same woman as in the reference photo, with her exact face, facial proportions, exact hair colour and exact haircut. " +
        "Head-and-shoulders portrait photo of a 25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, " +
        "athletic build, light freckles across the nose, looking straight at the camera with a relaxed, slight smile. " +
        "Soft natural daylight, plain light grey background, nothing else in the picture, her hands out of the frame. " +
        "Natural skin texture, minimal makeup, ordinary phone photo. She is an adult woman.",
    );
  });

  test("takes the descriptor's text alone: her body phrase never reaches it", () => {
    const withBody = referencePortraitPrompt({ age: 25, text: GOOD, body: "tall, a full bust and long slim legs" });
    expect(withBody).toBe(referencePortraitPrompt(DESCRIPTOR));
    expect(withBody).not.toContain("full bust");
  });

  test("negates no look term (I5.10): it says what the photo is", () => {
    expect(firstHit(referencePortraitPrompt(DESCRIPTOR), NEGATED_LOOK)).toBeNull();
  });

  test("carries no youth word", () => {
    expect(youthWords(referencePortraitPrompt(DESCRIPTOR))).toEqual([]);
  });

  test("a descriptor that today's rules refuse throws PromptSubjectError before any prompt is built", () => {
    expect(() => referencePortraitPrompt({ age: 25, text: "25-year-old European woman who looks 17." })).toThrow(PromptSubjectError);
  });
});
