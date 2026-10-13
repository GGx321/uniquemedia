import { describe, expect, test } from "bun:test";
import { clipReserveMicros, type ClipQuality, type ClipSeconds } from "../../shared/engine/clips";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import type { VideoSubmitResult } from "../openrouter/types";
import { createRig, gen404, genFound, genFromAfter, genUnreadable, GROK, KLING, PRICES, PROVIDER_FAILED, REFUSED_BY_RISK_CONTROL, SECOND, T0, type JobScript } from "./testing/attemptRig";
useNativeGlobals();

// 5b.1, S5.V3b (plan s5b1 §8 V3b): properties over random outcome sequences, both modes, fallback `auto` and `none`, «Смелая» and a Grok clip. A seeded generator, so a failure replays. What must hold for
// every sequence: what the PROVIDER bills for the clip, hidden bills included, never exceeds the clip's accepted worst (the ledger's own sums are not enough: a charge nobody saw is the one that matters);
// a POST leaves at most once per attempt id; Grok runs only behind a Kling that settled 0 and only where the rules let it; nothing settles twice.
//
// The world is hostile on purpose: /credits is unreadable, a photo run touches the ledger inside the proof window, the journal fails on `submitted`, the engine is stopped, and a refused or failed job
// carries a HIDDEN bill (/generation is a 404, and /credits shows it only when it can be read). With the net-usage check treated as «skipped» in mode auto, this property fails: Kling is billed and Grok
// runs behind it.

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const refusedSubmit = (httpStatus: number, errorKind: "AUTH_INVALID" | "INSUFFICIENT_CREDITS" | "RATE_LIMITED" | "HTTP_ERROR", moderation: boolean): VideoSubmitResult => ({
  kind: "refused",
  httpStatus,
  errorKind,
  moderation,
  detail: "refused",
});

interface Drawn {
  script: JobScript;
  /** What the provider bills for this attempt when its POST was accepted or may have been (a job exists), in micro-dollars. */
  charge: number;
  name: string;
}

function draw(rng: () => number, reserve: number): Drawn {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  const cost = (): number => 1 + Math.floor(rng() * reserve);
  const bill = (): number => Math.ceil(reserve / 2) + Math.floor(rng() * (reserve / 2));
  const kind = pick([
    "completed-usage",
    "completed-gen",
    "moderation-4xx",
    "other-4xx",
    "uncertain",
    "uncertain-billed",
    "refused-clean",
    "refused-clean",
    "refused-hidden",
    "refused-hidden",
    "refused-hidden",
    "provider-hidden",
    "refused-paid",
    "provider-error",
    "provider-hidden",
    "late",
    "unreadable",
  ] as const);
  switch (kind) {
    case "completed-usage": {
      const c = cost();
      return { name: kind, charge: c, script: { terminal: { status: "completed", usageCostMicros: c } } };
    }
    case "completed-gen": {
      const c = cost();
      return { name: kind, charge: c, script: { terminal: { status: "completed", usageCostMicros: null }, generation: genFromAfter(15 * SECOND, c) } };
    }
    case "moderation-4xx":
      return { name: kind, charge: 0, script: { submit: refusedSubmit(400, "HTTP_ERROR", true) } };
    case "other-4xx":
      return { name: kind, charge: 0, script: { submit: pick([refusedSubmit(401, "AUTH_INVALID", false), refusedSubmit(402, "INSUFFICIENT_CREDITS", false), refusedSubmit(429, "RATE_LIMITED", false)]) } };
    case "uncertain":
      return { name: kind, charge: 0, script: { submit: { kind: "uncertain", cause: pick(["timeout", "network", "server-error"] as const), httpStatus: null, detail: "x" } } };
    case "uncertain-billed":
      // The POST reached the provider and the job ran, but the answer never came back.
      return { name: kind, charge: bill(), script: { submit: { kind: "uncertain", cause: "timeout", httpStatus: null, detail: "x" } } };
    case "refused-clean":
      return { name: kind, charge: 0, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: gen404 } };
    case "refused-hidden":
      // Refused, billed, and /generation says nothing: only /credits can show it.
      return { name: kind, charge: bill(), script: { terminal: REFUSED_BY_RISK_CONTROL, generation: gen404 } };
    case "refused-paid": {
      const c = cost();
      return { name: kind, charge: c, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: genFromAfter(pick([15, 100]) * SECOND, c) } };
    }
    case "provider-error": {
      const c = cost();
      return pick([true, false])
        ? { name: kind, charge: 0, script: { terminal: PROVIDER_FAILED, generation: gen404 } }
        : { name: kind, charge: c, script: { terminal: PROVIDER_FAILED, generation: () => genFound(c) } };
    }
    case "provider-hidden":
      return { name: kind, charge: bill(), script: { terminal: PROVIDER_FAILED, generation: gen404 } };
    case "late":
      return { name: kind, charge: cost(), script: { terminalAfterMs: "never" } };
    case "unreadable":
      return { name: kind, charge: 0, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: genUnreadable } };
  }
}

describe("random outcome sequences", () => {
  for (const mode of ["auto", "offer"] as const) {
    test(`(${mode}) what the provider bills never exceeds the accepted worst, no attempt POSTs twice, and Grok runs only behind a free Kling`, async () => {
      const problems: string[] = [];
      let cancelled = 0;
      const rng = mulberry32(mode === "auto" ? 20261013 : 13102026);
      for (let i = 0; i < 400; i++) {
        const quality: ClipQuality = rng() < 0.5 ? "std" : "pro";
        const seconds: ClipSeconds = rng() < 0.5 ? 5 : 10;
        const fallback = rng() < 0.7 ? "auto" : "none";
        const bold = rng() < 0.25;
        const grokClip = mode === "offer" && rng() < 0.15;
        const model = grokClip ? "grok" : "kling";
        const firstReserve = clipReserveMicros(grokClip ? PRICES.grok : PRICES[quality], seconds);
        const grokReserve = clipReserveMicros(PRICES.grok, seconds);
        const first = draw(rng, firstReserve);
        const second = draw(rng, grokReserve);
        // A stop BEFORE the POST: during the baseline's retry pauses (the read keeps failing), or by the read itself (it answers, but the clip was stopped while it ran).
        const earlyStop = rng() < 0.15 ? (rng() < 0.5 ? "pause" : "read") : null;
        const creditsBroken = rng() < 0.3 || earlyStop === "pause";
        const foreignRunAt = rng() < 0.3 ? T0 + Math.floor(rng() * 400) * SECOND : null;
        const journalFails = rng() < 0.1;
        const stopAt = rng() < 0.1 ? T0 + Math.floor(rng() * 600) * SECOND : null;
        const label = `#${i} ${mode} ${model}/${quality}/${seconds}s fallback=${fallback} bold=${bold} first=${first.name} second=${second.name} creditsBroken=${creditsBroken} foreign=${foreignRunAt !== null} journalFails=${journalFails} stop=${stopAt !== null} earlyStop=${earlyStop}`;
        const check = (ok: boolean, what: string): void => void (ok || problems.push(`${label}: ${what}`));

        const drawnOf = { kling: grokClip ? undefined : first, grok: grokClip ? first : second } as const;
        let foreignCost = 0;
        const rig = await createRig({
          mode,
          boldClips: "kling-only",
          kling: grokClip ? {} : first.script,
          grok: grokClip ? first.script : second.script,
          // /credits shows every bill ≈ 38 s after its POST, and the photo run's cost once it settled; when it cannot be read it shows nothing.
          usage: (t, posts) => {
            if (creditsBroken) return "throw";
            let total = 5_000_000;
            for (const key of ["kling", "grok"] as const) {
              const post = posts[key];
              if (post !== undefined && t >= post + 38 * SECOND) total += drawnOf[key]?.charge ?? 0;
            }
            return total + (foreignRunAt !== null && t >= foreignRunAt ? foreignCost : 0);
          },
        });
        try {
          if (earlyStop === "pause") rig.at(T0 + 2 * SECOND, () => rig.abort());
          if (earlyStop === "read") {
            const answering = rig.deps.client.fetchCredits;
            rig.deps.client.fetchCredits = async () => {
              rig.abort();
              return answering();
            };
          }
          if (journalFails) rig.failJournalOn.add("submitted");
          if (foreignRunAt !== null) {
            foreignCost = 90_000;
            rig.at(foreignRunAt, () => rig.photoRun("run-0001", foreignCost));
          }
          if (stopAt !== null) rig.at(stopAt, () => rig.abort());
          const request = { model, quality, seconds, fallback } as const;
          const input = rig.input({ request: grokClip ? { ...request, fallback: "none" } : request, bold });
          const result = await rig.run({ request: input.request, bold, acceptedWorstMicros: input.acceptedWorstMicros });

          check(result.kind !== "not-reserved", "the cap refused a reserve of the clip's own");
          check(stopAt !== null || earlyStop !== null || (result.kind !== "interrupted" && result.kind !== "cancelled"), "nobody stopped this clip, yet it was interrupted");
          check(stopAt !== null || earlyStop !== null || rig.posts().length >= 1, "the clip never sent its first request");

          // What the provider billed for the clip: every attempt whose POST left, at its drawn charge. The hidden bills are in it.
          // Every POST has a reserve of its own before it, and a clip that was cancelled left nothing: no POST, every reserve released, nothing open.
          let reserved = 0;
          let posted = 0;
          for (const event of rig.trace) {
            if (event.startsWith("ledger:reserve:") && event.endsWith(":ok")) reserved++;
            if (event.startsWith("post:")) {
              check(reserved > posted, "a POST left without a reserve of its own before it");
              posted++;
            }
          }
          if (result.kind === "cancelled") {
            cancelled++;
            check(posted === 0, "a cancelled clip POSTed");
            check(rig.ledger.openReserves().filter((r) => r.attemptId.startsWith("clip-")).length === 0, "a cancelled clip left a reserve open");
            check(rig.trace.filter((e) => e.startsWith("ledger:release:")).length === reserved, "a cancelled clip did not release every reserve");
          }

          const provider = (rig.posts("kling").length > 0 ? (drawnOf.kling?.charge ?? 0) : 0) + (rig.posts("grok").length > 0 ? (drawnOf.grok?.charge ?? 0) : 0);
          check(provider <= input.acceptedWorstMicros, `the provider billed ${provider}, over the accepted worst ${input.acceptedWorstMicros}`);

          const ours = (attemptId: string): boolean => attemptId.startsWith("clip-");
          const settledAndOpen =
            rig.settles().filter((s) => ours(s.attemptId)).reduce((sum, s) => sum + s.costMicros, 0) + rig.ledger.openReserves().filter((r) => ours(r.attemptId)).reduce((sum, r) => sum + r.worstMicros, 0);
          check(settledAndOpen <= input.acceptedWorstMicros, `the ledger holds ${settledAndOpen}, over the accepted worst ${input.acceptedWorstMicros}`);

          check(rig.posts("kling").length <= 1, "Kling POSTed more than once");
          check(rig.posts("grok").length <= 1, "Grok POSTed more than once");

          const settleIds = rig.settles().map((s) => s.attemptId);
          check(new Set(settleIds).size === settleIds.length, "an attempt settled twice");

          const grokReserved = rig.reserves().some((r) => r.attemptId === GROK);
          if (grokReserved) {
            const klingSettle = rig.settles(KLING)[0];
            check(klingSettle?.costMicros === 0 && klingSettle.estimated === false, "Grok ran behind a Kling that was not settled 0 exactly");
            check(rig.trace.indexOf(`ledger:settle:${KLING}:0:exact`) < rig.trace.indexOf(`ledger:reserve:${GROK}:ok`), "Grok was reserved before Kling settled");
            check(mode === "auto", "automatic Grok in mode offer");
            check(fallback === "auto", "Grok behind a clip that forbade it");
            check(!bold, "Grok behind a frame of «Смелая»");
            check(!grokClip, "a second Grok behind a Grok clip");
          }
          if (grokClip) check(rig.posts("kling").length === 0, "Kling ran in a Grok clip");
        } finally {
          await rig.dispose();
        }
      }
      expect(problems).toEqual([]);
      // The branch must stay alive: a generator that never stops a clip before its POST would leave the cancelled invariants checking nothing.
      expect(cancelled).toBeGreaterThanOrEqual(15);
    });
  }
});
