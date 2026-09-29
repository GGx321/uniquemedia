import { beforeAll, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { openEmojiFont } from "./emojiFont";
import { type EmojiTestEntry, keyOf, loadEmojiTest, loadPinnedEmojiFont } from "./emojiFont.testkit";
import { type CaptionRun, segmentCaption } from "./segment";
useNativeGlobals();

const text = (value: string): CaptionRun => ({ kind: "text", text: value });
const emoji = (value: string): CaptionRun => ({ kind: "emoji", text: value, codePoints: [...value].map((c) => c.codePointAt(0) ?? 0) });

describe("text and emoji runs", () => {
  test("gives no runs for the empty string", () => {
    expect(segmentCaption("")).toEqual([]);
  });

  test("keeps plain text as one run", () => {
    expect(segmentCaption("Hello, world")).toEqual([text("Hello, world")]);
  });

  test("keeps Cyrillic text as one run", () => {
    expect(segmentCaption("Привет, мир")).toEqual([text("Привет, мир")]);
  });

  test("splits text, an emoji and text into three runs", () => {
    expect(segmentCaption("Hi 👋 there")).toEqual([text("Hi "), emoji("👋"), text(" there")]);
  });

  test("gives each of two adjacent emoji its own run", () => {
    expect(segmentCaption("😀😀")).toEqual([emoji("😀"), emoji("😀")]);
  });

  test("starts and ends with an emoji without empty text runs", () => {
    expect(segmentCaption("🔥go🔥")).toEqual([emoji("🔥"), text("go"), emoji("🔥")]);
  });

  test("keeps a newline inside the text run", () => {
    expect(segmentCaption("a\nb 😀")).toEqual([text("a\nb "), emoji("😀")]);
  });

  test("keeps a combining mark with its letter in a text run", () => {
    expect(segmentCaption("é")).toEqual([text("é")]);
  });

  test("leaves a lone surrogate in the text", () => {
    expect(segmentCaption("a\ud83d")).toEqual([text("a\ud83d")]);
  });
});

describe("one cluster is one emoji", () => {
  test("a ZWJ sequence", () => {
    expect(segmentCaption("a👩‍💻b")).toEqual([text("a"), emoji("👩‍💻"), text("b")]);
  });

  test("a family of four", () => {
    expect(segmentCaption("👨‍👩‍👧‍👦")).toEqual([emoji("👨‍👩‍👧‍👦")]);
  });

  test("a skin tone", () => {
    expect(segmentCaption("👍🏽")).toEqual([emoji("👍🏽")]);
  });

  test("a flag, and two flags as two", () => {
    expect(segmentCaption("🇺🇸🇩🇪")).toEqual([emoji("🇺🇸"), emoji("🇩🇪")]);
  });

  test("a keycap", () => {
    expect(segmentCaption("1️⃣")).toEqual([emoji("1️⃣")]);
  });

  test("a keycap without VS16", () => {
    expect(segmentCaption("#⃣")).toEqual([emoji("#⃣")]);
  });

  test("a subdivision flag of tag characters", () => {
    expect(segmentCaption("🏴󠁧󠁢󠁥󠁮󠁧󠁿")).toEqual([emoji("🏴󠁧󠁢󠁥󠁮󠁧󠁿")]);
  });

  test("a heart with VS16", () => {
    expect(segmentCaption("I ❤️ U")).toEqual([text("I "), emoji("❤️"), text(" U")]);
  });

  test("a lone skin tone modifier", () => {
    expect(segmentCaption("🏽")).toEqual([emoji("🏽")]);
  });
});

describe("what is not an emoji", () => {
  test("a digit, a hash and an asterisk stay text", () => {
    expect(segmentCaption("1 # *")).toEqual([text("1 # *")]);
  });

  test("a text-presentation symbol without VS16 stays text", () => {
    expect(segmentCaption("© ❤ ☺")).toEqual([text("© ❤ ☺")]);
  });

  test("the same symbol with VS16 is an emoji", () => {
    expect(segmentCaption("©️")).toEqual([emoji("©️")]);
  });

  test("a lone VS16 stays text", () => {
    expect(segmentCaption("a️")).toEqual([text("a️")]);
  });

  test("a lone ZWJ stays text", () => {
    expect(segmentCaption("a‍b")).toEqual([text("a‍b")]);
  });
});

test("the runs always add up to the input", () => {
  const samples = ["", "a", "😀", "a😀b", "🇺🇸x🇩🇪", "1️⃣2️⃣3", "👩‍💻 и 👨‍👩‍👧‍👦!", "‍️⃣", "x\ud83dy", "🏴󠁧󠁢󠁥󠁮󠁧󠁿🏳️‍🌈"];
  expect(samples.map((s) => segmentCaption(s).map((r) => r.text).join(""))).toEqual(samples);
});

test("no two text runs touch", () => {
  const runs = segmentCaption("ab 😀 cd 👍🏽 e");
  const kinds = runs.map((r) => r.kind);
  expect(kinds.some((kind, i) => kind === "text" && kinds[i + 1] === "text")).toBe(false);
});

describe("against the whole emoji-test.txt", () => {
  let entries: EmojiTestEntry[];
  beforeAll(async () => {
    entries = await loadEmojiTest();
  });

  test("every fully-qualified emoji and component segments as exactly one emoji run of its own code points", () => {
    const wrong = entries
      .filter((e) => e.status === "fully-qualified" || e.status === "component")
      .flatMap((e) => {
        const runs = segmentCaption(String.fromCodePoint(...e.codePoints));
        const [run] = runs;
        return runs.length === 1 && run?.kind === "emoji" && keyOf(run.codePoints) === keyOf(e.codePoints) ? [] : [keyOf(e.codePoints)];
      });
    expect(wrong).toEqual([]);
  });

  test("every fully-qualified emoji inside a sentence is still one run, surrounded by its text", () => {
    const wrong = entries
      .filter((e) => e.status === "fully-qualified")
      .flatMap((e) => {
        const runs = segmentCaption(`ab ${String.fromCodePoint(...e.codePoints)} cd`);
        const ok = runs.length === 3 && runs[0]?.kind === "text" && runs[1]?.kind === "emoji" && runs[2]?.kind === "text" && keyOf(runs[1].codePoints) === keyOf(e.codePoints);
        return ok ? [] : [keyOf(e.codePoints)];
      });
    expect(wrong).toEqual([]);
  });
});

describe("speed", () => {
  test("segmenting and checking coverage of a 200-character caption takes under 5 ms", async () => {
    const font = openEmojiFont(await loadPinnedEmojiFont());
    const caption = "Ну что, погнали?! 🔥🔥 Летим в 🇹🇷 с 👨‍👩‍👧‍👦 и 👍🏽, номер 1️⃣ в моём списке ❤️ Лето, море, песок, солнце и никаких забот 😀😀😀 Big news for everyone who reads this caption right now 🎉 ".repeat(2).slice(0, 200);
    expect([...caption].length).toBeLessThanOrEqual(200);
    const once = () => segmentCaption(caption).filter((r) => r.kind === "emoji").every((r) => r.kind === "emoji" && font.has(r.codePoints));
    once();
    const timings: number[] = [];
    for (let i = 0; i < 200; i++) {
      const started = performance.now();
      once();
      timings.push(performance.now() - started);
    }
    timings.sort((a, b) => a - b);
    const median = timings[100] ?? Infinity;
    console.log(`caption of ${[...caption].length} characters: median ${median.toFixed(3)} ms, worst ${(timings[199] ?? 0).toFixed(3)} ms`);
    expect(median).toBeLessThan(5);
  });

  test("has() on a hostile 32-code-point sequence takes well under a millisecond", async () => {
    const font = openEmojiFont(await loadPinnedEmojiFont());
    const hostile = [...Array.from({ length: 16 }, () => [0x1f469, 0x200d]).flat()];
    font.has(hostile);
    const started = performance.now();
    for (let i = 0; i < 1000; i++) font.has(hostile);
    const perCall = (performance.now() - started) / 1000;
    console.log(`has() on a 32-code-point ZWJ chain: ${perCall.toFixed(4)} ms per call`);
    expect(perCall).toBeLessThan(1);
  });
});
