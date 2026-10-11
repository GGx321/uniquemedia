import { describe, expect, test } from "bun:test";
import type { AvatarSummary, EventMessage } from "../../shared/engine";
import { MockEngine, mockEngineClient } from "./mockEngine";
import { MIA } from "./mockEngine.testkit";
import { MOCK_PORTRAIT_IMAGE_MICROS, MOCK_PORTRAIT_SLOTS, MOCK_PORTRAIT_SLOTS_SOME_FAILED, type MockPortraitSlot } from "./mockPortraits";
import { ManualScheduler } from "./scheduler";

// S5.3d review L6: the dev mock can show 16e (a batch that ended `done` with paid failed slots) — a demo-only outcome, never in the table the parity
// rig plays (`MOCK_PORTRAIT_SLOTS`, unchanged), so no parity story moves.

const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0004", name: "Nini", masterPhotoId: "photo-nini-source" };
const BATCH = 5 * MOCK_PORTRAIT_IMAGE_MICROS;

function makeMock(options: ConstructorParameters<typeof MockEngine>[0] = {}) {
  const scheduler = new ManualScheduler();
  const engine = new MockEngine({ scheduler, avatars: [NINI], portraits: [{ avatarId: NINI.avatarId, sourcePhotoId: NINI.masterPhotoId }], ...options });
  const client = mockEngineClient(engine);
  const events: EventMessage[] = [];
  client.subscribe((e) => events.push(e));
  return { scheduler, engine, client, events };
}

async function run(m: ReturnType<typeof makeMock>, avatarId: string) {
  const reply = await m.client.request("avatars.generatePortraits", { avatarId, acceptedWorstMicros: BATCH });
  if (!reply.ok) throw new Error(`generatePortraits: ${reply.error.code}`);
  m.scheduler.runAll();
  const done = m.events.find((e) => e.type === "job.done" && e.payload.jobId === reply.result.jobId);
  if (done?.type !== "job.done" || done.payload.result.kind !== "avatar.portraits") throw new Error("expected a portraits job.done");
  return done.payload.result;
}

describe("a failed slot at a cost (demo only)", () => {
  test("is reported failed with its error, and a timeout's reserve stays open at the worst until a reconcile", async () => {
    const m = makeMock();
    const timedOut: MockPortraitSlot = { kind: "failed", error: { code: "TIMEOUT" }, settle: "open" };
    m.engine.scriptNextPortraits({ slots: [{ kind: "pass", likeness: 0.76 }, { kind: "pass", likeness: 0.72 }, { kind: "pass", likeness: 0.61 }, timedOut, timedOut] });
    const result = await run(m, NINI.avatarId);
    expect(result.candidates.map((c) => c.likeness)).toEqual([0.76, 0.72, 0.61]);
    expect(result.failedSlots).toEqual([
      { slot: 4, reason: "failed", error: { code: "TIMEOUT" }, reserveLeftOpen: true, charge: "worst-until-reconcile" },
      { slot: 5, reason: "failed", error: { code: "TIMEOUT" }, reserveLeftOpen: true, charge: "worst-until-reconcile" },
    ]);
    const money = await m.client.request("money.status", {});
    if (!money.ok || money.result.ledger !== "open") throw new Error("the ledger is not open");
    expect(money.result.unsettledMicros).toBe(2 * MOCK_PORTRAIT_IMAGE_MICROS);
  });

  test("a paid failure is spent at the image price; a free one costs nothing", async () => {
    const paid = makeMock();
    paid.engine.scriptNextPortraits({ slots: [{ kind: "failed", error: { code: "INTERNAL" }, settle: "paid" }, ...Array.from({ length: 4 }, () => ({ kind: "pass" as const, likeness: 0.7 }))] });
    await run(paid, NINI.avatarId);
    const free = makeMock();
    free.engine.scriptNextPortraits({ slots: [{ kind: "failed", error: { code: "BUDGET_EXCEEDED" }, settle: "free" }, ...Array.from({ length: 4 }, () => ({ kind: "pass" as const, likeness: 0.7 }))] });
    await run(free, NINI.avatarId);
    const spent = async (m: ReturnType<typeof makeMock>): Promise<number> => {
      const money = await m.client.request("money.status", {});
      if (!money.ok || money.result.ledger !== "open") throw new Error("the ledger is not open");
      return money.result.spentMicros;
    };
    expect((await spent(paid)) - (await spent(free))).toBe(MOCK_PORTRAIT_IMAGE_MICROS);
  });

  test("the demo's Ava plays 16e: three portraits and two timeouts; the parity rig's table is unchanged", async () => {
    const m = makeMock({ preset: "demo", demoPortraits: true, avatars: undefined, portraits: undefined });
    const listed = await m.client.request("avatars.list", {});
    const ava = listed.ok ? listed.result.avatars.find((a) => a.name === "Ava") : undefined;
    if (ava === undefined) throw new Error("no demo Ava");
    const result = await run(m, ava.avatarId);
    expect(result.failedSlots.map((f) => (f.reason === "failed" ? [f.error.code, f.reserveLeftOpen] : f.reason))).toEqual([
      ["TIMEOUT", true],
      ["TIMEOUT", true],
    ]);
    expect(MOCK_PORTRAIT_SLOTS_SOME_FAILED.filter((s) => s.kind === "pass")).toHaveLength(3);
    expect(MOCK_PORTRAIT_SLOTS.every((s) => s.kind !== "failed")).toBe(true);
  });
});
