import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { relativePosix } from "../../testing/posixPath";
import { BANKS } from "../../shared/scenes/banks";
import { BANK_CATEGORIES } from "../../shared/scenes/banks/types";
import { CAPTURES } from "../../shared/scenes/captures";
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
  SHIPPED_POV_CAPTURE_LINES,
  SLOW_LINE,
  WORN_OR_HELD,
  cameraLineOf,
  continuityLineOf,
  holdsPovCaptureLine,
  legsLineOf,
  hasVideoStagingWord,
  legwearLineOf,
  motionSentenceOf,
  poseSentenceOf,
  provenCaptureOf,
  shortCameraLineOf,
  wordCount,
  type ClipCapture,
} from "./videoLook";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V5 (plan s5b1 §5.5, I5.51): the video lines, one module per medium (I5.1). Each camera line is adapted from a probe prompt that worked or echoes the
// photo's own capture line (engine/scenes/phoneLook.ts); the pacing and the adult line are the probes' words, verbatim; the look is theirs plus «One continuous shot, no cuts.» (C3 polish). The prompt is the product: these pins are
// its text, and a change here is a change the owner sees.

/** FACE_COVER, read off the module object so a missing export fails an assertion, not the import. */
const faceCover = (): string => {
  const value = (phoneLook as Record<string, unknown>).FACE_COVER;
  if (typeof value !== "string") throw new Error("engine/scenes/phoneLook.ts exports no FACE_COVER");
  return value;
};

const FRIEND = "Handheld steadily by a friend at the same distance the whole time; the framing barely moves.";

/** The Kling camera lines: plan §5.5's, except the selfie and friend lines, which the C3 polish (2026-10-14) rewrote; those were re-checked 2026-10-14 (paid re-check R1–R3; owner: better); low-feet has the same wording as FRIEND and was re-checked through it. */
const SELFIE = "A selfie at arm's length: the view stays at that same distance from her and the framing never changes; one arm leaves the frame at its edge the whole time.";
const KLING_LINES: Readonly<Record<ClipCapture, string>> = {
  prone: SELFIE,
  selfie: SELFIE,
  above: SELFIE,
  "over-shoulder": "A selfie over her own shoulder as she lies on her stomach: the phone stays in her hand above her shoulder the whole time and the framing never changes.",
  "pov-legs":
    "A first-person point-of-view video: the camera is exactly where her eyes are, looking straight down her own body, and it stays still; her legs are close to the lens and her feet are at the far end, with no face, no mirror and no hand.",
  mirror: "A mirror selfie: the phone stays in her raised hand the whole time and sways only a little.",
  "mirror-hidden": "A mirror selfie: she holds her phone right in front of her face, the phone covering her face from her eyebrows to her chin, the whole time; it sways only a little.",
  timer: "The phone is propped up and does not move at all; the framing never changes.",
  friend: FRIEND,
  "low-feet": "Handheld steadily by a friend crouching low near her feet, at the same distance the whole time; the framing barely moves.",
  candid: FRIEND,
  unknown: "The framing stays almost still, with a little natural sway.",
};

describe("the camera lines (plan §5.5)", () => {
  test("cover every capture, and the photo's unknown one", () => {
    expect(Object.keys(KLING_LINES).sort()).toEqual([...CLIP_CAPTURES].sort());
  });

  for (const capture of Object.keys(KLING_LINES) as ClipCapture[]) {
    test(`Kling, ${capture}: the pinned line, word for word`, () => {
      expect(cameraLineOf(capture, "kling")).toBe(KLING_LINES[capture]);
    });
  }

  test("Grok's dialect differs only on the timer: the line its probe (B G04) ran", () => {
    for (const capture of CLIP_CAPTURES) {
      const expected = capture === "timer" ? "The phone stays completely still the whole time; the framing never changes." : KLING_LINES[capture];
      expect(cameraLineOf(capture, "grok")).toBe(expected);
    }
  });

  for (const capture of ["prone", "selfie", "above"] as const) {
    for (const dialect of ["kling", "grok"] as const) {
      test(`${capture}, ${dialect}: the view stays at the same distance, the framing never changes, one arm leaves the frame at its edge, and the line names no phone (C3 K4)`, () => {
        const line = cameraLineOf(capture, dialect);
        expect(line).toContain("the view stays at that same distance from her");
        expect(line).toContain("the framing never changes");
        expect(line).toContain("one arm leaves the frame at its edge");
        expect(line).not.toMatch(/phone/i);
        expect(wordCount(line)).toBeLessThanOrEqual(36);
      });
    }
  }

  for (const capture of ["friend", "candid", "low-feet"] as const) {
    test(`${capture}: the friend holds steady at the same distance the whole time, the framing barely moves, no sway, no drift and no phone (C3 K3)`, () => {
      const line = cameraLineOf(capture, "kling");
      expect(line).toContain("Handheld steadily by a friend");
      expect(line).toContain("at the same distance the whole time");
      expect(line).toContain("the framing barely moves");
      expect(line).not.toMatch(/sway|drift|phone/i);
    });
  }

  for (const capture of CLIP_CAPTURES) {
    test(`${capture}: no camera line carries «reach» (spike B: a reach toward the lens pulls the camera back), nor a camera or edit word`, () => {
      for (const dialect of ["kling", "grok"] as const) {
        const line = cameraLineOf(capture, dialect);
        expect(line).not.toMatch(/reach/i);
        // «frame» is the lines' own word (the legs line says it too); the staging lists read motions and activities.
        expect(line).not.toMatch(/\b(?:dolly|crane|drone|gimbal|orbit\w*|push-?ins?|cinematic\w*|film\w*|zoom\w*|pans?|cuts?|transitions?)\b/i);
      }
    });
  }

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
    expect(LOOK_LINE).toBe("Vertical phone video, slight noise, everything in focus. One continuous shot, no cuts. No text on screen.");
    expect(ADULT_LINE).toBe("She is an adult woman.");
  });

  test("the cap is 130 words, counted on whitespace", () => {
    expect(PROMPT_WORDS_MAX).toBe(130);
    expect(wordCount("A selfie at arm's length: the camera stays.")).toBe(8);
    expect(wordCount("  one   two\nthree ")).toBe(3);
  });
});

describe("the continuity line (critic M5, r2.2; the controller's round 2)", () => {
  test("the base line holds what she holds and wears", () => {
    expect(CONTINUITY_LINE).toBe("Nothing new appears, and nothing she holds or wears changes.");
    expect(continuityLineOf("she turns her head slowly", null)).toBe(CONTINUITY_LINE);
  });

  const TRIGGERS = [
    "she slides the strap up slowly",
    "she lets the strap settle on her shoulder slowly",
    "she pulls the sheet a little higher",
    "she pulls the blanket up a little",
    "she pulls the duvet up a little",
    "she tugs the waistband up slowly",
    "she smooths the hem down slowly",
    "she pulls the laces tight slowly",
    "she tugs the coat closer slowly",
    "she turns the earring slowly",
    "she slowly peeks over her sunglasses",
    // Putting a jacket or a coat ON: what she wears changes, so the base line would contradict it.
    "she slides one arm in slowly",
  ];
  for (const motion of TRIGGERS) {
    test(`a garment, cover or accessory motion takes «comes off»: ${motion}`, () => {
      expect(WORN_OR_HELD.test(motion)).toBe(true);
      expect(continuityLineOf(motion, null)).toBe(COMES_OFF_LINE);
    });
  }

  test("«comes off» never contradicts a motion that moves what she wears", () => {
    expect(COMES_OFF_LINE).toBe("Nothing new appears, and nothing she wears comes off.");
  });

  const HELD: readonly (readonly [string, string | null])[] = [
    ["she lowers the cup a little", null],
    ["she turns her glass slowly", null],
    ["she lifts the mug a little", null],
    ["she jingles her keys a little", null],
    ["she scrolls her phone slowly", null],
    ["she twirls the fork slowly", null],
    ["she lifts the weight slowly", null],
    ["she shifts her weight a little", null],
    ["she shifts against the glass a bit", null],
    ["she slowly turns her head toward them", null],
    // A stretch of her arm is not a sleeve: only the exact «slides one arm in» puts one on.
    ["she pulls her arm in a little", null],
    // A bag is held, not worn (K09 lost its bag): its zip and its strap keep the base line, whether the motion or the moment names the bag.
    ["she zips the bag slowly", null],
    ["she tugs the strap a little", "adjusts the strap of her bag"],
    ["she tucks the clutch away slowly", null],
  ];
  for (const [motion, activity] of HELD) {
    test(`a held object, her weight or a window keeps the base line: ${motion}${activity === null ? "" : ` (${activity})`}`, () => {
      expect(continuityLineOf(motion, activity)).toBe(CONTINUITY_LINE);
    });
  }

  // Post-review: «clutch», «purse» and «tote» are bags only as nouns, after an article or a possessive (and an adjective or two of a bag); as verbs they hold nothing.
  const BAG_NOUNS: readonly (readonly [string, string])[] = [
    ["she slides the strap up slowly", "walks with a small clutch"],
    ["she slides the strap up slowly", "holds her purse by the strap"],
    ["she slides the strap up slowly", "carries a canvas tote"],
    ["she tugs the strap a little", "picks up her small black clutch"],
  ];
  for (const [motion, activity] of BAG_NOUNS) {
    test(`a clutch, a purse or a tote she holds keeps the base line: ${motion} (${activity})`, () => {
      expect(continuityLineOf(motion, activity)).toBe(CONTINUITY_LINE);
    });
  }

  const BAG_VERBS: readonly (readonly [string, string])[] = [
    ["she pulls the sheet a little higher", "clutches the sheet to her chest"],
    ["she slides the strap up slowly", "purses her lips at the mirror"],
    ["she tugs the coat closer slowly", "totes her coat over one arm"],
    ["she clutches the blanket a little closer", "lies curled under the blanket"],
    ["her fingers clutch the duvet a little tighter", "lies curled up under the duvet"],
  ];
  for (const [motion, activity] of BAG_VERBS) {
    test(`the verb «clutches», «purses» or «totes» holds no bag: ${motion} (${activity})`, () => {
      expect(continuityLineOf(motion, activity)).toBe(COMES_OFF_LINE);
    });
  }
});

/** What a motion names that a continuity line must be decided for: a garment, cover or accessory, a sleeve put on, or a held object, her weight, the window glass. */
const OBJECT_WORDS =
  /\b(?:straps?|sheets?|blankets?|duvets?|waistbands?|hems?|laces|zip\w*|coats?|earrings?|sunglasses|slides one arm in|cups?|glass(?:es)?|mugs?|keys|phones?|forks?|weights?|bags?|clutch(?:es)?|purses?)\b/i;

/**
 * Pinned (r2.2 §5.5 and the controller's round 2, by content, never by line): the 15 bank motions that take «comes off» and the motions that name an object and keep the base line,
 * each with its count over all 7 banks. Round 2 added the two sleeves put on (glamour «takes her coat from the rack», fitness «pulls on a light jacket») and moved the two bag
 * motions (a bag strap, a bag zip) to the base line. A new bank motion that names one of these words fails here until it is classified on purpose.
 */
const COMES_OFF_MOTIONS: Readonly<Record<string, number>> = {
  "she lets the strap settle on her shoulder slowly": 1,
  "she slides the strap up slowly": 1,
  "she smooths the hem down slowly": 1,
  "she pulls the blanket up a little": 1,
  "she pulls the blanket a little closer": 1,
  "she pulls the duvet up a little": 1,
  "she pulls the sheet a little higher": 1,
  "she tugs the waistband up slowly": 1,
  "she pulls the laces tight slowly": 1,
  "she tugs the coat closer slowly": 1,
  "she slides one arm in slowly": 2,
  "she turns the earring slowly": 2,
  "she slowly peeks over her sunglasses": 1,
};
const BASE_LINE_MOTIONS: Readonly<Record<string, number>> = {
  "she tugs the strap a little": 1,
  "she zips the bag slowly": 1,
  "she tucks the clutch away slowly": 1,
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

describe("the continuity sweep over all 7 banks (critic M5, r2.2; round 2)", () => {
  const moments = BANK_CATEGORIES.flatMap((category) => BANKS[category].places.flatMap((place) => place.moments));
  const counted = (texts: readonly string[]): Record<string, number> => texts.reduce<Record<string, number>>((acc, text) => ({ ...acc, [text]: (acc[text] ?? 0) + 1 }), {});

  test("exactly the pinned 15 motions take «comes off»: 12 garment, cover or sleeve motions and 3 accessory motions", () => {
    const comesOff = counted(moments.filter((m) => continuityLineOf(m.motion, m.text) === COMES_OFF_LINE).map((m) => m.motion));
    expect(comesOff).toEqual(COMES_OFF_MOTIONS);
    expect(Object.values(comesOff).reduce((a, b) => a + b, 0)).toBe(15);
  });

  test("every other motion that names an object keeps the base line, exactly as pinned", () => {
    const base = counted(moments.filter((m) => OBJECT_WORDS.test(m.motion) && continuityLineOf(m.motion, m.text) === CONTINUITY_LINE).map((m) => m.motion));
    expect(base).toEqual(BASE_LINE_MOTIONS);
  });

  test("the coat (glamour) never gets the base line", () => {
    const coat = moments.filter((m) => /\bcoat\b/.test(m.motion));
    expect(coat.length).toBeGreaterThan(0);
    for (const m of coat) expect(continuityLineOf(m.motion, m.text)).toBe(COMES_OFF_LINE);
  });
});

describe("the legs line (round 2)", () => {
  test("a legs frame keeps the camera on her legs and off her face", () => {
    for (const capture of CLIP_CAPTURES) {
      if (capture !== "mirror-hidden") expect(legsLineOf(capture)).toBe(LEGS_LINE);
    }
  });

  test("by the mirror the phone already covers her face, so the line says nothing of her face (the photo's own legs phrase there, S5.R4 r3)", () => {
    expect(legsLineOf("mirror-hidden")).toBe("Her legs fill most of the frame the whole time.");
    expect(cameraLineOf("mirror-hidden", "kling")).toContain("in front of her face");
  });
});

describe("a camera line only from what the photo's prompt proves (S5.WP1, plan s5b2 I5.69)", () => {
  /**
   * Every wording engine/scenes/phoneLook.ts has given the pov-legs capture line since the C3′ fix, newest first, with its commit. Found with
   * `git log --all -m -G'first-person|point-of-view|down her own body|looking down along' -- studio/engine/scenes/phoneLook.ts studio/engine/scenes/assembler.ts` and
   * `git log --all -S'first-person point-of-view photo'` over every file (the assembler only places the line): two commits, both on main's first parent, so both
   * reached photos; everything before 6c94d102 is the pre-fix «looking down along her own legs … held at her eye level». A change to phoneLook's pov-legs line fails the
   * test below: the old wording must stay on this list, or the photos drawn with it would lose their POV line.
   */
  const SHIPPED = [
    // e6865355 (2026-10-12 14:22, «name her legs, not her thighs, in the look down her legs»): today's line.
    "A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body; her legs are close to the lens in the foreground and her feet are at the far end, only her own legs are in the picture, with no face, no mirror and no hand.",
    // 6c94d102 (2026-10-12 13:05, «shoot the look down her legs as a first-person photo»): the C3′ fix itself, main's line until e6865355.
    "A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body; her thighs and knees are close to the lens in the foreground and her feet are at the far end, only her own legs are in the picture, with no face, no mirror and no hand.",
  ];
  /** The pov-legs line before the C3′ fix (aba9a3f6 to 6c94d102): it drew a selfie from above (C3 K1's first frame), so it proves no first-person view. */
  const PRE_FIX = "A photo she took looking down along her own legs from where she lies or sits, held at her eye level; nothing in her hand can be seen.";

  test("the shipped POV wordings, pinned with their commits, today's first", () => {
    expect(SHIPPED_POV_CAPTURE_LINES).toEqual(SHIPPED);
  });

  test("today's photo line is the first of them: one source, phoneLook's", () => {
    expect(SHIPPED_POV_CAPTURE_LINES[0]).toBe(phoneLook.captureLineOf("pov-legs", "run-1:slot-1"));
  });

  test("a prompt holds a POV line only when it carries one of them verbatim", () => {
    for (const line of SHIPPED) expect(holdsPovCaptureLine(`${line} Her legs fill most of the frame; her face may be out of frame. She is an adult woman.`)).toBe(true);
    expect(holdsPovCaptureLine(`${PRE_FIX} Her legs fill most of the frame; her face may be out of frame. She is an adult woman.`)).toBe(false);
    expect(holdsPovCaptureLine("")).toBe(false);
    // A part of the line is not the line: «first-person» alone, or the line cut short before its last clause.
    expect(holdsPovCaptureLine("A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body.")).toBe(false);
    expect(holdsPovCaptureLine((SHIPPED[0] ?? "").replace(", with no face, no mirror and no hand.", "."))).toBe(false);
  });

  test("pov-legs without a POV line reads as unknown; with one, as pov-legs", () => {
    expect(provenCaptureOf("pov-legs", `${PRE_FIX} She is an adult woman.`)).toBe("unknown");
    expect(provenCaptureOf("pov-legs", "")).toBe("unknown");
    for (const line of SHIPPED) expect(provenCaptureOf("pov-legs", `${line} She is an adult woman.`)).toBe("pov-legs");
  });

  test("every other capture is read as it is, with a POV line, the pre-fix line or none", () => {
    for (const capture of CAPTURES) {
      if (capture === "pov-legs") continue;
      for (const prompt of ["", `${PRE_FIX} She is an adult woman.`, `${SHIPPED[0] ?? ""} She is an adult woman.`]) expect(provenCaptureOf(capture, prompt)).toBe(capture);
    }
  });

  test("the unknown line a disproved pov-legs photo takes: no «reach», no phone, and no first-person view", () => {
    for (const dialect of ["kling", "grok"] as const) {
      const line = cameraLineOf("unknown", dialect);
      expect(line).not.toMatch(/reach/i);
      expect(line).not.toMatch(/\bphones?\b/i);
      expect(line).not.toMatch(/first-person|point-of-view|her eyes/i);
    }
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
    .map((path) => ({ path: relativePosix(studio, path), text: readFileSync(path, "utf8") }))
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
