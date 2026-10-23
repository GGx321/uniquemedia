// Test data only (S5.WCX): the usage of every part C attempt the two paid probes recorded on grok-4.3, numbers alone (no id, no text). `completion` counts the reasoning tokens, which the
// provider bills as completion; `costMicros` is the provider's bill (`usage.cost`) in micro-dollars.
//
// - P-M (2026-10-17, .omc/stage5/harness/out/pm.md): 9 vision attempts and 10 translation attempts, reasoning effort "low". The two translation bills above their reserve
//   (3 449 and 4 111 µ$, the second the «T7» one) stopped the ledger then.
// - P-R (2026-10-17, out/pr.md): 29 translation attempts in four arms: A effort "low", B "none", C `reasoning.max_tokens: 256` (it RAISED reasoning), D "minimal".

export interface ProbeUsage {
  readonly probe: "P-M" | "P-R";
  readonly call: "suggest" | "translate";
  /** What the request sent as `reasoning`. */
  readonly reasoning: "low" | "none" | "minimal" | "max_tokens 256";
  readonly prompt: number;
  readonly completion: number;
  readonly reasoningTokens: number;
  readonly costMicros: number;
}

const pm = (call: ProbeUsage["call"], prompt: number, completion: number, reasoningTokens: number, costMicros: number): ProbeUsage => ({
  probe: "P-M",
  call,
  reasoning: "low",
  prompt,
  completion,
  reasoningTokens,
  costMicros,
});
const pr = (reasoning: ProbeUsage["reasoning"], prompt: number, completion: number, reasoningTokens: number, costMicros: number): ProbeUsage => ({
  probe: "P-R",
  call: "translate",
  reasoning,
  prompt,
  completion,
  reasoningTokens,
  costMicros,
});

export const PROBE_USAGES: readonly ProbeUsage[] = [
  // P-M, the vision writer
  pm("suggest", 1_288, 850, 716, 3_601),
  pm("suggest", 1_282, 812, 676, 3_498),
  pm("suggest", 1_281, 969, 836, 3_889),
  pm("suggest", 1_284, 896, 779, 3_711),
  pm("suggest", 1_291, 859, 728, 3_627),
  pm("suggest", 1_282, 644, 532, 3_078),
  pm("suggest", 1_285, 734, 597, 3_307),
  pm("suggest", 1_284, 926, 798, 3_786),
  pm("suggest", 1_288, 1_200, 1_062, 3_266),
  // P-M, the translator
  pm("translate", 542, 408, 392, 1_563),
  pm("translate", 534, 611, 598, 2_061),
  pm("translate", 536, 577, 563, 1_978),
  pm("translate", 534, 668, 654, 2_203),
  pm("translate", 534, 781, 770, 2_486),
  pm("translate", 548, 808, 797, 2_571),
  pm("translate", 531, 1_168, 1_155, 3_449),
  pm("translate", 534, 1_431, 1_417, 4_111),
  pm("translate", 541, 569, 556, 1_964),
  pm("translate", 557, 557, 544, 1_954),
  // P-R, the translator in four arms
  pr("none", 534, 16, 0, 573),
  pr("max_tokens 256", 540, 1_037, 1_024, 3_133),
  pr("minimal", 540, 640, 628, 2_141),
  pr("low", 540, 567, 553, 1_958),
  pr("low", 557, 725, 711, 2_374),
  pr("low", 538, 986, 973, 3_003),
  pr("none", 530, 15, 0, 566),
  pr("none", 548, 15, 0, 588),
  pr("max_tokens 256", 537, 1_808, 1_794, 5_057),
  pr("max_tokens 256", 554, 2_587, 2_575, 7_026),
  pr("minimal", 538, 525, 512, 1_851),
  pr("low", 542, 316, 300, 1_064),
  pr("low", 540, 492, 479, 1_771),
  pr("none", 532, 20, 0, 581),
  pr("none", 555, 14, 0, 326),
  pr("max_tokens 256", 540, 1_774, 1_756, 4_976),
  pr("max_tokens 256", 557, 1_986, 1_969, 5_527),
  pr("minimal", 538, 1_141, 1_129, 3_391),
  pr("minimal", 553, 1_038, 1_025, 3_152),
  pr("low", 538, 1_007, 993, 3_056),
  pr("low", 537, 1_162, 1_145, 3_442),
  pr("none", 530, 13, 0, 561),
  pr("minimal", 542, 455, 439, 1_277),
  pr("low", 540, 524, 511, 1_851),
  pr("low", 540, 817, 803, 2_180),
  pr("low", 540, 1_085, 1_067, 2_984),
  pr("low", 557, 801, 787, 2_161),
  pr("low", 538, 735, 723, 2_376),
  pr("low", 553, 1_064, 1_052, 3_217),
];

/** The «T7» attempt of P-M: the translation that billed 4 111 µ$ against a reserve of about 3 140. */
export const T7_USAGE: ProbeUsage = pm("translate", 534, 1_431, 1_417, 4_111);
