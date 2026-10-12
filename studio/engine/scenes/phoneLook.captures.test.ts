import { describe, expect, test } from "bun:test";
import { youthWords } from "../../shared/engine";
import { CAPTURES, shotOf, type Capture } from "../../shared/scenes/captures";
import { pick } from "../../shared/scenes/hash";
import { artefactLine, captureLineOf, FRIEND_VARIANTS, hairLine, isLampMood, MIRROR_BACK_LINE, phoneHandLineOf } from "./phoneLook";
import { firstHit, NEGATED_LOOK, SOFT_LIST, STAGING } from "./testing/lookRules";
import { REVEALING_WORDS } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.2 (S5.6b, plan s5a2 r1.5 §5.4, I5.1, I5.32, I5.34): the capture lines by kind, the hand line, the back-to-the-mirror sentence, the lamp mood and the hair
// line. Every phrase lives in phoneLook.ts and nowhere else; the wording is the plan's, verbatim.

const KEYS = Array.from({ length: 300 }, (_, i) => `run-${i}:slot-${(i % 12) + 1}`);

describe("captureLineOf: the plan's wording, verbatim", () => {
  // C3′ (the owner's verdict, 2026-10-12): «the phone hides most of her face» drew her face BESIDE the phone in 5 of 5 face-hidden frames; the wording probe's
  // winner (1a) covers it from her eyebrows to her chin, and Grok drew no face.
  test("mirror-hidden: the probe's face-cover wording (1a)", () => {
    expect(captureLineOf("mirror-hidden", "k")).toBe(
      "A mirror selfie she took herself: she holds her phone right in front of her face, the phone covering her face from her eyebrows to her chin; only her hair and body show in the mirror.",
    );
  });

  test("mirror keeps today's line: her face clear beside the phone", () => {
    expect(captureLineOf("mirror", "k")).toBe(
      "A mirror selfie she took herself: her phone in her hand at chest height, visible in the mirror and held low enough to leave her face clear, the room behind her in the reflection.",
    );
  });

  test("above", () => {
    expect(captureLineOf("above", "k")).toBe(
      "A close photo she took of herself from slightly above as she lies there, at arm's length; her near arm leaves the frame, so nothing in her near hand can be seen.",
    );
  });

  test("prone", () => {
    expect(captureLineOf("prone", "k")).toBe(
      "A photo she took of herself at arm's length as she lies on her stomach on the bed, one arm stretched toward the viewer and out of the frame, her other hand free; behind her, the curve of her back and hips.",
    );
  });

  test("prone never says «hips raised», the wording the owner rejected", () => {
    expect(captureLineOf("prone", "k")).not.toMatch(/hips raised/i);
  });

  test("over-shoulder", () => {
    expect(captureLineOf("over-shoulder", "k")).toBe(
      "A photo she took of herself from above her own shoulder while lying on her stomach on the bed, looking back along her own body: her hair in the foreground, her hips, and her feet raised up at the far end.",
    );
  });

  test("selfie keeps today's S5.4 line", () => {
    expect(captureLineOf("selfie", "k")).toBe(
      "A photo she took of herself at arm's length, seen from the camera's own point of view, held a little above eye level, the frame slightly tilted; her near arm stretches toward the viewer and leaves the frame at the bottom edge, so nothing in her near hand can be seen.",
    );
  });

  test("timer carries «both of her hands are empty and nobody holds a phone; her whole body is in the picture» (I5.32)", () => {
    expect(captureLineOf("timer", "k")).toBe("A photo from her phone propped on a ledge a few metres away on a timer; both of her hands are empty and nobody holds a phone; her whole body is in the picture.");
  });

  // C3′: «looking down along her own legs … held at her eye level» came out as a photo from far away (R5#09). The wording probe's variant (b) drew a clean first-person
  // view (no face, no hair, no hand), verbatim but for «socked feet»: the probe's moment wore socks, and a pov-legs moment may be barefoot or in shoes.
  test("pov-legs carries the probe's first-person line (c3fix 2b)", () => {
    expect(captureLineOf("pov-legs", "k")).toBe(
      "A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body; her thighs and knees are close to the lens in the foreground and her feet are at the far end, only her own legs are in the picture, with no face, no mirror and no hand.",
    );
  });

  test("low-feet carries the 5a.2c line (plan §7.2)", () => {
    expect(captureLineOf("low-feet", "k")).toBe(
      "A quick phone photo a friend took of her, crouching a couple of metres away, low down near her feet; both of her hands are empty; she is not taking the photo herself.",
    );
  });
});

describe("the friend line (someone she asked) and its three variants", () => {
  test("the variants are the plan's three, in this order", () => {
    expect([...FRIEND_VARIANTS]).toEqual([
      "from eye level a few steps away, her whole body in the picture",
      "from a little below, a few steps away, her whole body in the picture",
      "from eye level, from her knees up",
    ]);
  });

  test("a friend line reads «A quick phone photo someone she asked took of her, {variant}; she is not taking the photo herself.»", () => {
    for (const key of KEYS.slice(0, 30)) {
      const variant = pick(FRIEND_VARIANTS, key, "friend");
      expect(captureLineOf("friend", key)).toBe(`A quick phone photo someone she asked took of her, ${variant}; she is not taking the photo herself.`);
    }
  });

  test("the variant is drawn on `${key}:friend`: the same key, the same line; across keys all three appear", () => {
    expect(captureLineOf("friend", KEYS[0] ?? "")).toBe(captureLineOf("friend", KEYS[0] ?? ""));
    const seen = new Set(KEYS.map((key) => captureLineOf("friend", key)));
    expect(seen.size).toBe(3);
  });

  test("a candid is the friend line plus today's candid clause", () => {
    for (const key of KEYS.slice(0, 30)) expect(captureLineOf("candid", key)).toBe(`${captureLineOf("friend", key)} She is busy with something and not looking toward the camera.`);
  });

  // S5.6R (LOW): a friend shooting «from her knees up» cut off the moment she was in («slips on her heels»). A moment about her feet takes a whole-body
  // variant, drawn on the same `${key}:friend` stream; every other slot keeps the line it always had.
  test("a moment about her feet takes a whole-body variant, for a friend and a candid alike", () => {
    const seen = new Set<string>();
    for (const key of KEYS) {
      for (const capture of ["friend", "candid"] as const) {
        const line = captureLineOf(capture, key, { wholeBody: true });
        expect(line).toContain("her whole body in the picture");
        expect(line).not.toContain("from her knees up");
        seen.add(line);
      }
    }
    expect(seen.size).toBe(4);
  });

  test("without the whole-body need, the friend line is the one it always was", () => {
    for (const key of KEYS) expect(captureLineOf("friend", key, { wholeBody: false })).toBe(captureLineOf("friend", key));
  });

  test("the whole-body need changes no other capture's line", () => {
    for (const capture of ["mirror-hidden", "mirror", "above", "prone", "over-shoulder", "selfie", "timer", "pov-legs", "low-feet"] as const) {
      expect(captureLineOf(capture, "k", { wholeBody: true })).toBe(captureLineOf(capture, "k"));
    }
  });
});

describe("only the two mirror lines say «selfie» (I5.32, owner canary C1)", () => {
  test.each(CAPTURES.filter((c) => c !== "mirror" && c !== "mirror-hidden"))("%s names no selfie and no front camera", (capture) => {
    for (const key of KEYS.slice(0, 40)) expect(captureLineOf(capture, key)).not.toMatch(/selfie|front[ -](facing[ -])?camera/i);
  });

  test("both mirror lines say it, because they must show the phone", () => {
    expect(captureLineOf("mirror", "k")).toMatch(/mirror selfie/);
    expect(captureLineOf("mirror-hidden", "k")).toMatch(/mirror selfie/);
  });
});

describe("the hand line", () => {
  test.each<[Capture, string | null]>([
    ["mirror", "One hand holds the phone; only her other hand acts."],
    ["mirror-hidden", "One hand holds the phone; only her other hand acts."],
    ["selfie", "Her near arm is out of the frame; only her other hand acts."],
    ["above", "Her phone arm is out of the frame; her other hand is free and holds nothing."],
    ["prone", "Her phone arm is out of the frame; her other hand is free and holds nothing."],
    ["over-shoulder", "Her phone arm is out of the frame; her other hand is free and holds nothing."],
    ["pov-legs", "Her phone arm is out of the frame; her other hand is free and holds nothing."],
    ["timer", null],
    ["friend", null],
    ["candid", null],
    ["low-feet", null],
  ])("%s", (capture, line) => {
    expect(phoneHandLineOf(capture)).toBe(line);
  });

  test("a capture that holds a phone in a hand has a hand line; one that does not has none", () => {
    for (const capture of CAPTURES) expect(phoneHandLineOf(capture) !== null).toBe(shotOf(capture) === "selfie" || shotOf(capture) === "mirror");
  });
});

describe("back or side to the mirror (owner note, r1.5)", () => {
  // C3′: the same phone clause as the face-hidden line, never the weaker «it hides her face» the frames ignored.
  test("the sentence says only her reflection shows and the phone covers her face as the face-hidden line does", () => {
    expect(MIRROR_BACK_LINE).toBe("Only her reflection is in the picture; the phone covers her face from her eyebrows to her chin.");
  });
});

describe("the lamp mood (I5.34)", () => {
  const IMPERFECTION = "a few smudges on the mirror";

  test("camera realism on: dim lamp light, soft shadow, grain, muted colours, slightly soft focus, the imperfection, and no «everything in focus»", () => {
    expect(artefactLine({ cameraRealism: true, light: "x", imperfection: IMPERFECTION, lampMood: true })).toBe(
      `Ordinary phone photo straight from her camera roll: dim evening light from a bedside lamp, the room in soft shadow, visible grain from the low light, muted colours, slightly soft focus, ${IMPERFECTION}.`,
    );
  });

  test("camera realism off: the shorter lamp line", () => {
    expect(artefactLine({ cameraRealism: false, light: "x", imperfection: IMPERFECTION, lampMood: true })).toBe("Ordinary phone photo: dim evening light from a bedside lamp, the room in soft shadow, muted colours.");
  });

  test("any other prompt keeps «everything in focus, the background as sharp as she is»", () => {
    for (const cameraRealism of [true, false]) {
      expect(artefactLine({ cameraRealism, light: "morning daylight", imperfection: IMPERFECTION })).toContain("everything in focus, the background as sharp as she is");
      expect(artefactLine({ cameraRealism, light: "morning daylight", imperfection: IMPERFECTION, lampMood: false })).toContain("everything in focus, the background as sharp as she is");
    }
  });

  test("only a lamp place at evening or night is lamp mood", () => {
    expect(isLampMood({ lamp: true }, "evening")).toBe(true);
    expect(isLampMood({ lamp: true }, "night")).toBe(true);
    expect(isLampMood({ lamp: true }, "morning")).toBe(false);
    expect(isLampMood({ lamp: true }, "midday")).toBe(false);
    expect(isLampMood({ lamp: false }, "night")).toBe(false);
    expect(isLampMood(null, "night")).toBe(false);
    expect(isLampMood({ lamp: true }, undefined)).toBe(false);
  });

  test("the variant passes the negation, staging, soft-list, youth and revealing sweeps (I5.10)", () => {
    for (const cameraRealism of [true, false]) {
      const text = artefactLine({ cameraRealism, light: "x", imperfection: IMPERFECTION, lampMood: true });
      expect(firstHit(text, [...STAGING, ...NEGATED_LOOK])).toBeNull();
      expect(SOFT_LIST.exec(text)).toBeNull();
      expect(youthWords(text, "descriptor")).toEqual([]);
      expect(REVEALING_WORDS.exec(text)).toBeNull();
    }
  });
});

describe("the hair line (I5.25)", () => {
  test("says the style and that the colour is the reference photo's", () => {
    expect(hairLine("in a low ponytail")).toBe("Today her hair is in a low ponytail: the same hair colour as in the reference photo, only styled differently.");
  });
});

describe("every capture line passes the same word lists as the rest of the look", () => {
  test("no soft-list word, staging phrase, negated look term, youth word or revealing word", () => {
    for (const capture of CAPTURES) {
      for (const key of KEYS.slice(0, 20)) {
        const text = captureLineOf(capture, key);
        expect(SOFT_LIST.exec(text), text).toBeNull();
        expect(firstHit(text, [...STAGING, ...NEGATED_LOOK]), text).toBeNull();
        expect(youthWords(text, "descriptor"), text).toEqual([]);
        expect(REVEALING_WORDS.exec(text), text).toBeNull();
      }
    }
  });
});
