import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { manifestTraits } from "./avatars/records";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { sampleSet } from "./library/testing/sceneSetSample";
import type { LedgerLine } from "./money/ledger";
import { chatBody, fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, GOOD, jobEnd, ok, OFFLINE, startEngine, TRAITS, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.2: the engine wires the launch's `Budget` group and the month room with live caps. The group is read from the registry the orchestrator (S4.6)
// fills before the first reserve; a set's writer attempts are in the group, so a cap below the writer's worst case refuses the call before it leaves. The room
// subtracts the unspent cap of a running job, which `#checkMonthlyRoom` does not see.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-launch-money-");
const libraryDir = () => join(dir(), "library");

const ATTEMPT = 37_500;
const SET = "set-seed-0001";
const RUN = "run-seed-0001";
const JOB = "job-seed-0001";
const AT = "2026-10-07T12:00:00.000Z";
const BUDGET = 10_000_000;

async function seedWrittenSet(): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("seed1") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  const set = sampleSet({ sceneSetId: SET, avatarId: avatar.id, runId: RUN, count: 3, written: 0 });
  await library.sceneSets.create({ ...set, write: { k: 1, kind: "compose", jobId: JOB, stoppedBy: "network" }, writes: 1 });
  return avatar.id;
}

const SENTENCE = "A friend catches her mid-laugh at the kitchen counter as morning light spills across the table.";

function slotsAskedFor(call: FetchCall): number[] {
  const messages = Array.isArray(call.json().messages) ? (call.json().messages as unknown[]) : [];
  const user = messages.find((m) => typeof m === "object" && m !== null && "role" in m && m.role === "user");
  const text = typeof user === "object" && user !== null && "content" in user && typeof user.content === "string" ? user.content : "";
  return (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
}

function network(opts: { writer?: (call: FetchCall) => Reply | Promise<Reply> } = {}) {
  const good = (call: FetchCall): Reply => ({ status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) });
  const route = async (call: FetchCall): Promise<Reply> => {
    if (call.url.endsWith("/chat/completions")) return (opts.writer ?? good)(call);
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    if (call.url.endsWith("/models") || call.url.endsWith("/endpoints")) return OFFLINE;
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 64 }, () => route));
  return { fetch: net.fetch, calls: net.calls, writerCalls: () => net.calls.filter((c) => c.url.endsWith("/chat/completions")), imageCalls: () => [], ageCalls: () => [], descriptorCalls: () => [], paidCalls: () => net.calls.filter((c) => c.method === "POST") };
}

function engineOver(net: ReturnType<typeof network>) {
  return startEngine(dir(), { init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: BUDGET }) }, net });
}

function ledgerReserves(): string[] {
  const path = join(dir(), "userData", "ledger.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      const parsed = JSON.parse(line) as { type: string; attemptId: string };
      return parsed.type === "reserve" ? [parsed.attemptId] : [];
    });
}

async function setRevision(engine: Awaited<ReturnType<typeof engineOver>>["engine"], avatarId: string): Promise<number> {
  const result = ok(await engine.handle(command("scenes.get", { avatarId })));
  if (result.type !== "scenes.get" || result.result.sceneSet === null) throw new Error("expected a scene set");
  return result.result.sceneSet.revision;
}

const writeCommand = (revision: number) => command("scenes.write", { sceneSetId: SET, revision, target: { kind: "unwritten" }, acceptedWorstMicros: 2 * ATTEMPT });

describe("the launch group in the engine's Budget", () => {
  test("a writer attempt of a registered launch set above the group's cap is refused before any request leaves", async () => {
    const avatarId = await seedWrittenSet();
    const net = network();
    const { engine, events } = await engineOver(net);
    engine.launchGroups.register({ launchId: "L1", capMicros: ATTEMPT - 1, setIds: [SET], runIds: [] });

    const response = await engine.handle(writeCommand(await setRevision(engine, avatarId)));
    const result = ok(response);
    if (result.type !== "scenes.write") throw new Error("expected a write answer");
    await jobEnd(events, result.result.jobId);

    expect(net.writerCalls()).toHaveLength(0);
    expect(ledgerReserves()).toEqual([]);
  });

  test("with the cap at one attempt's worst case the same write goes through", async () => {
    const avatarId = await seedWrittenSet();
    const net = network();
    const { engine, events } = await engineOver(net);
    engine.launchGroups.register({ launchId: "L1", capMicros: ATTEMPT, setIds: [SET], runIds: [] });

    const result = ok(await engine.handle(writeCommand(await setRevision(engine, avatarId))));
    if (result.type !== "scenes.write") throw new Error("expected a write answer");
    await jobEnd(events, result.result.jobId);

    expect(net.writerCalls()).toHaveLength(1);
    expect(ledgerReserves()).toEqual([`${SET}:writer-1#1`]);
  });

  test("a set that is not in a launch is not limited", async () => {
    const avatarId = await seedWrittenSet();
    const net = network();
    const { engine, events } = await engineOver(net);
    engine.launchGroups.register({ launchId: "L1", capMicros: 0, setIds: ["set-other"], runIds: [] });

    const result = ok(await engine.handle(writeCommand(await setRevision(engine, avatarId))));
    if (result.type !== "scenes.write") throw new Error("expected a write answer");
    await jobEnd(events, result.result.jobId);

    expect(net.writerCalls()).toHaveLength(1);
  });

  test("a group restored from a launch file at open limits the writer like one registered by hand", async () => {
    const avatarId = await seedWrittenSet();
    const net = network();
    const { engine, events } = await engineOver(net);
    engine.launchGroups.restore([{ launchId: "L1", capMicros: 1, setIds: [SET], runIds: [], finished: false }]);

    const result = ok(await engine.handle(writeCommand(await setRevision(engine, avatarId))));
    if (result.type !== "scenes.write") throw new Error("expected a write answer");
    await jobEnd(events, result.result.jobId);

    expect(net.writerCalls()).toHaveLength(0);
  });

  test("a finished launch limits nothing", async () => {
    const avatarId = await seedWrittenSet();
    const net = network();
    const { engine, events } = await engineOver(net);
    engine.launchGroups.register({ launchId: "L1", capMicros: 1, setIds: [SET], runIds: [] });
    engine.launchGroups.finish("L1");

    const result = ok(await engine.handle(writeCommand(await setRevision(engine, avatarId))));
    if (result.type !== "scenes.write") throw new Error("expected a write answer");
    await jobEnd(events, result.result.jobId);

    expect(net.writerCalls()).toHaveLength(1);
  });
});

describe("the engine's month room", () => {
  const settledLines = (costMicros: number): LedgerLine[] => [
    { type: "reserve", attemptId: "old#1", jobId: "old", scope: { avatarJobId: "old" }, model: "m", worstMicros: costMicros, at: "2026-10-01T10:00:00.000Z" },
    { type: "settle", attemptId: "old#1", costMicros, estimated: false, at: "2026-10-01T10:00:00.000Z" },
  ];

  test("with nothing running it is the budget less what is spent this month", async () => {
    await writeLedger(dir(), settledLines(1_500_000));
    const { engine } = await engineOver(network());
    expect(engine.monthRoom()).toEqual({ budgetMicros: BUDGET, committedMicros: 1_500_000, freeMicros: BUDGET - 1_500_000 });
  });

  test("while a scene write runs, its job's whole cap is off the room, not only the attempt in flight", async () => {
    const avatarId = await seedWrittenSet();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrived = 0;
    const net = network({
      writer: async (call) => {
        arrived++;
        await gate;
        return { status: 200, body: chatBody(JSON.stringify({ scenes: slotsAskedFor(call).map((slotIndex) => ({ slotIndex, sentence: `${SENTENCE} (${slotIndex})` })) }), { cost: 0.0112 }) };
      },
    });
    const { engine, events } = await engineOver(net);
    const result = ok(await engine.handle(writeCommand(await setRevision(engine, avatarId))));
    if (result.type !== "scenes.write") throw new Error("expected a write answer");
    await until(() => arrived === 1, "the writer's request");

    // One attempt is open at its worst case (37 500) and another may still follow inside the cap of two attempts (75 000).
    expect(engine.monthRoom()).toEqual({ budgetMicros: BUDGET, committedMicros: 2 * ATTEMPT, freeMicros: BUDGET - 2 * ATTEMPT });
    expect(engine.budget?.status().openReserveMicros).toBe(ATTEMPT);

    release();
    await jobEnd(events, result.result.jobId);
    // The job is over and its cap is dropped: only what it spent is committed.
    expect(engine.monthRoom()?.committedMicros).toBeLessThan(2 * ATTEMPT);
  });

  test("the launch's resumable slices count through the extra live scopes", async () => {
    const { engine } = await engineOver(network());
    expect(engine.monthRoom([{ scope: { runId: "slice-1" }, capMicros: 5_250_000 }])).toEqual({ budgetMicros: BUDGET, committedMicros: 5_250_000, freeMicros: BUDGET - 5_250_000 });
  });
});
