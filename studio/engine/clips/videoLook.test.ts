import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { BANKS } from "../../shared/scenes/banks";
import { BANK_CATEGORIES } from "../../shared/scenes/banks/types";
import { MOTION_STAGING } from "../../shared/scenes/words";
import * as phoneLook from "../scenes/phoneLook";
import {
  ADULT_LINE,
  CLIP_CAPTURES,
  COMES_OFF_LINE,
  CONTINUITY_LINE,
  LEGS_LINE,
  LOOK_LINE,
  PRONE_ANCHOR,
  PROMPT_WORDS_MAX,
  SLOW_LINE,
  WORN_OR_HELD,
  cameraLineOf,
  continuityLineOf,
  hasVideoStagingWord,
  legwearLineOf,
  motionSentenceOf,
  poseSentenceOf,
  shortCameraLineOf,
  wordCount,
  type ClipCapture,
} from "./videoLook";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51): the video lines, one module per medium (I5.1). Each camera line is adapted from a probe prompt that worked or echoes the
// photo's own capture line (engine/scenes/phoneLook.ts); the pacing, the look and the adult line are the probes' words, verbatim. The prompt is the product: these pins are
// its text, and a change here is a change the owner sees.

/** FACE_COVER, read off the module object so a missing export fails an assertion, not the import. */
const faceCover = (): string => {
  const value = (phoneLook as Record<string, unknown>).FACE_COVER;
  if (typeof value !== "string") throw new Error("engine/scenes/phoneLook.ts exports no FACE_COVER");
  return value;
};

const FRIEND = "Handheld by a friend who stays at the same distance, gentle sway, the framing drifts only a little.";

/** The Kling camera lines of plan §5.5, word for word. */
const KLING_LINES: Readonly<Record<ClipCapture, string>> = {
  prone: "A selfie at arm's length: the camera stays in her outstretched hands the whole time.",
  selfie: "A selfie at arm's length: the camera stays in her outstretched hand the whole time.",
  above: "A selfie at arm's length: the camera stays in her outstretched hand the whole time.",
  "over-shoulder": "A selfie over her own shoulder as she lies on her stomach: the phone stays in her hand above her shoulder the whole time and the framing never changes.",
  "pov-legs":
    "A first-person point-of-view video: the camera is exactly where her eyes are, looking straight down her own body, and it stays still; her legs are close to the lens and her feet are at the far end, with no face, no mirror and no hand.",
  mirror: "A mirror selfie: the phone stays in her raised hand the whole time and sways only a little.",
  "mirror-hidden": "A mirror selfie: she holds her phone right in front of her face, the phone covering her face from her eyebrows to her chin, the whole time; it sways only a little.",
  timer: "The phone is propped up and does not move at all; the framing never changes.",
  friend: FRIEND,
  "low-feet": "Handheld by a friend crouching low near her feet who stays at the same distance; the framing drifts only a little.",
  candid: FRIEND,
  unknown: "The framing stays almost still, with a little natural sway.",
};

describe("the camera lines (plan §5.5)", () => {
  test("cover every capture, and the photo's unknown one", () => {
    expect(Object.keys(KLING_LINES).sort()).toEqual([...CLIP_CAPTURES].sort());
  });

  for (const capture of Object.keys(KLING_LINES) as ClipCapture[]) {
    test(`Kling, ${capture}: the plan's line, word for word`, () => {
      expect(cameraLineOf(capture, "kling")).toBe(KLING_LINES[capture]);
    });
  }

  test("Grok's dialect differs only on the timer: the line its probe (B G04) ran", () => {
    for (const capture of CLIP_CAPTURES) {
      const expected = capture === "timer" ? "The phone stays completely still the whole time; the framing never changes." : KLING_LINES[capture];
      expect(cameraLineOf(capture, "grok")).toBe(expected);
    }
  });

  test("mirror-hidden says the photo's face cover verbatim: the one phrase, exported by the photo look and imported here", () => {
    const cover = faceCover();
    expect(cover).toBe("the phone covering her face from her eyebrows to her chin");
    expect(phoneLook.captureLineOf("mirror-hidden", "run-1:slot-1")).toContain(cover);
    for (const dialect of ["kling", "grok"] as const) expect(cameraLineOf("mirror-hidden", dialect)).toContain(cover);
  });

  test("pov-legs is main's photo line turned to video: no phone, never «at her eyes» or «eye level» (the wording that failed in C3′)", () => {
    const photo = phoneLook.captureLineOf("pov-legs", "run-1:slot-1");
    for (const dialect of ["kling", "grok"] as const) {
      const line = cameraLineOf("pov-legs", dialect);
      expect(photo).toContain("the camera is exactly where her eyes are, looking straight down her own body");
      expect(line).toContain("the camera is exactly where her eyes are, looking straight down her own body");
      expect(line).toContain("with no face, no mirror and no hand");
      expect(line).not.toMatch(/\bphones?\b/i);
      expect(line).not.toMatch(/\bat her eyes?\b|\beye level\b/i);
    }
  });

  test("no line contradicts its photo: a face-hidden capture never shows her face, a face-visible one never covers or loses it", () => {
    const hidesFace = /\bcovering her face\b|\bno face\b/i;
    for (const dialect of ["kling", "grok"] as const) {
      for (const capture of CLIP_CAPTURES) {
        const line = cameraLineOf(capture, dialect);
        if (capture === "mirror-hidden" || capture === "pov-legs") expect(line).toMatch(hidesFace);
        else expect(line).not.toMatch(hidesFace);
      }
    }
  });

  test("over-shoulder keeps her on her stomach and the phone above her shoulder; low-feet keeps the friend low near her feet", () => {
    expect(cameraLineOf("over-shoulder", "kling")).toContain("as she lies on her stomach");
    expect(cameraLineOf("over-shoulder", "kling")).toContain("above her shoulder");
    expect(cameraLineOf("low-feet", "kling")).toContain("crouching low near her feet");
  });

  test("only pov-legs has a short line, for a prompt over the cap: it keeps the cover of the face, mirror and hand and never names a phone or her eye level", () => {
    for (const dialect of ["kling", "grok"] as const) {
      for (const capture of CLIP_CAPTURES) {
        const short = shortCameraLineOf(capture, dialect);
        if (capture !== "pov-legs") {
          expect(short).toBeNull();
          continue;
        }
        if (short === null) throw new Error("pov-legs has no short line");
        expect(wordCount(short)).toBeLessThan(wordCount(cameraLineOf(capture, dialect)));
        expect(short).toContain("the camera is exactly where her eyes are, looking straight down her own body");
        expect(short).toContain("no face, no mirror and no hand");
        expect(short).not.toMatch(/\bphones?\b|\bat her eyes?\b|\beye level\b/i);
      }
    }
  });
});

describe("the sentences of a clip prompt", () => {
  test("the pose sentence: a finite verb phrase as it is, an «-ing» activity after «is»", () => {
    expect(poseSentenceOf("lies on her stomach, one arm out", "finite")).toBe("The adult woman lies on her stomach, one arm out.");
    expect(poseSentenceOf("reading by the window", "ing")).toBe("The adult woman is reading by the window.");
  });

  test("the motion sentence: «she …» and «her …» both follow «Over the whole clip»", () => {
    expect(motionSentenceOf("she lifts her hips a little")).toBe("Over the whole clip she lifts her hips a little.");
    expect(motionSentenceOf("her raised feet swing slowly")).toBe("Over the whole clip her raised feet swing slowly.");
  });

  test("the prone anchor is the hips-2 wording, word for word", () => {
    expect(PRONE_ANCHOR).toBe("She stays lying on her stomach the whole time; she never gets up on her hands or knees.");
  });

  test("the legs line keeps the camera on her legs", () => {
    expect(LEGS_LINE).toBe("Her legs fill most of the frame the whole time; the camera never turns up to her face.");
  });

  test("the legwear line names the slot's own legwear", () => {
    expect(legwearLineOf("white knee-high socks")).toBe("Her white knee-high socks stay on her feet the whole time.");
    expect(legwearLineOf("black thigh-high stockings")).toBe("Her black thigh-high stockings stay on her feet the whole time.");
  });

  test("the pacing, the look and the adult line, verbatim", () => {
    expect(SLOW_LINE).toBe("Slow, gentle, unhurried, real-time speed; no fast or abrupt movements, no sudden gestures.");
    expect(LOOK_LINE).toBe("Vertical phone video, slight noise, everything in focus. No text on screen.");
    expect(ADULT_LINE).toBe("She is an adult woman.");
  });

  test("the cap is 130 words, counted on whitespace", () => {
    expect(PROMPT_WORDS_MAX).toBe(130);
    expect(wordCount("A selfie at arm's length: the camera stays.")).toBe(8);
    expect(wordCount("  one   two\nthree ")).toBe(3);
  });
});

describe("the continuity line (critic M5, r2.2)", () => {
  test("the base line holds what she holds and wears", () => {
    expect(CONTINUITY_LINE).toBe("Nothing new appears, and nothing she holds or wears changes.");
    expect(continuityLineOf("she turns her head slowly")).toBe(CONTINUITY_LINE);
  });

  const TRIGGERS = [
    "she tugs the strap a little",
    "she pulls the sheet a little higher",
    "she pulls the blanket up a little",
    "she pulls the duvet up a little",
    "she tugs the waistband up slowly",
    "she smooths the hem down slowly",
    "she pulls the laces tight slowly",
    "she zips the bag slowly",
    "she tugs the coat closer slowly",
    "she turns the earring slowly",
    "she slowly peeks over her sunglasses",
  ];
  for (const motion of TRIGGERS) {
    test(`a garment, cover or accessory motion takes «comes off»: ${motion}`, () => {
      expect(WORN_OR_HELD.test(motion)).toBe(true);
      expect(continuityLineOf(motion)).toBe(COMES_OFF_LINE);
    });
  }

  test("«comes off» never contradicts a motion that moves what she wears", () => {
    expect(COMES_OFF_LINE).toBe("Nothing new appears, and nothing she wears comes off.");
  });

  const HELD = [
    "she lowers the cup a little",
    "she turns her glass slowly",
    "she lifts the mug a little",
    "she jingles her keys a little",
    "she scrolls her phone slowly",
    "she twirls the fork slowly",
    "she lifts the weight slowly",
    "she shifts her weight a little",
    "she shifts against the glass a bit",
    "she slowly turns her head toward them",
  ];
  for (const motion of HELD) {
    test(`a held object, her weight or a window keeps the base line: ${motion}`, () => {
      expect(WORN_OR_HELD.test(motion)).toBe(false);
      expect(continuityLineOf(motion)).toBe(CONTINUITY_LINE);
    });
  }
});

/** What a motion names that a continuity line must be decided for: a garment, cover or accessory, or a held object, her weight, the window glass. */
const OBJECT_WORDS = /\b(?:straps?|sheets?|blankets?|duvets?|waistbands?|hems?|laces|zip\w*|coats?|earrings?|sunglasses|cups?|glass(?:es)?|mugs?|keys|phones?|forks?|weights?)\b/i;

/**
 * Pinned (r2.2 §5.5, by content, never by line): the 15 bank motions that take «comes off» and the motions that name an object and keep the base line, each with its count over
 * all 7 banks. A new bank motion that names one of these words fails here until it is classified on purpose.
 */
const COMES_OFF_MOTIONS: Readonly<Record<string, number>> = {
  "she tugs the strap a little": 1,
  "she lets the strap settle on her shoulder slowly": 1,
  "she slides the strap up slowly": 1,
  "she smooths the hem down slowly": 1,
  "she pulls the blanket up a little": 1,
  "she pulls the blanket a little closer": 1,
  "she pulls the duvet up a little": 1,
  "she pulls the sheet a little higher": 1,
  "she tugs the waistband up slowly": 1,
  "she pulls the laces tight slowly": 1,
  "she zips the bag slowly": 1,
  "she tugs the coat closer slowly": 1,
  "she turns the earring slowly": 2,
  "she slowly peeks over her sunglasses": 1,
};
const BASE_LINE_MOTIONS: Readonly<Record<string, number>> = {
  "she lowers the cup a little": 2,
  "she lifts the cup a little": 2,
  "she turns her glass slowly": 1,
  "she lifts her glass a little": 1,
  "she raises her glass a bit higher": 1,
  "she lowers the glass a little": 1,
  "she lifts the mug a little": 1,
  "she jingles her keys a little": 2,
  "she scrolls her phone slowly": 2,
  "she twirls the fork slowly": 1,
  "she lifts the weight slowly": 1,
  "she shifts her weight slowly": 1,
  "she shifts her weight a little": 10,
  "she shifts against the glass a bit": 1,
};

describe("the continuity sweep over all 7 banks (critic M5, r2.2)", () => {
  const motions = BANK_CATEGORIES.flatMap((category) => BANKS[category].places.flatMap((place) => place.moments.map((moment) => moment.motion)));
  const counted = (texts: readonly string[]): Record<string, number> => texts.reduce<Record<string, number>>((acc, text) => ({ ...acc, [text]: (acc[text] ?? 0) + 1 }), {});

  test("exactly the pinned 15 motions take «comes off»: 12 garment or cover motions and 3 accessory motions", () => {
    const comesOff = counted(motions.filter((motion) => continuityLineOf(motion) === COMES_OFF_LINE));
    expect(comesOff).toEqual(COMES_OFF_MOTIONS);
    expect(Object.values(comesOff).reduce((a, b) => a + b, 0)).toBe(15);
  });

  test("every other motion that names an object keeps the base line, exactly as pinned", () => {
    const base = counted(motions.filter((motion) => OBJECT_WORDS.test(motion) && continuityLineOf(motion) === CONTINUITY_LINE));
    expect(base).toEqual(BASE_LINE_MOTIONS);
  });

  test("the coat (glamour) never gets the base line", () => {
    const coat = motions.filter((motion) => /\bcoat\b/.test(motion));
    expect(coat.length).toBeGreaterThan(0);
    for (const motion of coat) expect(continuityLineOf(motion)).toBe(COMES_OFF_LINE);
  });
});

describe("the video word list (I5.51)", () => {
  const VIDEO_WORDS = ["dolly", "crane", "drone", "gimbal", "orbit", "push-in", "cinematic", "film", "colour grading", "lens flare", "transition"];
  for (const word of VIDEO_WORDS) {
    test(`refuses «${word}»`, () => {
      expect(hasVideoStagingWord(`she turns slowly in a ${word} move`)).toBe(true);
    });
  }

  test("refuses every word the bank's own staging list refuses", () => {
    for (const word of ["zoom", "cut", "pan", "frame", "shot", "close-up", "slow motion"]) {
      expect(MOTION_STAGING.test(word)).toBe(true);
      expect(hasVideoStagingWord(`she turns slowly, ${word}`)).toBe(true);
    }
  });

  test("lets every bank motion and activity through today", () => {
    for (const category of BANK_CATEGORIES) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments) {
          expect(hasVideoStagingWord(moment.motion)).toBe(false);
          expect(hasVideoStagingWord(moment.text)).toBe(false);
        }
      }
    }
  });
});

/** The production sources of the studio, tests and test kits left out. */
function productionSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "testing" || entry.name === "fixtures" ? [] : productionSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !/testkit\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("the video lines live in clips/videoLook.ts alone (I5.1, I5.51)", () => {
  const studio = join(import.meta.dir, "..", "..");
  const sources = productionSources(studio)
    .map((path) => ({ path: relative(studio, path), text: readFileSync(path, "utf8") }))
    .filter((source) => source.path !== "engine/clips/videoLook.ts");
  const LINES = [
    ...new Set(Object.values(KLING_LINES).filter((line) => !line.includes("the phone covering her face"))),
    "The phone stays completely still the whole time; the framing never changes.",
    PRONE_ANCHOR,
    LEGS_LINE,
    CONTINUITY_LINE,
    COMES_OFF_LINE,
    SLOW_LINE,
    LOOK_LINE,
    "The adult woman",
    "Over the whole clip",
    "stay on her feet the whole time",
  ];

  for (const line of LINES) {
    test(`no other production module carries «${line.slice(0, 48)}…»`, () => {
      expect(sources.filter((source) => source.text.includes(line)).map((source) => source.path)).toEqual([]);
    });
  }
});
