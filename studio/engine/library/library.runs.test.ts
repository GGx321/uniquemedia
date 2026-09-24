import { describe, expect, test } from "bun:test";
import { appendFile, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { openLibrary, type LibraryDeps } from "./library";
import { expectLibraryError, rejectionOf, steppingClock, useTempDir } from "./testing/helpers";

const root = useTempDir("studio-runs-");

const Plan = z.object({ avatarId: z.string(), slots: z.array(z.object({ id: z.string(), attempts: z.array(z.string()) })) });
type Plan = z.infer<typeof Plan>;

const Event = z.object({ type: z.enum(["reserve", "sent", "done"]), attemptId: z.string() });
type Event = z.infer<typeof Event>;

const PLAN: Plan = {
  avatarId: "avatar-0001",
  slots: [{ id: "slot-0001", attempts: ["slot-0001#1", "slot-0001#2", "slot-0001#3"] }],
};

const RUN = "run-00000001";

async function open(extra: LibraryDeps = {}) {
  return (await openLibrary(root(), { now: steppingClock(), ...extra })).library;
}

function event(type: Event["type"], attemptId = "slot-0001#1"): Event {
  return { type, attemptId };
}

describe("createRun and readRun", () => {
  test("writes plan.json in the run folder and reads it back through the schema", async () => {
    const library = await open();

    await library.createRun(RUN, PLAN, Plan);

    expect(JSON.parse(await readFile(join(root(), "runs", RUN, "plan.json"), "utf8"))).toEqual(PLAN);
    expect(await library.readRun(RUN, Plan)).toEqual(PLAN);
  });

  test("refuses a run that already exists and keeps its plan", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);

    await expectLibraryError(library.createRun(RUN, { ...PLAN, avatarId: "other-avatar" }, Plan), "run-exists");

    expect(await library.readRun(RUN, Plan)).toEqual(PLAN);
  });

  test("refuses a run id that breaks the id pattern", async () => {
    const library = await open();
    await expectLibraryError(library.createRun("../escape-run", PLAN, Plan), "invalid-id");
    await expectLibraryError(library.createRun("RUN-00000001", PLAN, Plan), "invalid-id");
    expect(await readdir(join(root(), "runs"))).toEqual([]);
  });

  test("refuses a plan that fails its schema and creates nothing", async () => {
    const library = await open();
    const bad: unknown = { avatarId: 7 };

    await expectLibraryError(library.createRun(RUN, bad, Plan), "invalid-record");

    expect(await readdir(join(root(), "runs"))).toEqual([]);
  });

  test("a crash before the run folder is renamed into place leaves no run, and the next open quarantines the leftover", async () => {
    const crash = new Error("simulated crash");
    const library = await open({ testHooks: { beforeRename: () => { throw crash; } } });

    expect(await rejectionOf(library.createRun(RUN, PLAN, Plan))).toBe(crash);
    await expectLibraryError(library.readRun(RUN, Plan), "run-not-found");

    const { report, library: reopened } = await openLibrary(root());
    expect(report.quarantined.map((q) => q.reason)).toEqual(["temp-file"]);
    expect(report.quarantined[0].from).toMatch(/^runs[\\/]\.run-00000001\..+\.tmp$/);
    expect(await readdir(join(root(), "runs"))).toEqual([]);
    // Nothing blocks creating the run for real now.
    await reopened.createRun(RUN, PLAN, Plan);
    expect(await reopened.readRun(RUN, Plan)).toEqual(PLAN);
  });

  test("readRun refuses an unknown run", async () => {
    const library = await open();
    await expectLibraryError(library.readRun(RUN, Plan), "run-not-found");
  });

  test("readRun refuses a plan on disk that fails the schema", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    await writeFile(join(root(), "runs", RUN, "plan.json"), JSON.stringify({ avatarId: 1 }));

    await expectLibraryError(library.readRun(RUN, Plan), "invalid-run-plan");
  });

  test("readRun refuses a plan on disk that is not JSON", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    await writeFile(join(root(), "runs", RUN, "plan.json"), "{");

    await expectLibraryError(library.readRun(RUN, Plan), "invalid-run-plan");
  });
});

describe("appendJournal and readJournal", () => {
  test("a new run has an empty journal", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    expect(await library.readJournal(RUN, Event)).toEqual({ events: [], torn: null });
  });

  test("events read back in the order they were appended", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);

    await library.appendJournal(RUN, event("reserve"), Event);
    await library.appendJournal(RUN, event("sent"), Event);
    await library.appendJournal(RUN, event("done"), Event);

    expect(await library.readJournal(RUN, Event)).toEqual({
      events: [event("reserve"), event("sent"), event("done")],
      torn: null,
    });
    expect(await readFile(join(root(), "runs", RUN, "journal.jsonl"), "utf8")).toBe(
      [event("reserve"), event("sent"), event("done")].map((e) => `${JSON.stringify(e)}\n`).join("")
    );
  });

  test("tolerates a torn last line and reports it", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    await library.appendJournal(RUN, event("reserve"), Event);
    await appendFile(join(root(), "runs", RUN, "journal.jsonl"), '{"type":"se');

    expect(await library.readJournal(RUN, Event)).toEqual({ events: [event("reserve")], torn: '{"type":"se' });
  });

  test("an append after a torn line stays readable and the torn text is kept aside", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    await library.appendJournal(RUN, event("reserve"), Event);
    await appendFile(join(root(), "runs", RUN, "journal.jsonl"), '{"type":"se');

    await library.appendJournal(RUN, event("done"), Event);

    expect(await library.readJournal(RUN, Event)).toEqual({ events: [event("reserve"), event("done")], torn: null });
    expect(await readFile(join(root(), "runs", RUN, "journal.jsonl.torn"), "utf8")).toBe('{"type":"se\n');
  });

  test("appends that are not awaited land in call order", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    const events = Array.from({ length: 100 }, (_, i) => event("sent", `slot-0001#${i}`));

    await Promise.all(events.map((e) => library.appendJournal(RUN, e, Event)));

    expect((await library.readJournal(RUN, Event)).events).toEqual(events);
  });

  test("a read issued after an append that is not awaited yet sees that append", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);

    const pending = library.appendJournal(RUN, event("reserve"), Event);
    const read = await library.readJournal(RUN, Event);
    await pending;

    expect(read).toEqual({ events: [event("reserve")], torn: null });
  });

  test("refuses an event that fails its schema and writes nothing", async () => {
    const library = await open();
    await library.createRun(RUN, PLAN, Plan);
    const bad: unknown = { type: "refund", attemptId: "x" };

    await expectLibraryError(library.appendJournal(RUN, bad, Event), "invalid-record");

    expect(await library.readJournal(RUN, Event)).toEqual({ events: [], torn: null });
  });

  test("refuses to append to or read an unknown run", async () => {
    const library = await open();
    await expectLibraryError(library.appendJournal(RUN, event("reserve"), Event), "run-not-found");
    await expectLibraryError(library.readJournal(RUN, Event), "run-not-found");
    expect(await readdir(join(root(), "runs"))).toEqual([]);
  });
});
