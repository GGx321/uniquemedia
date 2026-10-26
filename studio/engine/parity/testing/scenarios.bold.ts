import { BANKS } from "../../../shared/scenes/banks";
import type { BankCategory } from "../../../shared/scenes/banks/types";
import { coverageOf } from "../../../shared/scenes/template";
import { ENOUGH, begin, isDone, record, type Telling } from "./scenarios.autopilotRun";
import type { Scenario } from "./scenarios";
import type { World } from "./rigs";
import type { Answer } from "./transcript";

// Stage 5, 5a.3, S5.9f (APPENDED; the golden is append-only, plan s5a3 §12, §15.4): the «Смелая» route told against both engines. S5.9c told the set (the 20 / 40 / 40 mix, the routes, the free refusal);
// these stories tell what the route does when it is DRAWN: a run from that set, a Seedream refusal, a Seedream answer without an image, a launch at the bold unit, and the coverage the sentences carry.
//
// What is compared is what both engines are bound to say, as notes read from quiet answers: the counts of a run's ends, the reasons the slots ended with, whether the run spent anything, and which
// photos carry the route. Never a price (the mock's are its own flat ones, the engine's the bundled table; the one figure both are bound to is the bold unit, 93 000 µ$ an attempt), a slot's number
// (the engine sends its slots at once, so which slot meets a refusal is a race), or an id.

const BOLD_ATTEMPT_MICROS = 93_000;
const ATTEMPTS_PER_PHOTO = 3;

type Rows = Record<string, unknown>[];

const rowsOf = (value: unknown): Rows =>
  Array.isArray(value)
    ? value.flatMap((item): Rows => {
        const row = record(item);
        return row === null ? [] : [row];
      })
    : [];

/** A command answered quietly: the transcript writes nothing for it, the story reads the answer and tells the facts as notes. */
async function quietly(t: Telling, type: string, payload: unknown): Promise<Answer> {
  const answers: Answer[] = [];
  await t.quiet(async () => {
    answers.push(await t.call(type, payload));
  });
  const [answer] = answers;
  if (answer === undefined) throw new Error(`${type} gave no answer`);
  return answer;
}

/** The avatar's set once its write has settled (one `~ settle` in the transcript, however many the machine needs), read quietly, with its scenes. */
async function settledSet(t: Telling, avatarId: string): Promise<{ set: Record<string, unknown>; scenes: Rows }> {
  const readyOf = (answer: Answer): Record<string, unknown> | null => {
    const set = answer.ok ? record(answer.result.sceneSet) : null;
    return set !== null && set.status === "ready" ? set : null;
  };
  await t.settleUntil("scenes.get", { avatarId }, (answer) => readyOf(answer) !== null, "the scene set to finish its write");
  const set = readyOf(await quietly(t, "scenes.get", { avatarId }));
  if (set === null) throw new Error("the scene set is not ready after its settle");
  return { set, scenes: rowsOf(set.scenes) };
}

/** Starts a run quietly, answers its id. */
async function startedRun(t: Telling, type: "runs.start" | "runs.startFromScenes", payload: unknown): Promise<string> {
  const answer = await quietly(t, type, payload);
  if (!answer.ok) throw new Error(`${type} was refused: ${answer.error.code}`);
  const runId = answer.result.runId;
  if (typeof runId !== "string") throw new Error(`${type} named no run`);
  // The id is each engine's own: named by order of appearance, so a line that carries it reads the same in both.
  t.norm.register("run", runId);
  return runId;
}

interface RunEnd {
  /** The run job's end as a window resyncs from it: `done`, `failed` (with the error's code), or whatever else it says. */
  job: string;
  failedSlots: number | null;
  reasons: string[];
  done: number;
  failed: number;
  open: number;
  resumable: boolean;
  spent: "none" | "some";
  photos: Rows;
}

/** What a run ended with, read quietly from the snapshot, the run list and the gallery. */
async function endOfRun(t: Telling, w: World, runId: string): Promise<RunEnd> {
  const snapshot = await quietly(t, "engine.snapshot", {});
  const job = snapshot.ok ? rowsOf(snapshot.result.jobs).find((j) => j.kind === "run" && j.runId === runId) : undefined;
  if (job === undefined) throw new Error("the snapshot holds no job of the run");
  const result = record(job.result);
  const error = record(job.error);
  const listed = await quietly(t, "runs.list", {});
  const run = listed.ok ? rowsOf(listed.result.runs).find((r) => r.runId === runId) : undefined;
  if (run === undefined) throw new Error("the run list does not name the run");
  const gallery = await quietly(t, "photos.list", { avatarId: w.avatarId });
  const photos = gallery.ok ? rowsOf(gallery.result.photos).filter((p) => p.runId === runId) : [];
  const reasons = rowsOf(result?.failedReasons).map((r) => String(r.reason));
  return {
    job: error === null ? String(job.status) : `${String(job.status)} ${String(error.code)}`,
    failedSlots: typeof result?.failedSlots === "number" ? result.failedSlots : null,
    reasons,
    done: Number(run.done),
    failed: Number(run.failed),
    open: Number(run.open),
    resumable: run.resumable === true,
    spent: Number(run.committedMicros) === 0 ? "none" : "some",
    photos,
  };
}

const countsOf = (reasons: readonly string[]): string => {
  const counts = new Map<string, number>();
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([reason, n]) => `${reason} x${n}`).join(", ") || "none";
};

/** The notes every run story tells of a run's end: the job, the slots, the reasons, the money, the photos. */
function tellEnd(t: Telling, end: RunEnd): void {
  t.note(`the job ended ${end.job}; ${end.photos.length} photos, ${end.failed} slots ended without one, ${end.open} still open, resumable: ${String(end.resumable)}`);
  t.note(`the slots that ended with a reason: ${countsOf(end.reasons)}`);
  t.note(`the run spent: ${end.spent}`);
  t.note(`photos that carry the Seedream route: ${end.photos.filter((p) => p.route === "seedream").length}`);
}

const bold = (w: World, count: number, categories: string[]) => ({ avatarId: w.avatarId, count, categories, level: "bold", acceptedWorstMicros: ENOUGH });

/** The sentence a scene would carry for its coverage, from the bank (the moment's, else the outfit's), or undefined when the scene has none. */
function coverageOfScene(scene: Record<string, unknown>): string | undefined {
  const category = String(scene.category);
  if (category !== "nightwear" && category !== "beach") return undefined;
  const bank = BANKS[category satisfies BankCategory];
  const place = record(scene.place);
  const moment = bank.places.find((p) => p.name === place?.location)?.moments.find((m) => m.text === place?.activity);
  const outfit = bank.outfits.find((o) => o.text === place?.outfit);
  return moment === undefined || outfit === undefined ? undefined : coverageOf(moment, outfit);
}

export const BOLD_SCENARIOS: readonly Scenario[] = [
  {
    name: "photo runs, «Смелая» (S5.9f): a run from the composed set draws every scene — the photos of the Seedream scenes carry the route and the others none — and spends",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("a bold compose of 20 scenes over «Ночнушки и бельё» and «Пляж и бассейн», 10 each, exactly as the compose story tells it");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 20, categories: ["nightwear", "beach"], level: "bold", acceptedWorstMicros: ENOUGH });
      const { set, scenes } = await settledSet(t, w.avatarId);
      const routed = (category: string): number => scenes.filter((s) => s.category === category && s.route === "seedream").length;
      t.note("the set is drawn as a run, at the worst case the estimate named");
      const runId = await startedRun(t, "runs.startFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision, acceptedWorstMicros: ENOUGH });
      await t.untilRunEnds(runId);
      const end = await endOfRun(t, w, runId);
      t.note(`the run drew a photo for every scene: ${String(end.photos.length === scenes.length)}`);
      const beach = end.photos.filter((p) => p.category === "beach");
      const nightwear = end.photos.filter((p) => p.category === "nightwear");
      t.note(`every beach photo carries the route: ${String(beach.length > 0 && beach.every((p) => p.route === "seedream"))}`);
      t.note(`the nightwear photos that carry it are as many as the nightwear scenes on it: ${String(nightwear.filter((p) => p.route === "seedream").length === routed("nightwear"))}`);
      t.note(`some nightwear scenes are on the route and some are not: ${String(routed("nightwear") > 0 && routed("nightwear") < nightwear.length)}`);
      tellEnd(t, end);
      const gallery = await quietly(t, "photos.list", { avatarId: w.avatarId });
      const held = gallery.ok ? rowsOf(gallery.result.photos).filter((p) => p.runId !== runId) : [];
      t.note(`the library held ${held.length > 0 ? "photos before the run" : "no photo before the run"}, and none of them carries a route: ${String(held.every((p) => !("route" in p)))}`);
    },
  },
  {
    name: "photo runs, «Смелая» (S5.9f): Seedream's refusal ends only the slot it met, for nothing, and is final — a run refused whole spends nothing and has nothing left to resume",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("three beach photos, every one on Seedream, and the model refuses all three");
      control.launch.refuseSeedream(3);
      const whole = await startedRun(t, "runs.start", bold(w, 3, ["beach"]));
      await t.untilRunEnds(whole);
      const refused = await endOfRun(t, w, whole);
      tellEnd(t, refused);
      t.note("three more, and the model refuses one: the other two are drawn, and the run goes on");
      control.launch.refuseSeedream(1);
      const partial = await startedRun(t, "runs.start", bold(w, 3, ["beach"]));
      await t.untilRunEnds(partial);
      const one = await endOfRun(t, w, partial);
      tellEnd(t, one);
      // 5a.4 (S5.BA2, 2026-10-26, plan s5a4 §7.4 #4, Q-A2): nightwear is always underwear on Seedream now, so no nightwear slot is on the owner's model; the sub-check that a slot on the
      // owner's model never meets a refusal is told on a «Кокетливая» «Дом» run instead, with the refusal knob still on.
      t.note("at «Смелая» nightwear has no slot on the owner's model: 10 of 10 refused, for nothing");
      control.launch.refuseSeedream(100);
      const nightwear = await startedRun(t, "runs.start", bold(w, 10, ["nightwear"]));
      await t.untilRunEnds(nightwear);
      const allRefused = await endOfRun(t, w, nightwear);
      t.note(`every slot was refused: ${String(allRefused.photos.length === 0 && allRefused.failed === 10)}, the refused slots all say so: ${countsOf(allRefused.reasons) === "model-refused x10" ? "model-refused" : countsOf(allRefused.reasons)}, and the run spent: ${allRefused.spent}`);
      t.note("a slot on the owner's model never meets a refusal: a «Кокетливая» «Дом» run with the knob still on draws every slot");
      const flirty = await startedRun(t, "runs.start", { avatarId: w.avatarId, count: 5, categories: ["home"], level: "flirty", acceptedWorstMicros: ENOUGH });
      await t.untilRunEnds(flirty);
      const drawn = await endOfRun(t, w, flirty);
      t.note(`every slot was drawn: ${String(drawn.photos.length === 5 && drawn.failed === 0)}, and none of them carries the route: ${String(drawn.photos.every((p) => !("route" in p)))}`);
    },
  },
  {
    name: "photo runs, «Смелая» (S5.9f): a Seedream answer with no image ends its slot settled and the run goes on; a second one in the run stops it, with both slots ended",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("one beach photo, and the model answers 2xx with no image: the slot ends model-empty and was paid for");
      control.launch.emptySeedream(1);
      const single = await startedRun(t, "runs.start", bold(w, 1, ["beach"]));
      await t.untilRunEnds(single);
      tellEnd(t, await endOfRun(t, w, single));
      t.note("two beach photos, and the model answers empty to one: the other is drawn");
      control.launch.emptySeedream(1);
      const pair = await startedRun(t, "runs.start", bold(w, 2, ["beach"]));
      await t.untilRunEnds(pair);
      tellEnd(t, await endOfRun(t, w, pair));
      t.note("two beach photos, and the model answers empty to both: the second stops the run, and both slots are ended and paid for");
      control.launch.emptySeedream(2);
      const both = await startedRun(t, "runs.start", bold(w, 2, ["beach"]));
      await t.untilRunEnds(both);
      const stopped = await endOfRun(t, w, both);
      t.note(`the job ended ${stopped.job}; ${stopped.photos.length} photos, ${stopped.failed} slots ended, ${stopped.open} still open, resumable: ${String(stopped.resumable)}, the run spent: ${stopped.spent}`);
    },
  },
  {
    name: "autopilot, «Смелая» (S5.9f): a launch at the bold level prices every photo at the bold unit, draws on the route, and ends done within the figure it was accepted at",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const draft = { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["nightwear"], level: "bold", poses: { profile: false, back: false }, library: false, generate: true, sceneReview: false, stickers: false, planSeed: 4_242 };
      t.note("the plan of ten new «Смелая» photos: the worst case is each photo's three attempts at the bold unit, and the expected cost is one attempt each");
      const estimate = await quietly(t, "autopilot.estimate", { draft });
      const preview = estimate.ok ? record(estimate.result.preview) : null;
      const totals = record(preview?.totals);
      const money = record(preview?.estimate);
      const photos = Number(totals?.toGenerate);
      t.note(`photos to draw: ${photos}; worst case: ${String(money?.worstMicros === photos * ATTEMPTS_PER_PHOTO * BOLD_ATTEMPT_MICROS)} (photos x 3 x ${BOLD_ATTEMPT_MICROS}); expected: ${String(money?.expectedMicros === photos * BOLD_ATTEMPT_MICROS)} (photos x ${BOLD_ATTEMPT_MICROS})`);
      t.note("the same photos in an ordinary launch are priced at the owner's model, below the bold unit");
      const { level: _level, ...ordinary } = draft;
      const plain = await quietly(t, "autopilot.estimate", { draft: { ...ordinary, categories: ["home"] } });
      const plainMoney = record(record(plain.ok ? plain.result.preview : null)?.estimate);
      t.note(`the ordinary worst case is below the bold one: ${String(Number(plainMoney?.worstMicros) < Number(money?.worstMicros))}`);
      const { launch } = await begin(t, w, { categories: ["nightwear"], level: "bold" });
      await t.untilLaunch(launch, "done", isDone);
      const got = await quietly(t, "autopilot.get", { launchId: launch });
      const view = record(got.ok ? got.result.launch : null);
      t.note(`the launch spent within the figure it was accepted at: ${String(Number(view?.spentMicros) <= Number(view?.acceptedMicros))}, and spent: ${Number(view?.spentMicros) > 0 ? "some" : "none"}`);
      const gallery = await quietly(t, "photos.list", { avatarId: w.avatarId });
      const drawn = gallery.ok ? rowsOf(gallery.result.photos).filter((p) => p.category === "nightwear") : [];
      t.note(`the launch drew ${drawn.length} photos; some carry the route and some do not: ${String(drawn.some((p) => p.route === "seedream") && drawn.some((p) => !("route" in p)))}`);
    },
  },
  {
    name: "scene sets, «Смелая» coverage (S5.9f): in a bold compose of «Ночнушки и бельё» and «Пляж и бассейн» every scene on the Seedream route carries its coverage sentence and no other scene carries one",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("a bold compose of 20 scenes over the two «Смелая» categories");
      await t.callLaunch("scenes.compose", { avatarId: w.avatarId, count: 20, categories: ["nightwear", "beach"], level: "bold", acceptedWorstMicros: ENOUGH });
      const { scenes } = await settledSet(t, w.avatarId);
      const routed = scenes.filter((s) => s.route === "seedream");
      const others = scenes.filter((s) => s.route !== "seedream");
      const carries = (scene: Record<string, unknown>): boolean => {
        const sentence = coverageOfScene(scene);
        return sentence !== undefined && typeof scene.text === "string" && scene.text.endsWith(sentence);
      };
      t.note(`some scenes are on the route and some are not: ${String(routed.length > 0 && others.length > 0)}`);
      t.note(`every scene on the route has a coverage sentence, and its sentence ends with it: ${String(routed.every(carries))}`);
      t.note(`no scene off the route has a coverage sentence to carry: ${String(others.every((s) => coverageOfScene(s) === undefined))}`);
    },
  },
];
