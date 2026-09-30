// The caption rules' boundary cases as plain data, so the same table runs under Bun (captionRules.test.ts) and
// under Electron's Node (captionRules.node-test.ts): `Intl.Segmenter` grapheme rules can differ between the two ICU
// builds, and the caption gate's 60-character limit rests on them (plan 3a.1, 3b.3).
//
// Every entry is one text and the number of characters a person counts in it, written with escapes so no editor
// can change what is tested.

export interface GraphemeCase {
  name: string;
  text: string;
  graphemes: number;
}

const ZWJ = "\u{200D}";
const VS16 = "\u{FE0F}";

export const GRAPHEME_CASES: readonly GraphemeCase[] = [
  { name: "plain ASCII", text: "hello", graphemes: 5 },
  { name: "an emoji is one", text: "\u{1F600}", graphemes: 1 },
  { name: "a skin tone is one with its base", text: "\u{1F44D}\u{1F3FD}", graphemes: 1 },
  { name: "a ZWJ family is one", text: `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}${ZWJ}\u{1F466}`, graphemes: 1 },
  { name: "a ZWJ profession with a skin tone is one", text: `\u{1F469}\u{1F3FD}${ZWJ}\u{1F4BB}`, graphemes: 1 },
  { name: "a flag is one", text: "\u{1F1FA}\u{1F1F8}", graphemes: 1 },
  { name: "two flags are two", text: "\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}", graphemes: 2 },
  { name: "a keycap is one", text: `#${VS16}\u{20E3}`, graphemes: 1 },
  { name: "a keycap without VS16 is one", text: "1\u{20E3}", graphemes: 1 },
  { name: "a subdivision flag (England) is one", text: "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", graphemes: 1 },
  { name: "a letter with a combining mark is one", text: "e\u{301}", graphemes: 1 },
  { name: "a letter with two combining marks is one", text: "e\u{301}\u{323}", graphemes: 1 },
  { name: "CRLF is one", text: "a\r\nb", graphemes: 3 },
  { name: "LF is one", text: "a\nb", graphemes: 3 },
  { name: "a text-style pictograph with VS16 is one", text: `\u{2764}${VS16}`, graphemes: 1 },
  { name: "a text-style pictograph followed by VS15 is one", text: "\u{2764}\u{FE0E}", graphemes: 1 },
  { name: "a copyright sign with VS16 is one", text: `\u{A9}${VS16}`, graphemes: 1 },
  { name: "text around an emoji", text: "Hi \u{1F44B} there", graphemes: 10 },
  { name: "a lone ZWJ after a letter joins it", text: `a${ZWJ}b`, graphemes: 2 },
];
