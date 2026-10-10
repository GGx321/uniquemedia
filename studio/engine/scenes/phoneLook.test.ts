import { describe, expect, test } from "bun:test";
import { POOL_TIMES, youthWords } from "../../shared/engine";
import { artefactLine, CAPTURE_LINE, CONSTRAINTS, IMPERFECTIONS, imperfectionOf, lightOf, NEUTRAL_LIGHT, phoneHandLine, roomStateOf, slotKeyOf, type RoomPlace } from "./phoneLook";
import { SHOTS, type Shot } from "./types";
import { revealingWordsIn } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1a: every phone-look phrase lives in phoneLook.ts (I5.1). These tests pin what each phrase must say, the draws that pick among them
// (pure functions of a key, I5.4) and the invariants that bind the text (I5.2, I5.3, I5.10).

const NOT_MIRROR = SHOTS.filter((shot) => shot !== "mirror");
const KEYS = Array.from({ length: 10_000 }, (_, i) => `run-${i}:slot-${(i % 9) + 1}`);

// I5.2: a held or visible phone is the mirror author's alone.
const HELD_PHONE = [/holds? (the|her) phone/i, /phone in (her|one) hand/i, /phone (is )?visible/i];
// I5.3: words that stage a camera or a studio.
const STAGING = [/only she is in focus/i, /full-frame/i, /editorial/i, /shot on a camera/i, /photographer/i, /bokeh/i, /studio lighting/i, /golden hour/i, /softly lit/i];
// I5.10: no negated look terms.
const NEGATED_LOOK = [/\bno (retouching|airbrushing|beauty filter|bokeh|blur|makeup filter)\b/i, /not retouched/i, /without retouching/i];

const KITCHEN: RoomPlace = { room: true, details: ["a kettle on the counter", "a fruit bowl", "a towel on the oven door"], activity: { messyOk: false } };
const BEDROOM: RoomPlace = { room: true, details: ["a charger cable on the bed", "a hoodie on the chair"], activity: { messyOk: true } };

describe("CAPTURE_LINE", () => {
  test.each([...SHOTS])("has a line for the %s author", (shot) => {
    expect(CAPTURE_LINE[shot].length).toBeGreaterThan(40);
  });

  test("the selfie line says she took it on the front camera and that the phone itself is not in the picture", () => {
    expect(CAPTURE_LINE.selfie).toContain("front camera");
    expect(CAPTURE_LINE.selfie).toContain("the phone itself is not in the picture");
  });

  test("the selfie line lets her arm run out of the frame", () => {
    expect(CAPTURE_LINE.selfie).toContain("her arm running out of the frame");
  });

  test("the mirror line is the one that shows the phone, held low enough to leave her face clear", () => {
    expect(CAPTURE_LINE.mirror).toContain("her phone in her hand at chest height");
    expect(CAPTURE_LINE.mirror).toContain("visible in the mirror");
    expect(CAPTURE_LINE.mirror).toContain("leave her face clear");
  });

  test.each(["friend", "photographer"] as const)("the %s line is a friend's rear-camera snap, with her not taking the photo herself", (shot) => {
    expect(CAPTURE_LINE[shot]).toContain("a friend took of her");
    expect(CAPTURE_LINE[shot]).toContain("rear camera");
    expect(CAPTURE_LINE[shot]).toContain("she is not taking the photo herself");
  });

  test("a photographer slot reads exactly like a friend slot (the stored shot stays, the author is a friend)", () => {
    expect(CAPTURE_LINE.photographer).toBe(CAPTURE_LINE.friend);
  });

  test("the friend line asks for the whole body, so a head-and-shoulders frame is not the default", () => {
    expect(CAPTURE_LINE.friend).toContain("her whole body is in the picture");
  });

  test("the candid line is the friend line plus her being busy and not looking toward the camera, with no further phone named", () => {
    expect(CAPTURE_LINE.candid).toBe(`${CAPTURE_LINE.friend} She is busy with something and not looking toward the camera.`);
    expect(CAPTURE_LINE.candid.replace("A quick phone snap", "")).not.toMatch(/\bphone\b/i);
  });

  test.each(NOT_MIRROR)("the %s line matches no held-phone pattern (I5.2)", (shot) => {
    for (const pattern of HELD_PHONE) expect(CAPTURE_LINE[shot]).not.toMatch(pattern);
  });
});

describe("phoneHandLine", () => {
  test("the mirror author holds the phone with one hand and acts with the other", () => {
    expect(phoneHandLine("mirror")).toBe("One hand holds the phone; only her other hand acts.");
  });

  test("the selfie author's phone arm runs out of the frame, so no phone is held in view", () => {
    expect(phoneHandLine("selfie")).toBe("Her phone arm runs out of the frame; only her other hand acts.");
  });

  test.each(["friend", "candid", "photographer"] as const)("the %s author has no phone-hand line", (shot) => {
    expect(phoneHandLine(shot)).toBeNull();
  });

  test.each(NOT_MIRROR)("the %s phone-hand line matches no held-phone pattern (I5.2)", (shot) => {
    const line = phoneHandLine(shot) ?? "";
    for (const pattern of HELD_PHONE) expect(line).not.toMatch(pattern);
  });
});

describe("CONSTRAINTS", () => {
  test("keep the adult-woman line (I5.13)", () => {
    expect(CONSTRAINTS).toStartWith("She is an adult woman.");
  });

  test("ban other people, text, logos, brand names and watermarks", () => {
    expect(CONSTRAINTS).toContain("No other people in the photo; no text, logos, brand names or watermark.");
  });

  test("no longer say she alone is in focus", () => {
    expect(CONSTRAINTS).not.toMatch(/in focus/i);
  });

  test("match no held-phone pattern", () => {
    for (const pattern of HELD_PHONE) expect(CONSTRAINTS).not.toMatch(pattern);
  });
});

describe("lightOf", () => {
  test.each([
    ["morning", "morning daylight"],
    ["midday", "flat midday daylight"],
    ["golden hour", "low late-afternoon sun"],
    ["evening", "the evening lamps, the sky outside already dim"],
    ["night", "a ceiling light or street lamp, a dark background"],
    ["studio lighting", "the room's ceiling lights"],
  ])("names the source of %p light as %p", (time, phrase) => {
    expect(lightOf(time)).toBe(phrase);
  });

  test("is total over the pool vocabulary: every stored time maps to a phrase of its own", () => {
    const phrases = POOL_TIMES.map((time) => lightOf(time));
    expect(new Set(phrases).size).toBe(POOL_TIMES.length);
    for (const phrase of phrases) expect(phrase).not.toBe(NEUTRAL_LIGHT);
  });

  test.each([[undefined], [""], ["twilight"], ["Morning"]])("falls back to the neutral light for %p (own scenes have no time)", (time) => {
    expect(lightOf(time)).toBe("the light where she is");
    expect(NEUTRAL_LIGHT).toBe("the light where she is");
  });

  test("no light phrase stages a studio or a golden hour", () => {
    for (const phrase of [...POOL_TIMES.map((time) => lightOf(time)), NEUTRAL_LIGHT]) {
      for (const pattern of STAGING) expect(phrase).not.toMatch(pattern);
    }
  });
});

describe("IMPERFECTIONS and imperfectionOf", () => {
  test("the selfie author's list is a front-camera wide-angle look and a wide-angle stretch (the tilt is in the capture line)", () => {
    expect(IMPERFECTIONS.selfie).toEqual(["a slight front-camera wide-angle look", "a slight wide-angle stretch at the edges"]);
  });

  test("the mirror author's list is smudges and glare on the mirror", () => {
    expect(IMPERFECTIONS.mirror).toEqual(["a few smudges on the mirror", "a little glare from the ceiling light on the mirror"]);
  });

  test.each(["friend", "candid", "photographer"] as const)("the %s author's list is the friend-snap list", (shot) => {
    expect(IMPERFECTIONS[shot]).toEqual([
      "a little motion blur on her moving hand",
      "slightly washed-out colours",
      "a slightly warm white balance",
    ]);
  });

  test.each([...SHOTS])("draws a %s imperfection from that author's list only", (shot) => {
    for (const key of KEYS.slice(0, 500)) expect(IMPERFECTIONS[shot]).toContain(imperfectionOf(shot, key));
  });

  test.each([...SHOTS])("is the same for the same key, so a resume draws what the first pass drew (I5.4)", (shot) => {
    for (const key of KEYS.slice(0, 200)) expect(imperfectionOf(shot, key)).toBe(imperfectionOf(shot, key));
  });

  test.each([...SHOTS])("reaches every entry of the %s list over many keys", (shot) => {
    const seen = new Set(KEYS.map((key) => imperfectionOf(shot, key)));
    expect([...seen].sort()).toEqual([...IMPERFECTIONS[shot]].sort());
  });

  test("differs between two runs on the same slot, because the run id is in the key", () => {
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => imperfectionOf("friend", slotKeyOf(`run-${i}`, "slot-1"))));
    expect(drawn.size).toBeGreaterThan(1);
  });

  test("differs between two slots of the same run, because the attempt id base is in the key", () => {
    const drawn = new Set(Array.from({ length: 30 }, (_, i) => imperfectionOf("friend", slotKeyOf("run-1", `slot-${i + 1}`))));
    expect(drawn.size).toBeGreaterThan(1);
  });

  test("is drawn on a stream of its own: the room draw for the same key does not follow it", () => {
    // Same key, two draws: if both read one stream, a key that draws the first imperfection would always draw the same room state too.
    const pairs = new Set(KEYS.map((key) => `${imperfectionOf("friend", key)}|${roomStateOf(key, KITCHEN)}`));
    expect(pairs.size).toBeGreaterThan(IMPERFECTIONS.friend.length * 3);
  });
});

describe("an imperfection never repeats its capture line", () => {
  test.each([...SHOTS])("no %s imperfection is part of, or restates, the capture line over 1000 keys", (shot) => {
    const line = CAPTURE_LINE[shot].toLowerCase();
    for (const key of KEYS.slice(0, 1000)) {
      const imperfection = imperfectionOf(shot, key);
      expect(line).not.toContain(imperfection.toLowerCase());
      // «tilted» is the one word both texts use: a capture line that says it leaves it out of the draw.
      if (line.includes("tilted")) expect(imperfection).not.toContain("tilted");
    }
  });

  test.each([...SHOTS])("every %s list entry is safe against the capture line, so no draw needs a retry", (shot) => {
    const line = CAPTURE_LINE[shot].toLowerCase();
    for (const entry of IMPERFECTIONS[shot]) expect(line).not.toContain(entry.toLowerCase());
  });

  test("no imperfection says softness or blur of focus, which conflicts with everything in focus", () => {
    for (const shot of SHOTS) for (const entry of IMPERFECTIONS[shot]) expect(entry).not.toMatch(/softness|soft focus|blurry/i);
  });
});

describe("slotKeyOf", () => {
  test("joins the run id and the attempt id base, the ids a resume keeps", () => {
    expect(slotKeyOf("run-ab12", "slot-3")).toBe("run-ab12:slot-3");
  });
});

describe("roomStateOf", () => {
  const phraseOf = (key: string, place: RoomPlace): string => roomStateOf(key, place) ?? "";
  const share = (count: number): number => (count / KEYS.length) * 100;

  test("is null for no place (an own scene, a renamed or unknown place, a custom category)", () => {
    expect(roomStateOf("run-1:slot-1", null)).toBeNull();
  });

  test("is null for a place that is not a room", () => {
    expect(roomStateOf("run-1:slot-1", { ...KITCHEN, room: false })).toBeNull();
  });

  test("is the same for the same key and place, so a resume draws what the first pass drew (I5.4)", () => {
    for (const key of KEYS.slice(0, 200)) expect(roomStateOf(key, KITCHEN)).toBe(roomStateOf(key, KITCHEN));
  });

  test("differs between runs on the same slot", () => {
    const drawn = new Set(Array.from({ length: 200 }, (_, i) => roomStateOf(slotKeyOf(`run-${i}`, "slot-1"), KITCHEN)));
    expect(drawn.size).toBeGreaterThan(1);
  });

  test("a tidy room is ordinary and fairly tidy, with one of the place's details", () => {
    const tidy = KEYS.map((key) => phraseOf(key, KITCHEN)).filter((phrase) => phrase.startsWith("The room is ordinary and fairly tidy, with "));
    expect(tidy.length).toBeGreaterThan(0);
    for (const phrase of tidy) {
      const detail = KITCHEN.details.find((d) => phrase === `The room is ordinary and fairly tidy, with ${d}.`);
      expect(detail).toBeDefined();
    }
  });

  test("a lived-in room names two different details of the place", () => {
    const livedIn = KEYS.map((key) => phraseOf(key, KITCHEN)).filter((phrase) => phrase.startsWith("The room looks lived-in, with "));
    expect(livedIn.length).toBeGreaterThan(0);
    for (const phrase of livedIn) {
      const named = KITCHEN.details.filter((d) => phrase.includes(d));
      expect(named).toHaveLength(2);
      expect(phrase).toMatch(/^The room looks lived-in, with .+ and .+\.$/);
    }
  });

  test("a messy room has clothes tried on and left on the bed", () => {
    const messy = KEYS.map((key) => phraseOf(key, BEDROOM)).filter((phrase) => phrase.startsWith("The room is messy"));
    expect(messy.length).toBeGreaterThan(0);
    for (const phrase of messy) expect(phrase).toBe("The room is messy, with clothes tried on and left on the bed.");
  });

  test("draws about 70 percent tidy, 25 lived-in and 5 messy on a messyOk activity (within 5 points)", () => {
    const phrases = KEYS.map((key) => phraseOf(key, BEDROOM));
    const tidy = share(phrases.filter((p) => p.startsWith("The room is ordinary")).length);
    const livedIn = share(phrases.filter((p) => p.startsWith("The room looks lived-in")).length);
    const messy = share(phrases.filter((p) => p.startsWith("The room is messy")).length);
    expect(Math.abs(tidy - 70)).toBeLessThanOrEqual(5);
    expect(Math.abs(livedIn - 25)).toBeLessThanOrEqual(5);
    expect(messy).toBeGreaterThan(0);
    expect(messy).toBeLessThanOrEqual(5 + 1);
  });

  test("never draws messy when the activity is not messyOk, and the 5 percent go to lived-in", () => {
    const phrases = KEYS.map((key) => phraseOf(key, KITCHEN));
    expect(phrases.some((p) => p.startsWith("The room is messy"))).toBe(false);
    const tidy = share(phrases.filter((p) => p.startsWith("The room is ordinary")).length);
    const livedIn = share(phrases.filter((p) => p.startsWith("The room looks lived-in")).length);
    expect(Math.abs(tidy - 70)).toBeLessThanOrEqual(5);
    expect(Math.abs(livedIn - 30)).toBeLessThanOrEqual(5);
  });

  test("treats an activity with no messyOk flag as not messyOk", () => {
    const place: RoomPlace = { ...KITCHEN, activity: {} };
    expect(KEYS.some((key) => (roomStateOf(key, place) ?? "").startsWith("The room is messy"))).toBe(false);
  });

  test("tidy and messy draws are the same keys on both places: the messyOk flag only turns the messy keys into lived-in", () => {
    const withFlag = new Map(KEYS.map((key) => [key, phraseOf(key, { ...BEDROOM, details: KITCHEN.details })] as const));
    for (const key of KEYS) {
      const without = phraseOf(key, { ...BEDROOM, details: KITCHEN.details, activity: { messyOk: false } });
      if (withFlag.get(key)?.startsWith("The room is messy") !== true) expect(without).toBe(withFlag.get(key) ?? "");
    }
  });

  test("a room with a single detail never invents a second one: a lived-in draw falls back to the tidy phrase", () => {
    const place: RoomPlace = { room: true, details: ["a kettle on the counter"], activity: { messyOk: false } };
    for (const key of KEYS.slice(0, 500)) expect(roomStateOf(key, place)).toBe("The room is ordinary and fairly tidy, with a kettle on the counter.");
  });

  test("a room with no details has no phrase", () => {
    expect(roomStateOf("run-1:slot-1", { room: true, details: [], activity: { messyOk: true } })).toBeNull();
  });

  test("every phrase passes the youth and revealing word rules", () => {
    for (const key of KEYS.slice(0, 500)) {
      const phrase = phraseOf(key, BEDROOM);
      expect(youthWords(phrase, "descriptor")).toEqual([]);
      expect(revealingWordsIn(phrase)).toEqual([]);
    }
  });
});

describe("artefactLine", () => {
  const ON = artefactLine({ cameraRealism: true, light: "morning daylight", imperfection: "slightly washed-out colours" });
  const OFF = artefactLine({ cameraRealism: false, light: "morning daylight", imperfection: "slightly washed-out colours" });

  test("ON is an ordinary camera-roll phone photo with the light, flat exposure, shadow noise, mild JPEG compression and the imperfection", () => {
    expect(ON).toBe(
      "Ordinary phone photo straight from her camera roll: morning daylight, flat auto-exposure, slight noise in the shadows, mild JPEG compression, slightly washed-out colours, everything in focus, the background as sharp as she is.",
    );
  });

  test("OFF carries the light and the sharp background, and nothing else", () => {
    expect(OFF).toBe("Ordinary phone photo: morning daylight, everything in focus, the background as sharp as she is.");
  });

  test("OFF leaves the imperfection out", () => {
    expect(OFF).not.toContain("washed-out");
  });

  test.each([
    ["ON", ON],
    ["OFF", OFF],
  ])("%s says the background is as sharp as she is", (_name, line) => {
    expect(line).toContain("the background as sharp as she is");
  });

  test.each([
    ["ON", ON],
    ["OFF", OFF],
  ])("%s has no negated look term and no staging word (I5.3, I5.10)", (_name, line) => {
    for (const pattern of [...NEGATED_LOOK, ...STAGING]) expect(line).not.toMatch(pattern);
  });
});

describe("every static phrase", () => {
  const phrases = (): [string, string][] => [
    ...SHOTS.map((shot): [string, string] => [`CAPTURE_LINE.${shot}`, CAPTURE_LINE[shot]]),
    ...SHOTS.map((shot): [string, string] => [`phoneHandLine(${shot})`, phoneHandLine(shot) ?? ""]),
    ...SHOTS.flatMap((shot: Shot) => IMPERFECTIONS[shot].map((text): [string, string] => [`IMPERFECTIONS.${shot}`, text])),
    ["CONSTRAINTS", CONSTRAINTS],
    ["artefact ON", artefactLine({ cameraRealism: true, light: NEUTRAL_LIGHT, imperfection: IMPERFECTIONS.friend[0] ?? "" })],
    ["artefact OFF", artefactLine({ cameraRealism: false, light: NEUTRAL_LIGHT, imperfection: "" })],
  ];

  test.each(phrases())("%s has no youth word and no revealing word", (_name, text) => {
    expect(youthWords(text, "descriptor")).toEqual([]);
    expect(revealingWordsIn(text)).toEqual([]);
  });

  test.each(phrases())("%s has no staging word and no negated look term", (_name, text) => {
    for (const pattern of [...STAGING, ...NEGATED_LOOK]) expect(text).not.toMatch(pattern);
  });
});
