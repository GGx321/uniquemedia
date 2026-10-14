import { describe, expect, test } from "bun:test";
import { EventMessage, PROTOCOL_VERSION, type EngineError } from "../../shared/engine";
import { answerLine, eventLine, Normalizer, Transcript, type Answer } from "./testing/transcript";
import type { Recorded } from "./testing/transcript";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V7: how the parity transcript writes a clip. The golden is append-only, so every older line must come out as it did; the clip lines are new. What a line says is what both
// engines are bound to say the same: ids by role, no clock (the submit time, the end of the proof window, the day of a copy's name), no frame counts, no sizes of files.

function normalizer(): Normalizer {
  const norm = new Normalizer();
  norm.register("avatar", "avatar-lia-0007");
  return norm;
}

function event(payload: unknown, type = "job.progress"): EventMessage {
  return EventMessage.parse({ v: PROTOCOL_VERSION, id: "evt-00000001", seq: 1, bootId: "boot-0000-aaaa", kind: "event", type, payload });
}

const CLIP = { kind: "clip", jobId: "job-0001", avatarId: "avatar-lia-0007", clipId: "job-0001", total: 4 } as const;

describe("a clip's job.progress", () => {
  test("writes the clip's own phase, its steps and its model, and masks the clock", () => {
    const norm = normalizer();
    const line = eventLine(event({ ...CLIP, done: 0, phase: "rendering", model: "kling", submittedAt: "2026-10-14T10:00:00.000Z" }), norm);
    expect(line).toBe('event job.progress {"kind":"clip","jobId":"job#1","avatarId":"avatar#1","clipId":"job#1","total":4,"phase":"rendering","done":0,"model":"kling","submittedAt":"<set>"}');
  });

  test("the proof window's end is masked, and written only where the engine sends it", () => {
    const norm = normalizer();
    const line = eventLine(event({ ...CLIP, done: 0, phase: "proving", model: "kling", proveUntil: "2026-10-14T10:02:00.000Z" }), norm);
    expect(line).toBe('event job.progress {"kind":"clip","jobId":"job#1","avatarId":"avatar#1","clipId":"job#1","total":4,"phase":"proving","done":0,"model":"kling","proveUntil":"<set>"}');
    expect(eventLine(event({ ...CLIP, done: 0, phase: "preparing" }), norm)).toBe('event job.progress {"kind":"clip","jobId":"job#1","avatarId":"avatar#1","clipId":"job#1","total":4,"phase":"preparing","done":0}');
  });

  test("an export's progress is not a line: the engine counts the frames ffmpeg wrote when it wrote them, the mock plays a few steps, and where the first one lands against the answer is a race", () => {
    const norm = normalizer();
    const exporting = { ...CLIP, jobId: "job-0002", total: 150, phase: "exporting" } as const;
    for (const done of [0, 47, 150]) expect(eventLine(event({ ...exporting, done }), norm)).toBeNull();
  });

  test("what an export reported is a fact a story can write: it began at the start, only went forward, and said more than once", async () => {
    const seen: EventMessage[] = [];
    const rig: Recorded = { events: () => seen, send: async () => ({ ok: true, result: {} }), advance: async () => undefined, settle: async () => undefined };
    const transcript = new Transcript(rig, normalizer());
    const exporting = { ...CLIP, total: 150, phase: "exporting" } as const;
    seen.push(...[0, 10, 40, 150].map((done) => event({ ...exporting, done })));
    expect(transcript.exportProgress("job-0001")).toEqual({ began: true, forward: true, steps: 4 });
    expect(transcript.exportProgress("job-0042")).toEqual({ began: false, forward: true, steps: 0 });
  });

  test("a job's steps never go back and never pass its total: the rule both engines are held to in place of the numbers", async () => {
    const seen: EventMessage[] = [];
    const rig: Recorded = { events: () => seen, send: async () => ({ ok: true, result: {} }), advance: async () => undefined, settle: async () => undefined };
    const transcript = new Transcript(rig, normalizer());
    seen.push(event({ ...CLIP, done: 2, phase: "checking" }), event({ ...CLIP, done: 1, phase: "downloading" }));
    await expect(transcript.settle()).rejects.toThrow(/clip/i);
  });

  describe("the facts of a clip create job (S5.V8b): held on both engines, written in no line", () => {
    const PAYLOAD = { avatarId: "avatar-lia-0007", photoId: "photo-lia-0003", motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: 850_000 };
    const FACTS = { photoId: "photo-lia-0003", request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" }, motion: { source: "code", label: "Моргает и улыбается" }, acceptedWorstMicros: 850_000 };

    /** A transcript whose rig has already told `events` when the create is answered (they come BEFORE the answer, as a job's first events do). */
    function created(events: EventMessage[]): { transcript: Transcript; seen: EventMessage[] } {
      const seen: EventMessage[] = [];
      const rig: Recorded = { events: () => seen, send: async () => ({ ok: true, result: { jobId: "job-0001" } }), advance: async () => undefined, settle: async () => undefined };
      const transcript = new Transcript(rig, normalizer());
      seen.push(...events);
      return { transcript, seen };
    }

    test("a create whose job tells the facts it was asked for is accepted, and its lines are as they were", async () => {
      const { transcript } = created([event({ ...CLIP, done: 0, phase: "preparing", ...FACTS }), event({ ...CLIP, done: 0, phase: "submitting", model: "kling", ...FACTS, openReserveMicros: 504_000 })]);
      await transcript.call("clips.create", PAYLOAD);
      expect(transcript.lines().filter((l) => l.startsWith("event job.progress"))).toEqual([
        'event job.progress {"kind":"clip","jobId":"job#1","avatarId":"avatar#1","clipId":"job#1","total":4,"phase":"preparing","done":0}',
        'event job.progress {"kind":"clip","jobId":"job#1","avatarId":"avatar#1","clipId":"job#1","total":4,"phase":"submitting","done":0,"model":"kling"}',
      ]);
    });

    test("a create whose job tells no facts is refused: both engines are held to carry them", async () => {
      const { transcript } = created([event({ ...CLIP, done: 0, phase: "preparing" })]);
      await expect(transcript.call("clips.create", PAYLOAD)).rejects.toThrow(/facts/i);
    });

    test("a create whose job names another photo or another accepted worst case is refused", async () => {
      const otherPhoto = created([event({ ...CLIP, done: 0, phase: "preparing", ...FACTS, photoId: "photo-lia-0009" })]);
      await expect(otherPhoto.transcript.call("clips.create", PAYLOAD)).rejects.toThrow(/photo/i);
      const otherWorst = created([event({ ...CLIP, done: 0, phase: "preparing", ...FACTS, acceptedWorstMicros: 504_000 })]);
      await expect(otherWorst.transcript.call("clips.create", PAYLOAD)).rejects.toThrow(/accepted/i);
    });

    test("an event that comes after the answer is held to the same facts", async () => {
      const { transcript, seen } = created([event({ ...CLIP, done: 0, phase: "preparing", ...FACTS })]);
      await transcript.call("clips.create", PAYLOAD);
      seen.push(event({ ...CLIP, done: 0, phase: "rendering", model: "kling", submittedAt: "2026-10-14T10:00:00.000Z" }));
      await expect(transcript.settle()).rejects.toThrow(/facts/i);
    });

    test("a create job in a phase that holds a reserve open tells it, within what the owner accepted", async () => {
      for (const phase of ["submitting", "rendering", "proving", "late"] as const) {
        const without = created([event({ ...CLIP, done: 0, phase, model: "kling", ...FACTS })]);
        await expect(without.transcript.call("clips.create", PAYLOAD)).rejects.toThrow(/reserve/i);
      }
      const above = created([event({ ...CLIP, done: 0, phase: "rendering", model: "kling", ...FACTS, openReserveMicros: 850_001 })]);
      await expect(above.transcript.call("clips.create", PAYLOAD)).rejects.toThrow(/reserve/i);
      const within = created([event({ ...CLIP, done: 0, phase: "rendering", model: "kling", ...FACTS, openReserveMicros: 504_000 })]);
      await within.transcript.call("clips.create", PAYLOAD);
    });

    test("a create job's first phase, before any reserve, needs none", async () => {
      const { transcript } = created([event({ ...CLIP, done: 0, phase: "preparing", ...FACTS })]);
      await transcript.call("clips.create", PAYLOAD);
    });

    test("a job that no create asked for (an export, a retried download) is not held to them", async () => {
      const { transcript } = created([event({ ...CLIP, jobId: "job-0005", done: 0, phase: "downloading" })]);
      await transcript.call("clips.create", PAYLOAD);
      await transcript.settle();
    });
  });

  test("a render's progress is written as it always was", () => {
    const norm = new Normalizer();
    const line = eventLine(event({ kind: "render", jobId: "job-0001", videoId: "video-0001", avatarId: "avatar-lia-0007", montageId: null, done: 0, total: 240 }), norm);
    expect(line).toBe('event job.progress {"kind":"render","jobId":"job#1","videoId":"video#1","avatarId":"avatar#1","montageId":null,"total":240,"phase":"start"}');
  });
});

describe("a clip's end", () => {
  test("job.done carries the clip, and the copy's place with its date masked", () => {
    const norm = normalizer();
    const done = eventLine(event({ jobId: "job-0009", result: { kind: "clip", avatarId: "avatar-lia-0007", clipId: "job-0001", exported: { relPath: "Lia/2026-10-14_clip_001.mp4" } } }, "job.done"), norm);
    expect(done).toBe('event job.done {"jobId":"job#1","result":{"kind":"clip","avatarId":"avatar#1","clipId":"clip#1","exported":{"relPath":"Lia/<date>_clip_001.mp4"}}}');
  });
});

describe("a clip job that failed", () => {
  test("is told by its code: the words of a failed download or a failed encode are each engine's own", () => {
    const norm = normalizer();
    const failed = eventLine(event({ kind: "clip", jobId: "job-0003", avatarId: "avatar-lia-0007", clipId: "job-0001", error: { code: "NETWORK", detail: "GET /videos/<id>/content: HTTP 502" } }, "job.failed"), norm);
    expect(failed).toBe('event job.failed {"kind":"clip","jobId":"job#1","avatarId":"avatar#1","clipId":"clip#1","error":{"code":"NETWORK"}}');
  });

  test("another job's failure is written as it was", () => {
    const norm = normalizer();
    const failed = eventLine(event({ kind: "run", jobId: "job-0003", runId: "run-0001", avatarId: "avatar-lia-0007", error: { code: "INTERNAL", detail: "words" } }, "job.failed"), norm);
    expect(failed).toContain('"detail":"words"');
  });
});

describe("an error that names a clip's reason or a price scope", () => {
  const written = (error: EngineError): string => answerLine("clips.create", { ok: false, error }, normalizer());

  test("writes the clipReason and the priceScope, where an older error writes neither", () => {
    expect(written({ code: "VALIDATION", clipReason: "no-motion", detail: "the engine's words" })).toBe('< error VALIDATION {"clipReason":"no-motion"}');
    expect(written({ code: "IN_FLIGHT", clipReason: "one-at-a-time" })).toBe('< error IN_FLIGHT {"clipReason":"one-at-a-time"}');
    expect(written({ code: "PRICE_UNAVAILABLE", priceScope: "video" })).toBe('< error PRICE_UNAVAILABLE {"priceScope":"video"}');
  });

  test("an older error is written as it was", () => {
    expect(answerLine("videos.get", { ok: false, error: { code: "NOT_FOUND", detail: "no photo" } }, normalizer())).toBe('< error NOT_FOUND {"detail":"no photo"}');
  });
});

describe("the sheet", () => {
  const estimate = (expectedMicros: number, worstMicros: number) => ({ expectedMicros, worstMicros, prices: "live", pricesAsOf: "2026-10-14" });
  const options = {
    suitable: true,
    photoId: "photo-lia-1",
    motions: [{ id: "g-blink", source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" }],
    prices: { std5: estimate(420_000, 850_000), pro5: estimate(560_000, 850_000), std10: estimate(840_000, 1_550_000), pro10: estimate(1_120_000, 1_550_000), grok5: estimate(710_000, 850_000), grok10: estimate(1_410_000, 1_550_000) },
    fallback: "auto",
    bold: false,
    noFallbackPrices: { std5: estimate(420_000, 504_000), pro5: estimate(560_000, 672_000), std10: estimate(840_000, 924_000), pro10: estimate(1_120_000, 1_232_000) },
    monthFits: { std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" },
  };

  test("clips.options writes the motions, the figures as expected and worst, the source of the prices, and no date", () => {
    const answer: Answer = { ok: true, result: options };
    const line = answerLine("clips.options", answer, normalizer());
    expect(line).toBe(
      '< ok {"suitable":true,"photoId":"photo#1","motions":[{"id":"g-blink","source":"code","label":"Моргает и улыбается","text":"she slowly blinks and gives a small smile"}],"fallback":"auto","bold":false,"source":"live","prices":{"std5":[420000,850000],"pro5":[560000,850000],"std10":[840000,1550000],"pro10":[1120000,1550000],"grok5":[710000,850000],"grok10":[1410000,1550000]},"noFallbackPrices":{"std5":[420000,504000],"pro5":[560000,672000],"std10":[840000,924000],"pro10":[1120000,1232000]},"monthFits":{"std5":"with-fallback","pro5":"with-fallback","std10":"with-fallback","pro10":"with-fallback"}}',
    );
  });

  test("an unsuitable photo is written as it is: a photo and a reason", () => {
    const line = answerLine("clips.options", { ok: true, result: { suitable: false, photoId: "photo-lia-2", reason: "no-motion" } }, normalizer());
    expect(line).toBe('< ok {"suitable":false,"photoId":"photo#1","reason":"no-motion"}');
  });
});

describe("a clip in a list", () => {
  const ready = {
    clipId: "job-0001",
    avatarId: "avatar-lia-0007",
    photoId: "photo-lia-1",
    createdAt: "2026-10-14T10:00:00.000Z",
    seen: false,
    motion: { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
    request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
    model: "kling-std",
    fallback: false,
    recovered: false,
    cost: { micros: 420_000, kind: "billed" },
    providerCostMicros: 420_000,
    exports: [{ rootId: "root-0001", relPath: "Lia/2026-10-14_clip_001.mp4", profile: "1080p30-dup", at: "2026-10-14T10:05:00.000Z", bytes: 123_456, sha256: "a".repeat(64), fileState: "present" }],
    status: "ready",
    width: 720,
    height: 1280,
    durationMs: 5_033,
    face: { verdict: "match", p75: 0.86, frames: 11 },
  };

  test("is told by its facts: the money, the size and length in whole seconds, the face verdict with its frames only as enough", () => {
    const line = answerLine("clips.get", { ok: true, result: { clip: ready } }, normalizer());
    expect(line).toBe(
      '< ok {"clip":{"clipId":"clip#1","photoId":"photo#1","status":"ready","seen":false,"motion":{"source":"code","label":"Моргает и улыбается","text":"she slowly blinks and gives a small smile"},"request":{"model":"kling","quality":"std","seconds":5,"fallback":"auto"},"model":"kling-std","fallback":false,"recovered":false,"cost":{"micros":420000,"kind":"billed"},"providerCostMicros":420000,"exports":[{"rootId":"root#1","relPath":"Lia/<date>_clip_001.mp4","profile":"1080p30-dup","fileState":"present"}],"width":720,"height":1280,"seconds":5,"face":{"verdict":"match","p75":0.86,"frames":"enough"}}}',
    );
  });

  test("a failed clip is told by its reason, the Grok offer's figures and whether its download can be retried", () => {
    const failed = {
      ...ready,
      status: "failed",
      exports: [],
      failure: { reason: "refused-free", grokOffer: { expectedMicros: 710_000, worstMicros: 850_000, prices: "live", pricesAsOf: "2026-10-14" } },
      retryDownloadUntil: "2026-10-14T11:00:00.000Z",
    };
    const { width: _w, height: _h, durationMs: _d, face: _f, ...rest } = failed;
    const line = answerLine("clips.list", { ok: true, result: { clips: [rest] } }, normalizer());
    expect(line).toContain('"failure":{"reason":"refused-free","grokOffer":[710000,850000]}');
    expect(line).toContain('"retryDownloadUntil":"<set>"');
    expect(line).not.toContain("createdAt");
  });

  test("a face check that found too few faces says how many", () => {
    const line = answerLine("clips.get", { ok: true, result: { clip: { ...ready, exports: [], face: { verdict: "skipped", frames: 2, why: "few-faces" } } } }, normalizer());
    expect(line).toContain('"face":{"verdict":"skipped","frames":2,"why":"few-faces"}');
  });
});

describe("the money", () => {
  test("money.status writes whether a reconcile is needed, why, whether it is held (never until when), and the sums", () => {
    const line = answerLine(
      "money.status",
      { ok: true, result: { ledger: "open", month: "2026-10", spentMicros: 420_000, monthlyBudgetMicros: 10_000_000, unsettledMicros: 504_000, unsettledCount: 1, reconcileNeeded: false, reconcileReasons: [], halt: null, reconcileAvailableAt: "2026-10-14T10:20:00.000Z" } },
      normalizer(),
    );
    expect(line).toBe('< ok {"reconcileNeeded":false,"reconcileReasons":[],"held":true,"spentMicros":420000,"unsettledMicros":504000,"unsettledCount":1}');
  });

  test("money.reconcile writes the status and what it closed; a too-early answer never writes the time to wait", () => {
    expect(answerLine("money.reconcile", { ok: true, result: { status: "done", closedReserves: 1, creditsDeltaMicros: 504_000, ledgerDeltaMicros: 504_000, mismatch: false } }, normalizer())).toBe('< ok {"status":"done","closedReserves":1}');
    expect(answerLine("money.reconcile", { ok: true, result: { status: "too-early", retryAfterMs: 1_100, warnings: [] } }, normalizer())).toBe('< ok {"status":"too-early"}');
  });
});
