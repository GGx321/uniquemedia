import { describe, expect, test } from "bun:test";
import { clipReserveMicros, type ClipQuality, type ClipSeconds } from "../../shared/engine/clips";
import type { VideoSubmitResult } from "../openrouter/types";
import { createRig, gen404, genFound, genFromAfter, genUnreadable, GROK, KLING, PROVIDER_FAILED, PRICES, REFUSED_BY_RISK_CONTROL, SECOND, type JobScript } from "./testing/attemptRig";

// 5b.1, S5.V3b (plan s5b1 §8 V3b): properties over random outcome sequences, both modes, fallback `auto` and `none`, «Смелая» and a Grok clip. A seeded generator, so a failure replays. What must hold for
// every sequence: the clip's settled and open money never exceeds its accepted worst; a POST leaves at most once per attempt id and at most two per clip; Grok runs only behind a Kling that settled 0, and only
// where the rules let it; nothing settles twice.

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
  /** This model's charge shows in /credits after its POST and stays. */
  netIncrease: boolean;
  name: string;
}

function draw(rng: () => number, reserve: number): Drawn {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;
  const cost = (): number => 1 + Math.floor(rng() * reserve);
  const kind = pick(["completed-usage", "completed-gen", "moderation-4xx", "other-4xx", "uncertain", "refused-clean", "refused-increase", "refused-paid", "provider-error", "late", "unreadable"] as const);
  switch (kind) {
    case "completed-usage":
      return { name: kind, netIncrease: false, script: { terminal: { status: "completed", usageCostMicros: cost() } } };
    case "completed-gen":
      return { name: kind, netIncrease: false, script: { terminal: { status: "completed", usageCostMicros: null }, generation: genFromAfter(15 * SECOND, cost()) } };
    case "moderation-4xx":
      return { name: kind, netIncrease: false, script: { submit: refusedSubmit(400, "HTTP_ERROR", true) } };
    case "other-4xx":
      return { name: kind, netIncrease: false, script: { submit: pick([refusedSubmit(401, "AUTH_INVALID", false), refusedSubmit(402, "INSUFFICIENT_CREDITS", false), refusedSubmit(429, "RATE_LIMITED", false)]) } };
    case "uncertain":
      return { name: kind, netIncrease: false, script: { submit: { kind: "uncertain", cause: pick(["timeout", "network", "server-error"] as const), httpStatus: null, detail: "x" } } };
    case "refused-clean":
      return { name: kind, netIncrease: false, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: gen404 } };
    case "refused-increase":
      return { name: kind, netIncrease: true, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: gen404 } };
    case "refused-paid":
      return { name: kind, netIncrease: false, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: genFromAfter(pick([15, 100]) * SECOND, cost()) } };
    case "provider-error":
      return { name: kind, netIncrease: false, script: { terminal: PROVIDER_FAILED, generation: pick([gen404, () => genFound(cost())] as const) } };
    case "late":
      return { name: kind, netIncrease: false, script: { terminalAfterMs: "never" } };
    case "unreadable":
      return { name: kind, netIncrease: false, script: { terminal: REFUSED_BY_RISK_CONTROL, generation: genUnreadable } };
  }
}

describe("random outcome sequences", () => {
  for (const mode of ["auto", "offer"] as const) {
    test(`[${mode}] the clip never holds more than its accepted worst, never POSTs an attempt twice, and runs Grok only behind a free Kling`, async () => {
      const problems: string[] = [];
      const rng = mulberry32(mode === "auto" ? 20261013 : 13102026);
      for (let i = 0; i < 120; i++) {
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
        const check = (ok: boolean, what: string): void => void (ok || problems.push(`${label}: ${what}`));
        const label = `#${i} ${mode} ${model}/${quality}/${seconds}s fallback=${fallback} bold=${bold} first=${first.name} second=${second.name}`;

        const rig = await createRig({
          mode,
          boldClips: "kling-only",
          kling: grokClip ? {} : first.script,
          grok: grokClip ? first.script : second.script,
          usage: (t, posts) =>
            5_000_000 + (posts.kling !== undefined && first.netIncrease && !grokClip && t >= posts.kling + 38 * SECOND ? 300_000 : 0) + (posts.grok !== undefined && (grokClip ? first : second).netIncrease && t >= posts.grok + 38 * SECOND ? 300_000 : 0),
        });
        try {
          const request = { model, quality, seconds, fallback } as const;
          const input = rig.input({ request: grokClip ? { ...request, fallback: "none" } : request, bold });
          const result = await rig.run({ request: input.request, bold, acceptedWorstMicros: input.acceptedWorstMicros });

          check(result.kind !== "not-reserved", "the cap refused a reserve of the clip's own");
          check(result.kind !== "interrupted", "nobody stopped this clip, yet it was interrupted");
          check(rig.posts().length >= 1, "the clip never sent its first request");
          check(rig.ledger.lines.some((l) => l.type === "reserve"), "the clip sent a request without a reserve");

          const settledAndOpen = rig.settles().reduce((sum, s) => sum + s.costMicros, 0) + rig.ledger.openReserves().reduce((sum, r) => sum + r.worstMicros, 0);
          check(settledAndOpen <= input.acceptedWorstMicros, `over the accepted worst: ${settledAndOpen} > ${input.acceptedWorstMicros}`);

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
    });
  }
});
