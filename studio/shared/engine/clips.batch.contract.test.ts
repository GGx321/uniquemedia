import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CLIP_CANCEL_DETAILS,
  CLIP_OPTION_KEYS,
  CLIP_PHASES,
  ClipBatchItem,
  ClipBatchOptions,
  ClipCancelDetail,
  ClipSummary,
  MAX_BATCH_CLIPS,
  MAX_CLIPS_IN_FLIGHT,
  clipBatchExpectedMicros,
  clipBatchWorstMicros,
  clipExpectedMicros,
  clipWorstMicros,
  type BoldClipsMode,
  type ClipBatchParts,
  type ClipPrices,
} from "./clips";
import { CLIP_REASONS, CLIP_IN_FLIGHT_REASONS, EngineError } from "./errors";
import { CLIP_REASONS_RU, clipBatchDroppedRu, clipCancelDetailRu } from "./errorMessagesRu";
import { COMMAND_TYPES, ENGINE_COMMAND_TYPES, MAIN_ONLY_COMMANDS, OkResponse } from "./commands";
import { SLEEP_CLASS, heldWhileAsleep } from "./commandHold";
import { PROTOCOL_VERSION } from "./envelope";
import { parseEngineCommand } from "./messages";
import { EventMessage } from "./events";
import { JobCancelled, JobProgress, JobState } from "./state";

// Stage 5, 5b.2, S5.WB1 (plan s5b2 §5.2, I5.61-I5.63, §6, §8 «S5.WB1 contract B»): the contract of the batch «Оживить выбранные». Three commands, the queued phase and the batch fields of a clip job,
// two IN_FLIGHT reasons, the cancelled-member details and their Russian texts, and the one batch price formula. Everything is additive in protocol 5: each shape is tried in its old form first.

const AVATAR = "avatar-aaaa-0001";
const BATCH = "batch-00000001";
const JOB = "job-00000001";
const CLIP = "clip-0000001";
const photoId = (i: number): string => `photo-${String(i + 1).padStart(4, "0")}`;
const item = (i: number) => ({ photoId: photoId(i), motionId: "scene" });
const items = (n: number) => Array.from({ length: n }, (_, i) => item(i));
const createPayload = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ avatarId: AVATAR, items: items(2), quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 1_700_000, ...over });

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

// The dated price table of 5b.1 §5.9, the one clips.test.ts uses: Kling std 84 000 µ$/s, pro 112 000, Grok 140 000 + 10 000 per input image.
const PRICES: ClipPrices = {
  std: { perSecondMicros: 84_000, perInputImageMicros: 0 },
  pro: { perSecondMicros: 112_000, perInputImageMicros: 0 },
  grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 },
};
const parts = (over: Partial<ClipBatchParts> = {}): ClipBatchParts => ({ quality: "std", seconds: 5, mode: "auto", fallback: "auto", prices: PRICES, ...over });
const members = (n: number, bold = false) => Array.from({ length: n }, () => ({ bold }));

const estimate = (expectedMicros: number, worstMicros: number) => ({ expectedMicros, worstMicros, prices: "live" as const, pricesAsOf: "2026-10-14" });
const motion = { id: "scene", source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" };
const clipPrices = { std5: estimate(420_000, 850_000), pro5: estimate(560_000, 850_000), std10: estimate(840_000, 1_550_000), pro10: estimate(1_120_000, 1_550_000), grok5: estimate(710_000, 850_000), grok10: estimate(1_410_000, 1_550_000) };
const noFallbackPrices = { std5: estimate(420_000, 504_000), pro5: estimate(560_000, 672_000), std10: estimate(840_000, 924_000), pro10: estimate(1_120_000, 1_232_000) };
const fits = { std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" };
const suitable = (i: number) => ({ suitable: true, photoId: photoId(i), motions: [motion], prices: clipPrices, fallback: "auto", bold: false, noFallbackPrices, monthFits: fits });
const sum = (expected: number, worst: number, worstNoFallback: number) => ({ expected, worst, worstNoFallback });
const sums = { std5: sum(840_000, 1_700_000, 1_008_000), pro5: sum(1_120_000, 1_700_000, 1_344_000), std10: sum(1_680_000, 3_100_000, 1_848_000), pro10: sum(2_240_000, 3_100_000, 2_464_000) };
const batchOptions = (over: Record<string, unknown> = {}) => ({ items: [suitable(0), suitable(1)], sums, monthRoomMicros: 6_200_000, monthFits: fits, ...over });

// ---------- the constants ----------

describe("the batch constants", () => {
  test("a batch holds at most 20 clips", () => {
    expect(MAX_BATCH_CLIPS).toBe(20);
  });

  test("B1 keeps one Kling attempt in flight (I5.61, Q-E = 1)", () => {
    expect<number>(MAX_CLIPS_IN_FLIGHT).toBe(1);
  });

  describe("are declared once, in shared/engine/clips.ts", () => {
    const STUDIO = resolve(import.meta.dir, "../..");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === ".cache" ? [] : walk(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const sources = walk(STUDIO).map((file) => ({ file: file.slice(STUDIO.length + 1).replaceAll("\\", "/"), text: readFileSync(file, "utf8") }));
    const declaring = (name: string): string[] => sources.filter((s) => new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`).test(s.text)).map((s) => s.file);

    test("MAX_BATCH_CLIPS", () => {
      expect(declaring("MAX_BATCH_CLIPS")).toEqual(["shared/engine/clips.ts"]);
    });

    test("MAX_CLIPS_IN_FLIGHT", () => {
      expect(declaring("MAX_CLIPS_IN_FLIGHT")).toEqual(["shared/engine/clips.ts"]);
    });

    test("both are exported", () => {
      const own = sources.find((s) => s.file === "shared/engine/clips.ts")?.text ?? "";
      expect(own).toMatch(/export const MAX_BATCH_CLIPS\b/);
      expect(own).toMatch(/export const MAX_CLIPS_IN_FLIGHT\b/);
    });
  });
});

// ---------- the commands ----------

const BATCH_COMMANDS = ["clips.batchOptions", "clips.createBatch", "clips.cancelBatch"] as const;

describe("the batch commands exist", () => {
  test("all three are engine commands, none is main's", () => {
    for (const type of BATCH_COMMANDS) {
      expect(COMMAND_TYPES).toContain(type);
      expect(ENGINE_COMMAND_TYPES as readonly string[]).toContain(type);
      expect(MAIN_ONLY_COMMANDS as readonly string[]).not.toContain(type);
    }
  });

  test("batchOptions and cancelBatch are free, createBatch alone is held while the Mac sleeps", () => {
    expect(SLEEP_CLASS["clips.batchOptions"]).toBe("free");
    expect(SLEEP_CLASS["clips.cancelBatch"]).toBe("free");
    expect(SLEEP_CLASS["clips.createBatch"]).toBe("held");
    expect(heldWhileAsleep("clips.createBatch")).toBe(true);
    expect(heldWhileAsleep("clips.batchOptions")).toBe(false);
    expect(heldWhileAsleep("clips.cancelBatch")).toBe(false);
  });
});

describe("clips.batchOptions", () => {
  const payload = (over: Record<string, unknown> = {}) => ({ avatarId: AVATAR, photoIds: [photoId(0), photoId(1)], ...over });

  test("takes an avatar and one to twenty unique photo ids", () => {
    expect(accepts("clips.batchOptions", payload())).toBe(true);
    expect(accepts("clips.batchOptions", payload({ photoIds: [photoId(0)] }))).toBe(true);
    expect(accepts("clips.batchOptions", payload({ photoIds: items(20).map((x) => x.photoId) }))).toBe(true);
  });

  test("refuses no photo, twenty-one photos, a repeated photo and a bad id", () => {
    expect(accepts("clips.batchOptions", payload({ photoIds: [] }))).toBe(false);
    expect(accepts("clips.batchOptions", payload({ photoIds: items(21).map((x) => x.photoId) }))).toBe(false);
    expect(accepts("clips.batchOptions", payload({ photoIds: [photoId(0), photoId(0)] }))).toBe(false);
    expect(accepts("clips.batchOptions", payload({ photoIds: ["../x"] }))).toBe(false);
  });

  test("is strict: no extra key, and the avatar is required", () => {
    expect(accepts("clips.batchOptions", payload({ quality: "std" }))).toBe(false);
    expect(accepts("clips.batchOptions", { photoIds: [photoId(0)] })).toBe(false);
  });

  test("answers the per-photo options, the four sums, the month's room and what fits", () => {
    expect(answers("clips.batchOptions", batchOptions())).toBe(true);
  });
});

describe("clips.createBatch", () => {
  test("takes the members in pick order with the batch-wide quality, length and fallback, and the accepted worst case", () => {
    expect(accepts("clips.createBatch", createPayload())).toBe(true);
    expect(accepts("clips.createBatch", createPayload({ items: items(1) }))).toBe(true);
    expect(accepts("clips.createBatch", createPayload({ items: items(20), quality: "pro", seconds: 10, fallback: "none" }))).toBe(true);
  });

  test("refuses no member and twenty-one members", () => {
    expect(accepts("clips.createBatch", createPayload({ items: [] }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ items: items(21) }))).toBe(false);
  });

  test("refuses a photo twice, even with another motion", () => {
    expect(accepts("clips.createBatch", createPayload({ items: [item(0), { photoId: photoId(0), motionId: "g-wave" }] }))).toBe(false);
  });

  test("is strict: no model (Grok never enters a batch), no motion text, no path, no per-item key", () => {
    expect(accepts("clips.createBatch", createPayload({ model: "grok" }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ model: "kling" }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ motion: "she waves" }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ items: [{ ...item(0), text: "she waves" }] }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ items: [{ ...item(0), model: "grok" }] }))).toBe(false);
  });

  test("a motion is an id (`scene` or `g-<slug>`), never free text (I5.51)", () => {
    expect(accepts("clips.createBatch", createPayload({ items: [{ photoId: photoId(0), motionId: "g-slow-turn" }] }))).toBe(true);
    expect(accepts("clips.createBatch", createPayload({ items: [{ photoId: photoId(0), motionId: "she slowly waves" }] }))).toBe(false);
    expect(ClipBatchItem.safeParse({ photoId: photoId(0), motionId: "" }).success).toBe(false);
  });

  test("quality, length and fallback are required and closed; `offer` is not a sheet choice", () => {
    for (const key of ["quality", "seconds", "fallback", "acceptedWorstMicros", "avatarId"]) {
      const { [key]: _gone, ...rest } = createPayload();
      expect(accepts("clips.createBatch", rest)).toBe(false);
    }
    expect(accepts("clips.createBatch", createPayload({ quality: "hd" }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ seconds: 7 }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ fallback: "offer" }))).toBe(false);
  });

  test("the accepted worst case is a whole number of micro-dollars, never a float or a negative", () => {
    expect(accepts("clips.createBatch", createPayload({ acceptedWorstMicros: 1_700_000.5 }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ acceptedWorstMicros: -1 }))).toBe(false);
    expect(accepts("clips.createBatch", createPayload({ acceptedWorstMicros: 0 }))).toBe(true);
  });

  test("answers the batch id and one job id per member, at most twenty and none twice", () => {
    expect(answers("clips.createBatch", { batchId: BATCH, jobIds: ["job-00000001", "job-00000002"] })).toBe(true);
    expect(answers("clips.createBatch", { batchId: BATCH, jobIds: [] })).toBe(false);
    expect(answers("clips.createBatch", { batchId: BATCH, jobIds: Array.from({ length: 21 }, (_, i) => `job-${String(i + 1).padStart(8, "0")}`) })).toBe(false);
    expect(answers("clips.createBatch", { batchId: BATCH, jobIds: ["job-00000001", "job-00000001"] })).toBe(false);
    expect(answers("clips.createBatch", { jobIds: ["job-00000001"] })).toBe(false);
    expect(answers("clips.createBatch", { batchId: BATCH, jobIds: ["job-00000001"], extra: 1 })).toBe(false);
  });
});

describe("clips.cancelBatch", () => {
  test("takes an avatar and a batch and nothing else", () => {
    expect(accepts("clips.cancelBatch", { avatarId: AVATAR, batchId: BATCH })).toBe(true);
    expect(accepts("clips.cancelBatch", { avatarId: AVATAR })).toBe(false);
    expect(accepts("clips.cancelBatch", { avatarId: AVATAR, batchId: BATCH, jobId: JOB })).toBe(false);
  });

  test("answers how many queued members it cancelled, possibly none", () => {
    expect(answers("clips.cancelBatch", { cancelled: 3 })).toBe(true);
    expect(answers("clips.cancelBatch", { cancelled: 0 })).toBe(true);
    expect(answers("clips.cancelBatch", { cancelled: -1 })).toBe(false);
    expect(answers("clips.cancelBatch", { cancelled: 1.5 })).toBe(false);
    expect(answers("clips.cancelBatch", { cancelled: MAX_BATCH_CLIPS })).toBe(true);
    expect(answers("clips.cancelBatch", { cancelled: MAX_BATCH_CLIPS + 1 })).toBe(false);
    expect(answers("clips.cancelBatch", {})).toBe(false);
  });
});

describe("no clip command payload has a free motion text (static, I5.51)", () => {
  test("no batch payload accepts a `motion`, `text`, `prompt` or `idea` key at the top or in a member", () => {
    for (const key of ["motion", "text", "prompt", "idea", "label"]) {
      expect(accepts("clips.createBatch", createPayload({ [key]: "she waves" }))).toBe(false);
      expect(accepts("clips.createBatch", createPayload({ items: [{ ...item(0), [key]: "she waves" }] }))).toBe(false);
      expect(accepts("clips.batchOptions", { avatarId: AVATAR, photoIds: [photoId(0)], [key]: "she waves" })).toBe(false);
    }
  });
});

describe("ClipBatchOptions", () => {
  test("holds one to twenty photos' options, a suitable photo or an unsuitable one with its reason", () => {
    expect(ClipBatchOptions.safeParse(batchOptions()).success).toBe(true);
    expect(ClipBatchOptions.safeParse(batchOptions({ items: [suitable(0), { suitable: false, photoId: photoId(1), reason: "bold-off" }] })).success).toBe(true);
    expect(ClipBatchOptions.safeParse(batchOptions({ items: [] })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ items: Array.from({ length: 21 }, (_, i) => suitable(i)) })).success).toBe(false);
  });

  test("a photo appears once", () => {
    expect(ClipBatchOptions.safeParse(batchOptions({ items: [suitable(0), suitable(0)] })).success).toBe(false);
  });

  test("the sums are the four Kling options in whole micro-dollars", () => {
    for (const key of CLIP_OPTION_KEYS) {
      const { [key]: _gone, ...rest } = sums;
      expect(ClipBatchOptions.safeParse(batchOptions({ sums: rest })).success).toBe(false);
    }
    expect(ClipBatchOptions.safeParse(batchOptions({ sums: { ...sums, std5: sum(840_000.5, 1_700_000, 1_008_000) } })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ sums: { ...sums, std5: { ...sums.std5, extra: 1 } } })).success).toBe(false);
  });

  test("a sum's worst is never below its expected figure, and the no-fallback worst sits between the two", () => {
    expect(ClipBatchOptions.safeParse(batchOptions({ sums: { ...sums, std5: sum(1_800_000, 1_700_000, 1_008_000) } })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ sums: { ...sums, std5: sum(840_000, 1_700_000, 1_900_000) } })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ sums: { ...sums, std5: sum(840_000, 1_700_000, 800_000) } })).success).toBe(false);
  });

  test("the month's room is a whole non-negative figure, and every option says what fits", () => {
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: -1 })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: 1.5 })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ monthFits: { ...fits, std5: "maybe" } })).success).toBe(false);
    expect(ClipBatchOptions.safeParse(batchOptions({ monthFits: { std5: "none", pro5: "none", std10: "without-fallback", pro10: "none" } })).success).toBe(true);
    const { std5: _gone, ...partial } = fits;
    expect(ClipBatchOptions.safeParse(batchOptions({ monthFits: partial })).success).toBe(false);
  });

  // monthRoomMicros = max(0, monthlyBudget - (spent + open + held)): the `#monthFits` / `tryHold` model, not `Engine.monthRoom()` (the autopilot's caps). monthFits is the engine's verdict on the whole batch.
  test("an option fits the month with its fallback only if its worst case is within the room", () => {
    const room = 3_000_000;
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: room })).success).toBe(false);
    const fit = { std5: "with-fallback", pro5: "with-fallback", std10: "without-fallback", pro10: "without-fallback" };
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: room, monthFits: fit })).success).toBe(true);
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: room, monthFits: { ...fit, std10: "with-fallback" } })).success).toBe(false);
  });

  test("an option fits the month without its fallback only if the Kling-alone worst case is within the room", () => {
    const tight = { ...fits, std5: "without-fallback" };
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: 1_008_000, monthFits: { ...tight, pro5: "none", std10: "none", pro10: "none" } })).success).toBe(true);
    expect(ClipBatchOptions.safeParse(batchOptions({ monthRoomMicros: 1_007_999, monthFits: { ...tight, pro5: "none", std10: "none", pro10: "none" } })).success).toBe(false);
  });

  test("a batch where no member allows Grok never fits `with-fallback`: it reports `without-fallback`, like a single clip", () => {
    const klingOnly = (i: number) => ({ ...suitable(i), fallback: "none", monthFits: { std5: "none", pro5: "none", std10: "none", pro10: "none" } });
    const same = { std5: "without-fallback", pro5: "without-fallback", std10: "without-fallback", pro10: "without-fallback" };
    expect(ClipBatchOptions.safeParse(batchOptions({ items: [klingOnly(0), klingOnly(1)], monthFits: same })).success).toBe(true);
    expect(ClipBatchOptions.safeParse(batchOptions({ items: [klingOnly(0), klingOnly(1)], monthFits: fits })).success).toBe(false);
  });

  test("a batch where one member allows Grok may fit `with-fallback`", () => {
    const klingOnly = { ...suitable(1), fallback: "none", monthFits: { std5: "none", pro5: "none", std10: "none", pro10: "none" } };
    expect(ClipBatchOptions.safeParse(batchOptions({ items: [suitable(0), klingOnly], monthFits: fits })).success).toBe(true);
  });
});

// ---------- the one batch formula ----------

describe("clipBatchWorstMicros and clipBatchExpectedMicros (I5.62)", () => {
  test("a Kling-only batch of five at std 5 s is five times $0.504 (the real reserve: (5 + 1) x 84 000)", () => {
    expect(clipBatchWorstMicros(members(5), parts({ fallback: "none" }))).toBe(5 * 504_000);
  });

  test("in mode auto with a fallback allowed each clip counts the dearer branch, Kling + Grok's $0.85", () => {
    expect(clipBatchWorstMicros(members(5), parts())).toBe(5 * 850_000);
  });

  test("a «Смелая» member is Kling alone, whatever the batch says (BOLD_CLIPS = kling-only)", () => {
    expect(clipBatchWorstMicros([{ bold: true }, { bold: false }], parts())).toBe(504_000 + 850_000);
  });

  test("mode offer counts Kling alone", () => {
    expect(clipBatchWorstMicros(members(3), parts({ mode: "offer" }))).toBe(3 * 504_000);
  });

  test("the expected figure is the billed price, Kling completed, per member", () => {
    expect(clipBatchExpectedMicros(members(5), parts())).toBe(5 * 420_000);
    expect(clipBatchExpectedMicros(members(2), parts({ quality: "pro", seconds: 10 }))).toBe(2 * 1_120_000);
  });

  test("one member equals the single clip's formula", () => {
    const single = { model: "kling" as const, quality: "std" as const, seconds: 5 as const, mode: "auto" as const, fallback: "auto" as const, prices: PRICES };
    expect(clipBatchWorstMicros(members(1), parts())).toBe(clipWorstMicros(single));
    expect(clipBatchExpectedMicros(members(1), parts())).toBe(clipExpectedMicros(single));
  });

  test("refuses no member, twenty-one members, and a price that is not whole micro-dollars", () => {
    expect(() => clipBatchWorstMicros([], parts())).toThrow(RangeError);
    expect(() => clipBatchWorstMicros(members(MAX_BATCH_CLIPS + 1), parts())).toThrow(RangeError);
    expect(() => clipBatchWorstMicros(members(MAX_BATCH_CLIPS), parts())).not.toThrow();
    expect(() => clipBatchWorstMicros(members(2), parts({ prices: { ...PRICES, std: { perSecondMicros: 84_000.5, perInputImageMicros: 0 } } }))).toThrow(RangeError);
    expect(() => clipBatchExpectedMicros([], parts())).toThrow(RangeError);
  });

  // A brute force on a fixed seed: 400 random batches, the sum taken the long way, member by member, through the single-clip functions.
  test("equals the sum of clipWorstMicros and of clipExpectedMicros over random batches (fixed seed)", () => {
    let state = 0x5b2b1;
    const next = (): number => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
    const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)] as T;
    for (let round = 0; round < 400; round++) {
      const prices: ClipPrices = {
        std: { perSecondMicros: int(0, 400_000), perInputImageMicros: int(0, 50_000) },
        pro: { perSecondMicros: int(0, 400_000), perInputImageMicros: int(0, 50_000) },
        grok: { perSecondMicros: int(0, 400_000), perInputImageMicros: int(0, 50_000) },
      };
      const batch = parts({ prices, quality: pick(["std", "pro"] as const), seconds: pick([5, 10] as const), mode: pick(["auto", "offer"] as const), fallback: pick(["auto", "none"] as const), boldClips: pick(["kling-only", "with-fallback", "off"] as const satisfies readonly BoldClipsMode[]) });
      const ms = Array.from({ length: int(1, MAX_BATCH_CLIPS) }, () => ({ bold: next() < 0.3 }));
      let worst = 0;
      let expected = 0;
      for (const m of ms) {
        const single = { model: "kling" as const, ...batch, bold: m.bold };
        worst += clipWorstMicros(single);
        expected += clipExpectedMicros(single);
      }
      expect(clipBatchWorstMicros(ms, batch)).toBe(worst);
      expect(clipBatchExpectedMicros(ms, batch)).toBe(expected);
      expect(Number.isSafeInteger(worst)).toBe(true);
    }
  });
});

// ---------- the job: queued, waitReason, the batch fields ----------

const ref = { kind: "clip", jobId: JOB, avatarId: AVATAR, clipId: CLIP };
const progress = (over: Record<string, unknown> = {}) => ({ ...ref, done: 1, total: 4, phase: "rendering", ...over });
const state = (over: Record<string, unknown> = {}) => ({ ...ref, status: "running", done: 1, total: 4, phase: "rendering", ...over });
const batchFields: Record<string, unknown> = { batchId: BATCH, batchIndex: 3, batchSize: 10 };
const facts = { photoId: photoId(0), request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" }, motion: { source: "scene", label: "Как в сцене" }, acceptedWorstMicros: 850_000 };
// A queued member as the engine announces it: the whole trio, nothing reserved, nothing sent, at zero.
const queuedProgress = (over: Record<string, unknown> = {}): Record<string, unknown> => progress({ phase: "queued", done: 0, ...batchFields, ...over });
const queuedState = (over: Record<string, unknown> = {}): Record<string, unknown> => state({ status: "queued", phase: "queued", done: 0, ...batchFields, ...over });

describe("the queued phase", () => {
  test("is the first phase of a clip job, before the 5b.1 ladder", () => {
    expect([...CLIP_PHASES]).toEqual(["queued", "preparing", "submitting", "rendering", "proving", "downloading", "checking", "saving", "late", "recovering", "exporting"]);
  });

  test("passes the job refine, in a progress and in a state, with or without the create facts", () => {
    expect(JobProgress.safeParse(queuedProgress()).success).toBe(true);
    expect(JobProgress.safeParse(queuedProgress(facts)).success).toBe(true);
    expect(JobState.safeParse(queuedState()).success).toBe(true);
    expect(JobState.safeParse(queuedState(facts)).success).toBe(true);
  });

  test("a queued job is a batch member: it carries the whole trio, in a progress and in a state", () => {
    for (const key of Object.keys(batchFields)) {
      const { [key]: _gone, ...rest } = queuedProgress();
      expect(JobProgress.safeParse(rest).success).toBe(false);
      const { [key]: _g2, ...restState } = queuedState();
      expect(JobState.safeParse(restState).success).toBe(false);
    }
    const { batchId: _b, batchIndex: _i, batchSize: _s, ...none } = queuedProgress();
    expect(JobProgress.safeParse(none).success).toBe(false);
  });

  test("a queued job has made no progress: done is 0", () => {
    expect(JobProgress.safeParse(queuedProgress({ done: 1 })).success).toBe(false);
    expect(JobState.safeParse(queuedState({ done: 1 })).success).toBe(false);
  });

  test("a queued job has no proof window, no model, no submit time and no open reserve", () => {
    for (const extra of [{ proveUntil: "2026-10-14T10:02:00.000Z" }, { model: "kling" }, { submittedAt: "2026-10-14T10:00:00.000Z" }, { openReserveMicros: 850_000 }]) {
      expect(JobProgress.safeParse(queuedProgress(extra)).success).toBe(false);
      expect(JobState.safeParse(queuedState(extra)).success).toBe(false);
    }
  });

  test("a member that was cancelled while queued keeps its queued phase at zero", () => {
    expect(JobState.safeParse(queuedState({ status: "cancelled", detail: "cancelled" })).success).toBe(true);
  });
});

describe("waitReason", () => {
  const WAIT = ["turn", "alone", "rate-limit", "proof"] as const;

  test("is one of turn, alone, rate-limit and proof", () => {
    for (const waitReason of WAIT) expect(JobProgress.safeParse(queuedProgress({ waitReason })).success).toBe(true);
    expect(JobProgress.safeParse(queuedProgress({ waitReason: "sleeping" })).success).toBe(false);
  });

  test("appears only on a queued or a proving job", () => {
    expect(JobProgress.safeParse(progress({ phase: "proving", waitReason: "proof" })).success).toBe(true);
    expect(JobState.safeParse(state({ status: "running", phase: "proving", waitReason: "proof" })).success).toBe(true);
    for (const phase of CLIP_PHASES) {
      if (phase === "queued" || phase === "proving") continue;
      expect(JobProgress.safeParse(progress({ phase, waitReason: "alone" })).success).toBe(false);
      expect(JobState.safeParse(state({ status: "running", phase, waitReason: "alone" })).success).toBe(false);
    }
  });

  test("a clip job without it parses as before and gains no key", () => {
    expect("waitReason" in JobProgress.parse(progress())).toBe(false);
    expect("waitReason" in JobState.parse(state())).toBe(false);
  });
});

describe("batchId, batchIndex and batchSize", () => {
  test("come all or none, in a progress and in a state", () => {
    expect(JobProgress.safeParse(progress(batchFields)).success).toBe(true);
    expect(JobState.safeParse(state(batchFields)).success).toBe(true);
    for (const key of Object.keys(batchFields)) {
      const { [key]: _gone, ...two } = batchFields;
      expect(JobProgress.safeParse(progress(two)).success).toBe(false);
      expect(JobState.safeParse(state(two)).success).toBe(false);
      const only = { [key]: batchFields[key] };
      expect(JobProgress.safeParse(progress(only)).success).toBe(false);
      expect(JobState.safeParse(state(only)).success).toBe(false);
    }
  });

  test("the position is one-based and within the size, the size is one to twenty", () => {
    expect(JobProgress.safeParse(progress({ ...batchFields, batchIndex: 0 })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ ...batchFields, batchIndex: 11 })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ ...batchFields, batchIndex: 10 })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ ...batchFields, batchIndex: 20, batchSize: 20 })).success).toBe(true);
    expect(JobProgress.safeParse(progress({ ...batchFields, batchIndex: 1, batchSize: 21 })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ ...batchFields, batchSize: 0, batchIndex: 0 })).success).toBe(false);
    expect(JobProgress.safeParse(progress({ ...batchFields, batchIndex: 1.5 })).success).toBe(false);
    expect(JobState.safeParse(state({ ...batchFields, batchIndex: 11 })).success).toBe(false);
  });

  test("a single clip's job carries none of them and parses as before", () => {
    expect(JobProgress.safeParse(progress({ phase: "rendering" })).success).toBe(true);
    expect("batchId" in JobProgress.parse(progress({ phase: "rendering" }))).toBe(false);
  });

  test("a batch id is an id, not a path", () => {
    expect(JobProgress.safeParse(progress({ ...batchFields, batchId: "../x" })).success).toBe(false);
  });

  test("the event on the wire carries them", () => {
    const event = { v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "job.progress", payload: queuedProgress({ waitReason: "alone" }) };
    expect(EventMessage.safeParse(event).success).toBe(true);
  });
});

// ---------- the cancelled members ----------

describe("the cancelled-member details", () => {
  test("are the six of §5.2.1 and `photo-unreadable` (a photo still in the gallery whose file is missing or damaged)", () => {
    expect([...CLIP_CANCEL_DETAILS].sort()).toEqual(["cancelled", "ledger-stopped", "money-uncertain", "photo-gone", "photo-unreadable", "price-changed", "price-unavailable"]);
    expect(ClipCancelDetail.safeParse("price-changed").success).toBe(true);
    expect(ClipCancelDetail.safeParse("batch-member").success).toBe(false);
  });

  test("a cancelled clip job may say why; it still carries its identity", () => {
    expect(JobCancelled.parse({ ...ref, detail: "price-changed" })).toMatchObject({ detail: "price-changed" });
    expect(JobCancelled.safeParse(ref).success).toBe(true);
    expect(JobCancelled.safeParse({ ...ref, detail: "because" }).success).toBe(false);
    expect(JobCancelled.safeParse({ ...ref, phase: "queued" }).success).toBe(false);
  });

  test("a cancelled clip state says why, and only a cancelled one does", () => {
    expect(JobState.safeParse(state({ status: "cancelled", detail: "ledger-stopped" })).success).toBe(true);
    expect(JobState.safeParse(state({ status: "cancelled", detail: "photo-unreadable" })).success).toBe(true);
    expect(JobState.safeParse(state({ status: "running", detail: "ledger-stopped" })).success).toBe(false);
    expect(JobState.safeParse(state({ status: "failed", error: { code: "INTERNAL" }, detail: "cancelled" })).success).toBe(false);
  });

  test("another kind of job has no such detail", () => {
    expect(JobCancelled.safeParse({ kind: "run", jobId: JOB, runId: "run-00000001", avatarId: AVATAR, detail: "cancelled" }).success).toBe(false);
  });
});

// ---------- the reasons and the texts ----------

describe("clipReason batch-running and clip-busy", () => {
  test("join the closed set, as IN_FLIGHT reasons", () => {
    for (const reason of ["batch-running", "clip-busy"]) {
      expect(CLIP_REASONS as readonly string[]).toContain(reason);
      expect(CLIP_IN_FLIGHT_REASONS as readonly string[]).toContain(reason);
    }
  });

  test("are accepted with IN_FLIGHT only", () => {
    for (const clipReason of ["batch-running", "clip-busy"]) {
      expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason }).success).toBe(true);
      for (const code of ["VALIDATION", "NOT_FOUND", "INTERNAL", "BUDGET_EXCEEDED"]) expect(EngineError.safeParse({ code, clipReason }).success).toBe(false);
    }
  });

  test("`batch-member` is gone: there is no `batch-member` reason (L3)", () => {
    expect(CLIP_REASONS as readonly string[]).not.toContain("batch-member");
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "batch-member" }).success).toBe(false);
  });

  test("an item's own reason travels with its path, as VALIDATION", () => {
    const refused = { code: "VALIDATION", clipReason: "bold-off", path: ["items", 3], detail: "item 3 cannot be brought to life" };
    expect(EngineError.parse(refused)).toMatchObject({ clipReason: "bold-off", path: ["items", 3] });
    expect(EngineError.safeParse({ ...refused, clipReason: "unknown-motion" }).success).toBe(true);
  });

  test("the path is `[\"items\", i]` with a whole non-negative index and nothing else", () => {
    const refused = (path: unknown) => EngineError.safeParse({ code: "VALIDATION", clipReason: "bold-off", path }).success;
    expect(refused(["items", 0])).toBe(true);
    expect(refused(["items", 19])).toBe(true);
    expect(refused(["items", -1])).toBe(false);
    expect(refused(["items", 1.5])).toBe(false);
    expect(refused(["photoIds", 1])).toBe(false);
    expect(refused(["items"])).toBe(false);
    expect(refused(["items", 1, "motionId"])).toBe(false);
  });

  test("a path needs a VALIDATION with a clipReason: not a bare VALIDATION, not another code", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", path: ["items", 0] }).success).toBe(false);
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "batch-running", path: ["items", 0] }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", clipReason: "bold-off" }).success).toBe(true);
  });

  // clips.createBatch: NOT_FOUND refers to the AVATAR only (it carries no path). A member's photo that is missing or belongs to another avatar is the member's own VALIDATION `not-a-gallery-photo`
  // at `path: ["items", i]`, so the sheet can draw it on that row.
  test("a member's missing or foreign photo is VALIDATION not-a-gallery-photo at its item path", () => {
    const error = EngineError.parse({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 4], detail: "item 4 is not a photo of this avatar's gallery" });
    expect(error).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 4] });
    expect(CLIP_REASONS_RU["not-a-gallery-photo"]).toContain("кадр из галереи");
  });

  test("NOT_FOUND (the avatar) carries no item path, and a path never rides on it", () => {
    expect(EngineError.safeParse({ code: "NOT_FOUND", detail: "no such avatar" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "NOT_FOUND", clipReason: "not-a-gallery-photo", path: ["items", 4] }).success).toBe(false);
    expect(EngineError.safeParse({ code: "NOT_FOUND", path: ["items", 4] }).success).toBe(false);
  });

  test("there is one clipReason per error: a second reason beside it is refused", () => {
    expect(EngineError.safeParse({ code: "IN_FLIGHT", clipReason: "batch-running", portraitReason: "not-imported" }).success).toBe(false);
  });

  test("the texts are §5.2.1's, word for word", () => {
    expect(CLIP_REASONS_RU["batch-running"]).toBe("Сейчас снимаются клипы пакета — дождитесь окончания или отмените оставшиеся.");
    expect(CLIP_REASONS_RU["clip-busy"]).toBe("Пока снимается клип, предложения и перевод недоступны — дождитесь окончания.");
  });
});

describe("the cancelled-member texts (mockups 60c-60f)", () => {
  test("60c: the owner cancelled the rest", () => {
    expect(clipCancelDetailRu("cancelled", 3)).toBe("Отменено: 3 клипа не снимались — бесплатно");
  });

  test("60d: the ledger stopped the batch", () => {
    expect(clipCancelDetailRu("ledger-stopped", 4)).toBe("Пакет остановлен: нужна сверка расходов. Оставшиеся 4 клипа не снимались — бесплатно.");
  });

  test("60e: the price rose", () => {
    expect(clipCancelDetailRu("price-changed", 3)).toBe("Цена у OpenRouter выросла — оставшиеся 3 клипа не снимались, бесплатно. Запустите их заново.");
  });

  test("60f: a clip's money is unknown", () => {
    expect(clipCancelDetailRu("money-uncertain", 5)).toBe("Клип задержался или не ясно, оплачен ли он — оставшиеся 5 не снимались, чтобы не тратить вслепую. Бесплатно.");
  });

  test("the price cannot be read (r2.1 N7)", () => {
    expect(clipCancelDetailRu("price-unavailable", 6)).toBe("Цены видео у OpenRouter сейчас не читаются — оставшиеся 6 клипов не снимались, бесплатно.");
  });

  test("the photo was removed from the gallery: one member, free", () => {
    expect(clipCancelDetailRu("photo-gone", 1)).toBe("Это фото удалено из галереи — клип не снимался, бесплатно.");
  });

  test("the photo is in the gallery but its file is missing or damaged: one member, free, and it does not say «удалено»", () => {
    expect(clipCancelDetailRu("photo-unreadable", 1)).toBe("Файл этого фото не читается — клип не снимался, бесплатно.");
    expect(clipCancelDetailRu("photo-unreadable", 1)).not.toContain("удалено");
  });

  test("the two photo texts speak of one member whatever the count passed", () => {
    for (const detail of ["photo-gone", "photo-unreadable"] as const) expect(clipCancelDetailRu(detail, 7)).toBe(clipCancelDetailRu(detail, 1));
  });

  test("a restart or a quit drops the queue: «Оставшиеся N клипов не снимались — бесплатно.» (mockup 60c, restart)", () => {
    expect(clipBatchDroppedRu(5)).toBe("Оставшиеся 5 клипов не снимались — бесплатно.");
    expect(clipBatchDroppedRu(2)).toBe("Оставшиеся 2 клипа не снимались — бесплатно.");
    expect(clipBatchDroppedRu(1)).toBe("Оставшийся 1 клип не снимался — бесплатно.");
    expect(clipBatchDroppedRu(11)).toBe("Оставшиеся 11 клипов не снимались — бесплатно.");
    expect(clipBatchDroppedRu(21)).toBe("Оставшийся 21 клип не снимался — бесплатно.");
    expect(clipBatchDroppedRu(22)).toBe("Оставшиеся 22 клипа не снимались — бесплатно.");
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => clipBatchDroppedRu(bad)).toThrow(RangeError);
  });

  test("the noun agrees with the number: 1, 2, 5, 11, 21, 22 and 25", () => {
    const noun = (n: number) => clipCancelDetailRu("cancelled", n);
    expect(noun(1)).toBe("Отменено: 1 клип не снимался — бесплатно");
    expect(noun(2)).toBe("Отменено: 2 клипа не снимались — бесплатно");
    expect(noun(5)).toBe("Отменено: 5 клипов не снимались — бесплатно");
    expect(noun(11)).toBe("Отменено: 11 клипов не снимались — бесплатно");
    expect(noun(21)).toBe("Отменено: 21 клип не снимался — бесплатно");
    expect(noun(22)).toBe("Отменено: 22 клипа не снимались — бесплатно");
    expect(noun(25)).toBe("Отменено: 25 клипов не снимались — бесплатно");
  });

  test("one member left agrees too, in every detail that counts them", () => {
    expect(clipCancelDetailRu("ledger-stopped", 1)).toBe("Пакет остановлен: нужна сверка расходов. Оставшийся 1 клип не снимался — бесплатно.");
    expect(clipCancelDetailRu("price-changed", 1)).toBe("Цена у OpenRouter выросла — оставшийся 1 клип не снимался, бесплатно. Запустите его заново.");
    expect(clipCancelDetailRu("money-uncertain", 1)).toBe("Клип задержался или не ясно, оплачен ли он — оставшийся 1 не снимался, чтобы не тратить вслепую. Бесплатно.");
    expect(clipCancelDetailRu("price-unavailable", 1)).toBe("Цены видео у OpenRouter сейчас не читаются — оставшийся 1 клип не снимался, бесплатно.");
  });

  test("every detail has a text, and each one tells the owner that nothing was charged", () => {
    for (const detail of CLIP_CANCEL_DETAILS) expect(clipCancelDetailRu(detail, 2).toLowerCase()).toContain("бесплатно");
  });

  test("a count that is not a positive whole number is refused", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(() => clipCancelDetailRu("cancelled", bad)).toThrow(RangeError);
  });
});

// ---------- the summary ----------

describe("ClipSummary.batchId (the header outlives KEEP_FINISHED, L9)", () => {
  const ready = {
    clipId: CLIP,
    avatarId: AVATAR,
    photoId: photoId(0),
    createdAt: "2026-10-14T10:00:00.000Z",
    seen: false,
    motion: { source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    model: "kling-std",
    fallback: false,
    recovered: false,
    cost: { micros: 420_000, kind: "billed" },
    exports: [],
    status: "ready",
    width: 720,
    height: 1280,
    durationMs: 5_000,
    face: { verdict: "match", p75: 0.71, frames: 11 },
  };
  const { width: _w, height: _h, durationMs: _d, face: _f, ...common } = ready;
  const failed = { ...common, status: "failed", cost: { micros: 0, kind: "free" }, failure: { reason: "refused-free" } };

  test("a clip without it parses as before and gains no key", () => {
    expect("batchId" in ClipSummary.parse(ready)).toBe(false);
  });

  test("a batch id is an id, not a path", () => {
    expect(ClipSummary.safeParse({ ...ready, batchId: "../x", batchIndex: 1, batchSize: 2 }).success).toBe(false);
  });

  const trio = { batchId: BATCH, batchIndex: 3, batchSize: 10 };

  test("the trio batchId, batchIndex and batchSize rides on a ready and a failed summary", () => {
    expect(ClipSummary.parse({ ...ready, ...trio })).toMatchObject(trio);
    expect(ClipSummary.parse({ ...failed, ...trio })).toMatchObject(trio);
  });

  test("any partial trio is refused, on both statuses", () => {
    for (const base of [ready, failed]) {
      for (const key of Object.keys(trio)) {
        const { [key]: _gone, ...two } = trio as Record<string, unknown>;
        expect(ClipSummary.safeParse({ ...base, ...two }).success).toBe(false);
        expect(ClipSummary.safeParse({ ...base, [key]: (trio as Record<string, unknown>)[key] }).success).toBe(false);
      }
    }
  });

  test("the place is one-based and within the size", () => {
    expect(ClipSummary.safeParse({ ...ready, ...trio, batchIndex: 10 }).success).toBe(true);
    expect(ClipSummary.safeParse({ ...ready, ...trio, batchIndex: 11 }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...failed, ...trio, batchIndex: 0 }).success).toBe(false);
    expect(ClipSummary.safeParse({ ...failed, ...trio, batchSize: 21, batchIndex: 1 }).success).toBe(false);
  });

  test("a clip.get and a clips.list answer carries the trio", () => {
    expect(answers("clips.get", { clip: { ...ready, ...trio } })).toBe(true);
    expect(answers("clips.list", { clips: [{ ...failed, ...trio }] })).toBe(true);
  });
});
