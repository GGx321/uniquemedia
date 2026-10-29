import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { BANKS, CUES } from "../../shared/scenes/banks";
import { sentenceProblems } from "./assembler";
import { plainSentence } from "../../shared/scenes/plain";
import { plan } from "./planner";
useNativeGlobals();

// 5a.2 (S5.6d, plan s5a2 §5.5 «After the last attempt»): a planned slot the model could not write in its two answered attempts takes the plain sentence
// «{at or "At " + location}, she is {activity}, wearing {outfit}.», built from the slot's own texts alone.

const SLOT = { category: "cat-paris-cafes", location: "the riverside cafe", activity: "walking along the river", outfit: "a denim jacket and a long skirt" };

describe("plainSentence carries «Подача» (S5.7b)", () => {
  const FLIRTY_CUES = CUES.filter((c) => c.level === "flirty").map((c) => c.text);
  const bar = { category: "glamour", location: "a cocktail bar", activity: "leans on the counter", outfit: "a navy wrap dress", shot: "friend" as const, capture: "friend" as const };

  test("a flirty slot ends with one flirty cue, before the full stop", () => {
    const sentence = plainSentence({ route: undefined, ...bar, level: "flirty" });
    expect(FLIRTY_CUES.filter((cue) => sentence.endsWith(`, ${cue}.`))).toHaveLength(1);
  });

  test("an ordinary slot reads as it always did", () => {
    expect(plainSentence({ ...bar, route: undefined })).toBe("At a cocktail bar, she leans on the counter, wearing a navy wrap dress.");
  });

  test("the same flirty slot always reads the same", () => {
    expect(plainSentence({ route: undefined, ...bar, level: "flirty" })).toBe(plainSentence({ route: undefined, ...bar, level: "flirty" }));
  });

  test("a frame whose face does not show says no cue, flirty or not", () => {
    const hidden = { ...bar, shot: "mirror" as const, capture: "mirror-hidden" as const, level: "flirty" as const };
    expect(plainSentence({ ...hidden, route: undefined })).toBe(plainSentence({ ...hidden, level: undefined, route: undefined }));
  });

  test("a moment that shows its own expression gets no cue", () => {
    const laughs = { ...bar, activity: "laughs at something nearby", level: "flirty" as const };
    expect(plainSentence({ ...laughs, route: undefined })).toBe(plainSentence({ ...laughs, level: undefined, route: undefined }));
  });

  test("a self-shot slot's flirty cue names no phone and no selfie", () => {
    const sentence = plainSentence({ route: undefined, ...bar, shot: "selfie", capture: "selfie", level: "flirty" });
    expect(sentence).not.toMatch(/phone|selfie/i);
  });
});

describe("plainSentence", () => {
  test("a custom slot reads «{place}, she is {activity}, wearing {outfit}.»", () => {
    expect(plainSentence({ ...SLOT, route: undefined })).toBe("At the riverside cafe, she is walking along the river, wearing a denim jacket and a long skirt.");
  });

  test("a built-in slot whose place the bank knows by name opens with the bank's own locative phrase", () => {
    const place = BANKS.home.places[0];
    if (place === undefined) throw new Error("the home bank has no place");
    const sentence = plainSentence({ route: undefined, category: "home", location: place.name, activity: "folding a blanket", outfit: "an oversized tee" });
    expect(sentence).toBe(`${place.at.charAt(0).toUpperCase()}${place.at.slice(1)}, she is folding a blanket, wearing an oversized tee.`);
    expect(sentence).not.toMatch(/^At /);
  });

  // Round-1 review: the sentence reads as English for the shapes real pools store (shared/scenes/custom.ts `locativeOf` and `rendersActivity`).
  test.each([
    ["a bright kitchen", "holding a mug", "In a bright kitchen, she is holding a mug, wearing a white t-shirt."],
    ["in a cozy cafe", "holding a mug", "In a cozy cafe, she is holding a mug, wearing a white t-shirt."],
    ["the beach", "walking along the shore", "On the beach, she is walking along the shore, wearing a white t-shirt."],
    ["a corner table", "holding a mug", "At a corner table, she is holding a mug, wearing a white t-shirt."],
    ["a corner cafe in Paris", "takes a short break", "At a corner cafe in Paris, she takes a short break, wearing a white t-shirt."],
    ["a bright kitchen", "on her stomach, scrolling", "In a bright kitchen, she is on her stomach, scrolling, wearing a white t-shirt."],
  ])("a place the bank does not know (%j) and an activity (%j) read: %j", (location, activity, expected) => {
    expect(plainSentence({ route: undefined, category: "home", location, activity, outfit: "a white t-shirt" })).toBe(expected);
  });

  // S5.6R (LOW): a custom activity that is a noun phrase read «she morning stretches» and «she a slow walk by the water». It now reads «she is enjoying …»; one
  // that opens with a preposition reads «she is …»; one that opens with a verb of its own keeps it.
  test.each([
    ["morning stretches", "In her living room, she is enjoying morning stretches, wearing a sundress."],
    ["a slow walk by the water", "In her living room, she is enjoying a slow walk by the water, wearing a sundress."],
    ["on the phone with her sister", "In her living room, she is on the phone with her sister, wearing a sundress."],
    ["at the window, smiling", "In her living room, she is at the window, smiling, wearing a sundress."],
    ["waters the plants", "In her living room, she waters the plants, wearing a sundress."],
  ])("a custom activity %j reads as a sentence: %j", (activity, expected) => {
    expect(plainSentence({ route: undefined, category: "cat-summer-days", location: "her living room", activity, outfit: "a sundress" })).toBe(expected);
  });

  // S5.6R (round D, LOW): a noun that ends in «s» is not a verb («pilates class», «tennis practice», «aerobics»); an activity that already opens with «is» is not wrapped again.
  test.each([
    ["pilates class", "In her living room, she is enjoying pilates class, wearing a sundress."],
    ["aerobics", "In her living room, she is enjoying aerobics, wearing a sundress."],
    ["is reading", "In her living room, she is reading, wearing a sundress."],
    ["takes a short break", "In her living room, she takes a short break, wearing a sundress."],
    ["stretches by the window", "In her living room, she stretches by the window, wearing a sundress."],
  ])("a custom activity %j that a plain «-s» test took for a verb reads: %j", (activity, expected) => {
    expect(plainSentence({ route: undefined, category: "cat-summer-days", location: "her living room", activity, outfit: "a sundress" })).toBe(expected);
  });

  test("a real custom pool's activities never read «she is enjoying is», and a noun never follows «she» bare", () => {
    const activities = ["pilates class", "tennis practice", "aerobics", "is reading", "yoga flow", "gymnastics", "darts night", "waters the plants", "takes a short break"];
    for (const activity of activities) {
      const sentence = plainSentence({ route: undefined, category: "cat-summer-days", location: "her living room", activity, outfit: "a sundress" });
      expect(sentence).not.toMatch(/enjoying is\b|\bis is\b/);
      expect(sentence).not.toMatch(/\bshe (?:pilates|tennis|aerobics|gymnastics|darts)\b/);
    }
  });

  test("a place and a moment the bank knows by name read as the template reads them: «she {moment}»", () => {
    const place = BANKS.home.places.find((p) => p.moments.length > 0);
    const moment = place?.moments[0];
    if (place === undefined || moment === undefined) throw new Error("the home bank has no moment");
    const sentence = plainSentence({ route: undefined, category: "home", location: place.name, activity: moment.text, outfit: "an oversized tee" });
    expect(sentence).toBe(`${place.at.charAt(0).toUpperCase()}${place.at.slice(1)}, she ${moment.text}, wearing an oversized tee.`);
  });

  // Rule C1: a self-shot sentence never names a phone or says selfie (it draws a second phone). The offending clause is dropped; the sentence stays whole.
  describe("on a selfie slot", () => {
    const selfie = { category: "cat-paris-cafes", shot: "selfie" as const };
    test("an outfit that names a phone is left out", () => {
      const sentence = plainSentence({ route: undefined, ...selfie, location: "the riverside cafe", activity: "walking along the river", outfit: "a phone-print hoodie" });
      expect(sentence).toBe("At the riverside cafe, she is walking along the river.");
    });
    test("a place that says selfie and an activity that names a phone are left out too", () => {
      const sentence = plainSentence({ route: undefined, ...selfie, location: "a selfie wall", activity: "scrolling her phone", outfit: "a linen dress" });
      expect(sentence).toBe("She stands there, wearing a linen dress.");
    });
    test("every capture that rides on a selfie shot is held to it", () => {
      for (const capture of ["selfie", "above", "prone"] as const) expect(plainSentence({ route: undefined, ...selfie, capture, location: "a cafe", activity: "texting", outfit: "a phone case dress" })).not.toMatch(/phone|texting|selfie/i);
    });
    test("a friend's photo keeps the words: a phone in a friend's snap is fine", () => {
      expect(plainSentence({ route: undefined, category: "cat-paris-cafes", shot: "friend", location: "a cafe", activity: "scrolling her phone", outfit: "a linen dress" })).toContain("phone");
    });
  });

  test("a trailing full stop or comma in a stored text does not double the sentence's punctuation", () => {
    expect(plainSentence({ route: undefined, ...SLOT, activity: "walking along the river.", outfit: "a denim jacket," })).toBe("At the riverside cafe, she is walking along the river, wearing a denim jacket.");
  });

  test("a slot's legwear is not part of the plain sentence", () => {
    expect(plainSentence({ route: undefined, ...SLOT, legwear: "white knee-high socks" } as typeof SLOT & { route: undefined })).not.toContain("socks");
  });

  test("every slot of a planned run reads as one sentence that passes the youth and revealing word rules", () => {
    const slots = plan({ seed: 7, count: 60, categories: ["home", "travel", "photoshoot", "glamour", "fitness"] }).slots;
    for (const slot of slots) {
      const sentence = plainSentence({ ...slot, route: slot.route });
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence.slice(0, -1)).not.toContain(".");
      expect(sentenceProblems(sentence)).toEqual([]);
    }
  });
});
