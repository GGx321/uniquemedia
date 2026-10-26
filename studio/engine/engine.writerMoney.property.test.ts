import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { EventMessage } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { createPaidSteps } from "./autopilot/paidSteps";
import type { LaunchFile } from "./autopilot/launchFile";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { writerAttemptWorstMicros, writerCallOf } from "./money/estimate";
import { PriceBook } from "./money/prices";
import { chatBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { RunEventSchema } from "./runs/journal";
import type { QaGate } from "./runs/qa";
import { LLM_ONLY_REF } from "./scenes/testing/llmOnlyFixture";
import { PLACE_PREPOSITIONS } from "./scenes/writer";
import { command, engineSettings, GOOD, jobEnd, ledgerLines, network, ok, portraitPng, startEngine, TRAITS, until, useEngineDir } from "./testing/engineHarness";
import { seedLlmOnlyCategory } from "./testing/llmOnlyCategory";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

setDefaultTimeout(60_000);

// 5a.4 (S5.BA5, plan s5a4 I5.77; the controller's money check before the wave): on every path that asks the scene writer — a compose, a rewrite, «Дописать», a run straight from the
// card and a launch's compose — each writer attempt reserves exactly its mode's worst case (48 750 µ$ in bold mode, 37 500 µ$ in the ordinary one, the figures the estimates price
// through `writerAttemptWorstMicros`), and a chunk's FIRST and SECOND attempt both fit the figure the owner accepted: no path stops on its cap. Every writer below refuses its
// first answer, so every chunk is asked twice. Over the levels «Кокетливая» and «Смелая», a custom category alone and beside «Дом», one chunk and two.

const dir = useEngineDir("studio-engine-writer-money-");
const libraryDir = () => join(dir(), "library");
const ATTEMPT = {
  ordinary: writerAttemptWorstMicros(PriceBook.fallback(), writerCallOf("ordinary")),
  bold: writerAttemptWorstMicros(PriceBook.fallback(), writerCallOf("bold")),
};
const LEVELS = ["flirty", "bold"] as const;
type Level = (typeof LEVELS)[number];
const attemptAt = (level: Level): number => (level === "bold" ? ATTEMPT.bold : ATTEMPT.ordinary);
const SPLITS: readonly (readonly string[])[] = [[LLM_ONLY_REF], ["home", LLM_ONLY_REF]];
const COUNTS = [4, 40];

let seeded = 0;
async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds(`wm${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80, qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  await seedLlmOnlyCategory(libraryDir());
  return avatar.id;
}

function askedIn(call: FetchCall): { slotIndex: number; location?: string; activity?: string; outfit?: string; world?: string }[] {
  const body = call.json();
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const user = messages.find((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1));
}

/** An answer the reader refuses whole (no scene), so the chunk is asked again. */
const refusing = (): Reply => ({ status: 200, body: chatBody(JSON.stringify({ scenes: [] }), { cost: 0.002 }) });
/** The place opened with a preposition the bold reader takes for it (S5.BA4d): «On her balcony», «By her window»; «In» for every other place. */
const opener = (location: string | undefined): string => {
  const first = (location === undefined ? undefined : PLACE_PREPOSITIONS[location]?.[0]) ?? "in";
  return `${first.charAt(0).toUpperCase()}${first.slice(1)} ${location}`;
};
/** An answer every asked slot passes with: its place, «she» and its activity word for word, its outfit as given. */
const keeping = (call: FetchCall): Reply => ({
  status: 200,
  body: chatBody(
    JSON.stringify({
      scenes: askedIn(call).map((s) => ({ slotIndex: s.slotIndex, sentence: `${opener(s.location)}${s.world === undefined ? "" : ` while staying near ${s.world.replace(/^an? /, "the ")}`}, she ${s.activity} in ${s.outfit}, a cup of tea beside her.` })),
    }),
    { cost: 0.006 },
  ),
});
/** Every request refused once, then answered: the second attempt of every chunk. */
const twice = (n: number): ((call: FetchCall) => Reply)[] => Array.from({ length: 2 * n }, (_, i) => (i % 2 === 0 ? refusing : keeping));

const faceGate = (): QaGate => ({ name: "face", paid: false, check: async () => ({ verdict: "pass" }) });

async function boot(steps: ((call: FetchCall) => Reply)[], opts: { launches?: boolean } = {}) {
  await mkdir(join(dir(), "export"), { recursive: true });
  const net = network({ descriptors: steps, image: () => ({ hang: true }) });
  const holder: { engine: Awaited<ReturnType<typeof startEngine>>["engine"] | null } = { engine: null };
  const paid = createPaidSteps({
    port: () => {
      if (holder.engine === null) throw new Error("the engine is not started yet");
      return holder.engine;
    },
  });
  const started = await startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: 100_000_000 }) },
    net,
    deps: { qaGates: [faceGate()], ...(opts.launches === true ? { launchSteps: paid } : {}) },
  });
  holder.engine = started.engine;
  return started;
}

/** The writer attempts the ledger reserved under `prefix` (a set's or a run's id), in order. */
const writerReserves = (prefix: string): number[] =>
  ledgerLines(dir()).flatMap((l) => (l.type === "reserve" && typeof l.attemptId === "string" && l.attemptId.startsWith(`${prefix}:writ`) && typeof l.worstMicros === "number" ? [l.worstMicros] : []));

const endOf = (events: EventMessage, what: string): void => {
  if (events.type !== "job.done") throw new Error(`${what} ended ${events.type}: ${JSON.stringify(events.payload)}`);
};

async function compose(started: Awaited<ReturnType<typeof boot>>, avatarId: string, level: Level, categories: readonly string[], count: number) {
  const asked = { avatarId, count, categories: [...categories], level };
  const estimate = ok(await started.engine.handle(command("scenes.estimateCompose", asked)));
  if (estimate.type !== "scenes.estimateCompose") throw new Error("not an estimate");
  const answer = ok(await started.engine.handle(command("scenes.compose", { ...asked, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
  if (answer.type !== "scenes.compose" || answer.result.jobId === null) throw new Error("the compose started no job");
  return { sceneSetId: answer.result.sceneSetId, jobId: answer.result.jobId, accepted: estimate.result.estimate.worstMicros };
}

describe("every writer attempt reserves its mode's worst case, and both attempts of a chunk fit what the owner accepted", () => {
  for (const level of LEVELS) {
    for (const split of SPLITS) {
      for (const count of COUNTS) {
        const name = `${level}, ${split.join(" + ")}, ${count}`;

        test(`a compose: ${name}`, async () => {
          const avatarId = await seedAvatar();
          const started = await boot(twice(4));
          const { sceneSetId, jobId, accepted } = await compose(started, avatarId, level, split, count);
          endOf(await jobEnd(started.events, jobId), "the compose");
          const reserved = writerReserves(sceneSetId);
          expect(reserved.length).toBeGreaterThan(0);
          expect(reserved.length % 2).toBe(0);
          expect(reserved.every((r) => r === attemptAt(level))).toBe(true);
          expect(reserved.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(accepted);
        });

        test(`a run straight from the card: ${name}`, async () => {
          const avatarId = await seedAvatar();
          const started = await boot(twice(4));
          const asked = { avatarId, count, categories: [...split], level };
          const estimate = ok(await started.engine.handle(command("runs.estimate", asked)));
          if (estimate.type !== "runs.estimate") throw new Error("not an estimate");
          const answer = ok(await started.engine.handle(command("runs.start", { ...asked, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
          if (answer.type !== "runs.start") throw new Error("not a start");
          const library = started.engine.library;
          if (library === null) throw new Error("no library");
          const plan = await library.readRun(answer.result.runId, (await import("./runs/plan")).RunPlanSchema);
          const asksModel = plan.writerChunks.length;
          let journaled = 0;
          const poll = setInterval(() => void library.readJournal(answer.result.runId, RunEventSchema).then((read) => (journaled = read.events.filter((e) => e.type === "writer" && e.partial !== true).length)), 5);
          try {
            await until(() => journaled === asksModel, "every writer chunk in the journal", 20_000);
          } finally {
            clearInterval(poll);
          }
          const reserved = writerReserves(answer.result.runId);
          expect(reserved.length % 2).toBe(0);
          expect(reserved.length).toBeGreaterThan(0);
          expect(reserved.every((r) => r === attemptAt(level))).toBe(true);
          ok(await started.engine.handle(command("runs.cancel", { runId: answer.result.runId })));
          await jobEnd(started.events, answer.result.jobId);
        });
      }

      test(`a rewrite of two scenes: ${level}, ${split.join(" + ")}`, async () => {
        const avatarId = await seedAvatar();
        // The compose's one chunk is answered at once; the rewrite is refused once and answered.
        const started = await boot([keeping, ...twice(1)]);
        const { sceneSetId, jobId } = await compose(started, avatarId, level, split, 4);
        endOf(await jobEnd(started.events, jobId), "the compose");
        const set = await started.engine.library?.sceneSets.get(avatarId, sceneSetId);
        if (set === null || set === undefined) throw new Error("no set");
        const custom = set.scenes.flatMap((s) => (s.origin === "planned" && s.slot.category === LLM_ONLY_REF ? [s.sceneId] : [])).slice(0, 2);
        const target = { kind: "rewrite" as const, sceneIds: custom, redraw: false };
        const estimate = ok(await started.engine.handle(command("scenes.estimateWrite", { sceneSetId, target })));
        if (estimate.type !== "scenes.estimateWrite") throw new Error("not an estimate");
        expect(estimate.result.estimate.worstMicros).toBe(2 * attemptAt(level));
        const before = writerReserves(sceneSetId).length;
        const write = ok(await started.engine.handle(command("scenes.write", { sceneSetId, revision: set.revision, target, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
        if (write.type !== "scenes.write") throw new Error("not a write");
        endOf(await jobEnd(started.events, write.result.jobId), "the rewrite");
        expect(writerReserves(sceneSetId).slice(before)).toEqual([attemptAt(level), attemptAt(level)]);
      });
    }

    test(`«Дописать» after a stopped compose: ${level}`, async () => {
      const avatarId = await seedAvatar();
      const started = await boot([() => ({ hang: true }), ...twice(1)]);
      const { sceneSetId, jobId } = await compose(started, avatarId, level, [LLM_ONLY_REF], 4);
      await until(() => writerReserves(sceneSetId).length === 1, "the compose's first writer request", 15_000);
      ok(await started.engine.handle(command("scenes.cancel", { sceneSetId })));
      await jobEnd(started.events, jobId);
      const set = await started.engine.library?.sceneSets.get(avatarId, sceneSetId);
      if (set === null || set === undefined) throw new Error("no set");
      const estimate = ok(await started.engine.handle(command("scenes.estimateWrite", { sceneSetId, target: { kind: "unwritten" } })));
      if (estimate.type !== "scenes.estimateWrite") throw new Error("not an estimate");
      const before = writerReserves(sceneSetId).length;
      const write = ok(await started.engine.handle(command("scenes.write", { sceneSetId, revision: set.revision, target: { kind: "unwritten" }, acceptedWorstMicros: estimate.result.estimate.worstMicros })));
      if (write.type !== "scenes.write") throw new Error("not a write");
      endOf(await jobEnd(started.events, write.result.jobId), "«Дописать»");
      const reserved = writerReserves(sceneSetId).slice(before);
      expect(reserved.length).toBeGreaterThan(0);
      expect(reserved.every((r) => r === attemptAt(level))).toBe(true);
      expect(reserved.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(estimate.result.estimate.worstMicros);
    });

    test(`a launch's compose: ${level}`, async () => {
      const avatarId = await seedAvatar();
      const started = await boot(twice(4), { launches: true });
      const draft = { avatarIds: [avatarId], videosPerAvatar: 3, mix: { single: 100, collage: 0, slides: 0 }, categories: [LLM_ONLY_REF], library: false, generate: true, sceneReview: true, stickers: false, level };
      const preview = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
      if (preview.type !== "autopilot.estimate") throw new Error("not an estimate");
      const start = ok(await started.engine.handle(command("autopilot.start", { draft: { ...draft, planSeed: preview.result.preview.planSeed }, acceptedWorstMicros: preview.result.preview.estimate.worstMicros })));
      if (start.type !== "autopilot.start") throw new Error("not a start");
      const path = join(libraryDir(), "autopilot", `${start.result.launch.launchId}.json`);
      const fileOf = (): LaunchFile => JSON.parse(readFileSync(path, "utf8")) as LaunchFile;
      await until(() => existsSync(path) && (fileOf().avatars[0]?.phase === "awaiting-review" || fileOf().paidHold !== null), "the review wait or a hold", 30_000);
      const file = fileOf();
      expect(file.paidHold).toBeNull();
      const sceneSetId = file.avatars[0]?.generation?.sceneSetId ?? "";
      const reserved = writerReserves(sceneSetId);
      expect(reserved.length).toBeGreaterThan(0);
      expect(reserved.every((r) => r === attemptAt(level))).toBe(true);
      expect(reserved.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(file.avatars[0]?.allocation.composeMicros ?? 0);
      ok(await started.engine.handle(command("autopilot.stop", { launchId: start.result.launch.launchId })));
    });
  }
});
