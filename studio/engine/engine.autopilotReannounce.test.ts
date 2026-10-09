import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { LaunchView, type LaunchDraftInput } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import { FakeSteps } from "./autopilot/testing/fakeSteps";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { fakeFetch, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, GOOD, KEY, NOW, ok, startEngine, TRAITS, until, useEngineDir, writeLedger } from "./testing/engineHarness";
import { within } from "./testing/within";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 4, S4.6w, H1 of the S4.9b review: the view of a launch derives from the money (R, «Продолжить» closed by a reconcile), the key and the budget. The engine announces the launch again when
// any of them changes, so a window that holds a paused launch sees «Продолжить» open the moment the reconcile settles, without reading the launch again.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-autopilot-reannounce-");
const libraryDir = () => join(dir(), "library");
const launchPath = (launchId: string) => join(libraryDir(), "autopilot", `${launchId}.json`);
/** The monotonic clock the second engine runs on; the test moves it to let the ledger be quiet. */
let mono = 0;

async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(libraryDir(), { now: steppingClock(), newId: sequentialIds("reannounce") });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

const draftOf = (avatarIds: string[]): LaunchDraftInput => ({
  avatarIds,
  videosPerAvatar: 4,
  mix: { single: 50, collage: 25, slides: 25 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
});

/** /credits is the only request this test lets through. */
function creditsOnly() {
  const route = async (call: { url: string; method: string }): Promise<Reply> => {
    if (call.url.endsWith("/credits")) return { status: 200, body: { data: { total_credits: 25, total_usage: 1 } } };
    throw new Error(`unexpected request to ${call.method} ${call.url}`);
  };
  const net = fakeFetch(Array.from({ length: 16 }, () => route));
  return { fetch: net.fetch, calls: net.calls, imageCalls: () => [], ageCalls: () => [], descriptorCalls: () => [], paidCalls: () => net.calls.filter((c) => c.method === "POST") };
}

type Started = Awaited<ReturnType<typeof startEngine>>;

async function startOver(steps: FakeSteps, over: { key?: string | null; budget?: number } = {}): Promise<Started> {
  await mkdir(join(dir(), "export"), { recursive: true });
  return startEngine(dir(), {
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: over.budget ?? 10_000_000 }) },
    net: creditsOnly(),
    ...(over.key === undefined ? {} : { key: over.key }),
    deps: { launchSteps: steps, monotonic: () => mono },
  });
}

async function startLaunch(started: Started, avatarId: string): Promise<LaunchView> {
  const draft = draftOf([avatarId]);
  const estimate = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
  if (estimate.type !== "autopilot.estimate") throw new Error("not an estimate");
  const { preview } = estimate.result;
  const answer = ok(await started.engine.handle(command("autopilot.start", { draft: { ...draft, planSeed: preview.planSeed }, acceptedWorstMicros: preview.estimate.worstMicros })));
  if (answer.type !== "autopilot.start") throw new Error("not a start");
  return answer.result.launch;
}

async function getView(started: Started, launchId: string): Promise<LaunchView> {
  const answer = ok(await within(started.engine.handle(command("autopilot.get", { launchId })), 10_000, "autopilot.get"));
  if (answer.type !== "autopilot.get") throw new Error("wrong answer");
  return answer.result.launch;
}

/** The `autopilot.changed` events so far, parsed through the contract. */
const announced = (started: Started): LaunchView[] =>
  started.events().flatMap((e) => (e.type === "autopilot.changed" ? [LaunchView.parse(e.payload.launch)] : []));

/** A launch whose engine restarted with a reserve of the previous process open in the launch's group: paused, and «Продолжить» closed by a reconcile. */
async function pausedBehindReconcile() {
  const avatarId = await seedAvatar();
  const first = await startOver(new FakeSteps());
  const launch = await startLaunch(first, avatarId);
  const setId = (JSON.parse(readFileSync(launchPath(launch.launchId), "utf8")) as { avatars: { generation: { sceneSetId: string } | null }[] }).avatars[0]?.generation?.sceneSetId ?? "";
  await writeLedger(dir(), [
    { type: "reserve", attemptId: `${setId}:writer-1#1`, jobId: "job-old-0001", scope: { runId: "run-old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1_000, at: new Date(NOW - 3_600_000).toISOString() },
  ]);
  const second = await startOver(new FakeSteps());
  await second.engine.settled();
  return { launch, second };
}

describe("the engine announces the current launch again when its money changes (H1)", () => {
  test("a reconcile that settles the open reserves clears «Продолжить»'s blocker in an autopilot.changed, with the R the ledger gives now", async () => {
    const { launch, second } = await pausedBehindReconcile();
    const before = announced(second).length;
    expect((await getView(second, launch.launchId)).resumeBlockedBy).toBe("reconcile-required");

    // The ledger has been quiet for long enough: the previous process's request cannot still be running.
    mono = 10 * 60_000;
    const reconciled = ok(await second.engine.handle(command("money.reconcile")));
    expect(reconciled.type === "money.reconcile" && reconciled.result.status).toBe("done");

    await until(() => announced(second).length > before, "an autopilot.changed after the reconcile", 5_000);
    const view = announced(second).at(-1);
    expect(view).toMatchObject({ launchId: launch.launchId, status: "paused", resumeBlockedBy: null });
    expect(view?.remainingMicros).toBe(Math.max(0, (view?.plannedWorstMicros ?? 0) - (view?.spentMicros ?? 0)));
    expect(view?.spentMicros).toBe(1_000);
  });

  test("a key stored after the launch was paused without one is announced: «Продолжить» is no longer closed by the key", async () => {
    const avatarId = await seedAvatar();
    const first = await startOver(new FakeSteps());
    const launch = await startLaunch(first, avatarId);
    const second = await startOver(new FakeSteps(), { key: null });
    await second.engine.settled();
    expect((await getView(second, launch.launchId)).resumeBlockedBy).toBe("key");
    const before = announced(second).length;
    await second.engine.receive({ kind: "control", type: "apiKey.set", key: KEY });
    await until(() => announced(second).length > before, "an autopilot.changed after the key was stored", 5_000);
    expect(announced(second).at(-1)).toMatchObject({ launchId: launch.launchId, status: "paused", resumeBlockedBy: null });
  });

  test("a monthly budget raised in the settings is announced", async () => {
    const avatarId = await seedAvatar();
    const first = await startOver(new FakeSteps());
    const launch = await startLaunch(first, avatarId);
    const second = await startOver(new FakeSteps());
    await second.engine.settled();
    const before = announced(second).length;
    const settings = engineSettings(dir(), { imageAgeCheck: "off", monthlyBudgetMicros: 20_000_000 });
    await second.engine.receive({ kind: "control", type: "settings.update", settings: { ...settings, exportPath: join(dir(), "export") } });
    await until(() => announced(second).length > before, "an autopilot.changed after the budget changed", 5_000);
    expect(announced(second).at(-1)).toMatchObject({ launchId: launch.launchId, status: "paused" });
  });
});
