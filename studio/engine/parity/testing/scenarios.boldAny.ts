import { bankPlaceOf } from "../../../shared/scenes/bankLookup";
import { BANKS } from "../../../shared/scenes/banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../../shared/scenes/banks/companions";
import type { BankCategory, CategoryBank } from "../../../shared/scenes/banks/types";
import { isWaterPlaceName } from "../../../shared/scenes/custom";
import { plainSentence } from "../../../shared/scenes/plain";
import { slotCoverageOf } from "../../../shared/scenes/template";
import { ENOUGH, begin, isDone, record, type Telling } from "./scenarios.autopilotRun";
import type { Scenario } from "./scenarios";
import { PARITY_BOLD_CATEGORY, PARITY_PRE_BOLD_SET_ID, type World } from "./rigs";
import type { Answer } from "./transcript";

// Stage 5, 5a.4, S5.BA7 (APPENDED; the golden is append-only, plan s5a4 §5.11, §7.4): «Смелая» on every category, told against both engines. The five draw from their companions, a custom
// category from the two shared custom banks inside its own world, the tiers are counted over the whole request, an imported avatar (Mia, whose master has no wizard slot) never draws an implied
// cover and always says the kept coverage, a Studio-created one (the `studioAvatar` rig option) may draw one and says its open coverage where the probe proved it, a launch at «Смелая» prices
// every photo at the 2K unit and takes only «Смелая» photos from the library, a clip of a «Смелая» frame of the five is Kling's alone, and a set stored before 5a.4 keeps reading as it did.
//
// What is compared is what both engines are bound to say, as notes read from quiet answers: counts by tier and by branch, routes, origins, whether a sentence ends with its coverage, prices as
// facts against the 2K unit. Never which moment or which world a scene drew (each engine deals its own), never a price the mock keeps flat, never an id.

const BOLD_ATTEMPT_MICROS = 93_000;
const ATTEMPTS_PER_PHOTO = 3;
const NOTHING = 0;
const FIVE = ["home", "travel", "shoot", "glam", "fit"] as const;
const SEVEN = [...FIVE, "nightwear", "beach"] as const;
/** The contract's built-in refs by the banks' names. */
const BANK_OF: Readonly<Record<string, BankCategory>> = { home: "home", travel: "travel", shoot: "photoshoot", glam: "glamour", fit: "fitness", nightwear: "nightwear", beach: "beach" };

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

/** The avatar's set once its write has settled, read quietly, with its scenes. */
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

async function discard(t: Telling, set: Record<string, unknown>): Promise<void> {
  const sceneSetId = set.sceneSetId;
  if (typeof sceneSetId !== "string") throw new Error("the set has no id to discard");
  await t.callLaunch("scenes.discard", { sceneSetId });
}

const levelOf = (scene: Record<string, unknown>): string => (typeof scene.level === "string" ? scene.level : "ordinary");

/** «home: 10 scenes, 4 bold, 4 flirty, 2 ordinary». */
function tiers(scenes: Rows, label: string): string {
  return `${label}: ${scenes.length} scenes, ${scenes.filter((s) => levelOf(s) === "bold").length} bold, ${scenes.filter((s) => levelOf(s) === "flirty").length} flirty, ${scenes.filter((s) => levelOf(s) === "ordinary").length} ordinary`;
}

/** A scene as the bank lookup and the coverage read it: a built-in by its bank's name, a custom category by its id. */
function slotOf(scene: Record<string, unknown>): { category: string; route: "seedream" | undefined; location: string; activity: string; outfit: string } {
  const place = record(scene.place);
  const category = String(scene.category);
  return { category: BANK_OF[category] ?? category, route: scene.route === "seedream" ? "seedream" : undefined, location: String(place?.location), activity: String(place?.activity), outfit: String(place?.outfit) };
}

/** Whether the scene drew an implied cover: its moment, or its outfit, is `tier: "implied"`. */
function drewImplied(scene: Record<string, unknown>): boolean {
  const slot = slotOf(scene);
  const hit = bankPlaceOf(slot);
  return hit?.moment?.tier === "implied" || hit?.bank.outfits.find((o) => o.text === slot.outfit)?.tier === "implied";
}

/**
 * Whether a scene's text ends with the coverage of the avatar's origin and never the other's: where the two origins' sentences differ it says its own (none, for a Studio-created avatar whose
 * class the probe drew open), and where they agree there is nothing more to tell than that it says it.
 */
function endsByOrigin(scene: Record<string, unknown>, studio: boolean): boolean {
  const slot = slotOf(scene);
  const text = typeof scene.text === "string" ? scene.text : "";
  const mine = slotCoverageOf(slot, studio);
  const other = slotCoverageOf(slot, !studio);
  if (mine === other) return mine === undefined || text.endsWith(mine);
  return mine === undefined ? other === undefined || !text.endsWith(other) : text.endsWith(mine);
}

/** Every coverage sentence the «Смелая» banks can end a sentence with, kept or open. */
const COVERAGES: readonly string[] = [...new Set(
  [...Object.values(BANKS), ...Object.values(BOLD_COMPANIONS), CUSTOM_BOLD_BANKS.rooms, CUSTOM_BOLD_BANKS.water].flatMap((bank: CategoryBank) => [
    ...bank.outfits.flatMap((o) => [o.coverage, o.openCoverage]),
    ...bank.places.flatMap((p) => p.moments.flatMap((m) => [m.coverage, m.openCoverage])),
  ]),
)].filter((sentence): sentence is string => sentence !== undefined);

const endsWithAnyCoverage = (scene: Record<string, unknown>): boolean => typeof scene.text === "string" && COVERAGES.some((sentence) => (scene.text as string).endsWith(sentence));

const studioOf = (w: World): string => {
  if (w.studioAvatarId === undefined) throw new Error("the story needs `rig: { studioAvatar: true }`");
  return w.studioAvatarId;
};

const bold = (w: World, count: number, categories: readonly string[], avatarId = w.avatarId) => ({ avatarId, count, categories: [...categories], level: "bold", acceptedWorstMicros: ENOUGH });

export const BOLD_ANY_SCENARIOS: readonly Scenario[] = [
  {
    name: "scene sets, «Смелая» everywhere (S5.BA7, story 1): a bold compose of the five, 10 each, holds 4 / 4 / 2 in each, every scene on the route, and a run from it is priced at the 2K unit",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("a bold compose of 50 scenes over the five: the tiers are counted over the request (20 / 20 / 10), so each category holds 4 bold, 4 flirty and 2 ordinary");
      await t.callLaunch("scenes.compose", bold(w, 50, FIVE));
      const { set, scenes } = await settledSet(t, w.avatarId);
      for (const ref of FIVE) t.note(tiers(scenes.filter((s) => s.category === ref), ref));
      t.note(`every scene is on the Seedream route: ${String(scenes.every((s) => s.route === "seedream"))}`);
      t.note(`every scene is written: ${String(scenes.every((s) => typeof s.text === "string"))}`);
      t.note(`every scene is a moment of its category's companion: ${String(scenes.every((s) => bankPlaceOf(slotOf(s))?.bank === BOLD_COMPANIONS[BANK_OF[String(s.category)] as keyof typeof BOLD_COMPANIONS]))}`);
      const estimate = await quietly(t, "runs.estimateFromScenes", { sceneSetId: set.sceneSetId, revision: set.revision });
      const money = estimate.ok ? record(estimate.result.estimate) : null;
      t.note(`a run from the set: the 2K attempt is ${String(money?.boldAttemptMicros)}; worst is 50 photos x 3 x ${BOLD_ATTEMPT_MICROS}: ${String(money?.worstMicros === 50 * ATTEMPTS_PER_PHOTO * BOLD_ATTEMPT_MICROS)}; expected 50 x ${BOLD_ATTEMPT_MICROS}: ${String(money?.expectedMicros === 50 * BOLD_ATTEMPT_MICROS)}`);
    },
  },
  {
    name: "scene sets, «Смелая» everywhere (S5.BA7, story 2): a custom category with water places splits its scenes by the water, each scene the writer's on the route inside a world of its own places",
    rig: { launch: true, boldCustom: true },
    async run(t, w, control) {
      await control.musicTracks();
      const worlds = PARITY_BOLD_CATEGORY.pool.locations.map((l) => l.name);
      const water = worlds.filter(isWaterPlaceName);
      t.note(`the category has ${worlds.length} places, ${water.length} of them by the water: of 10 scenes ⌊(10 x ${water.length} + ⌊${worlds.length} / 2⌋) / ${worlds.length}⌋ are by the water`);
      await t.callLaunch("scenes.compose", bold(w, 10, [PARITY_BOLD_CATEGORY.categoryId]));
      const { set, scenes } = await settledSet(t, w.avatarId);
      const wet = scenes.filter((s) => CUSTOM_BOLD_BANKS.water.places.some((p) => p.name === record(s.place)?.location));
      t.note(tiers(scenes, "the category"));
      t.note(`by the water: ${wet.length}; in a room of hers: ${scenes.filter((s) => CUSTOM_BOLD_BANKS.rooms.places.some((p) => p.name === record(s.place)?.location)).length}`);
      t.note(`every scene is on the Seedream route: ${String(scenes.every((s) => s.route === "seedream"))}`);
      t.note(`every scene's world is one of the category's places: ${String(scenes.every((s) => worlds.includes(String(record(s.place)?.world))))}; every scene by the water has a water place: ${String(wet.every((s) => water.includes(String(record(s.place)?.world))))}`);
      t.note(`every scene by the water wears swimwear of the water bank: ${String(wet.every((s) => CUSTOM_BOLD_BANKS.water.outfits.some((o) => o.text === record(s.place)?.outfit)))}`);
      // The plain sentence the engine falls back to after two refused answers: a scene that says it was never the writer's.
      const plain = (s: Record<string, unknown>): string => {
        const shot = s.shot === "friend" || s.shot === "selfie" || s.shot === "mirror" || s.shot === "candid" || s.shot === "photographer" ? s.shot : undefined;
        const pose = s.pose === "front" || s.pose === "three-quarter" || s.pose === "profile" || s.pose === "back" ? s.pose : undefined;
        const level = s.level === "flirty" || s.level === "bold" ? s.level : undefined;
        return plainSentence({ ...slotOf(s), shot, pose, level }, false);
      };
      t.note(`every scene is written by the writer, not the plain sentence: ${String(scenes.every((s) => typeof s.text === "string" && s.text !== plain(s)))}`);
      t.note(`every scene ends with its kept coverage (Mia reads as imported): ${String(scenes.every((s) => endsByOrigin(s, false)))}`);
      t.note(`the set spent: ${Number(set.spentMicros) > 0 ? "some" : "none"}`);
    },
  },
  {
    name: "scene sets, «Смелая» everywhere (S5.BA7, story 3): Mia, read as imported, at «Смелая» over the seven, 10 each, draws no implied cover and every scene says its kept coverage",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("a bold compose of 70 scenes over the seven categories for Mia, whose master has no wizard slot: an imported avatar for both engines");
      await t.callLaunch("scenes.compose", bold(w, 70, SEVEN));
      const { scenes } = await settledSet(t, w.avatarId);
      for (const ref of SEVEN) t.note(tiers(scenes.filter((s) => s.category === ref), ref));
      t.note(`every scene is on the Seedream route: ${String(scenes.every((s) => s.route === "seedream"))}`);
      t.note(`scenes that draw an implied cover (the sheet, the towel, the foam, the bare back): ${scenes.filter(drewImplied).length}`);
      t.note(`every scene ends with its kept coverage, never the open one: ${String(scenes.every((s) => endsByOrigin(s, false)))}`);
    },
  },
  {
    name: "autopilot, «Смелая» everywhere (S5.BA7, story 4): a launch at «Смелая» with only the five prices every photo at the 2K unit (option B) and draws them on the route",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      const draft = { avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: [...FIVE], level: "bold", poses: { profile: false, back: false }, library: false, generate: true, sceneReview: false, stickers: false, planSeed: 4_242 };
      const estimate = await quietly(t, "autopilot.estimate", { draft });
      const preview = estimate.ok ? record(estimate.result.preview) : null;
      const photos = Number(record(preview?.totals)?.toGenerate);
      const money = record(preview?.estimate);
      t.note(`photos to draw: ${photos}; worst is each photo's three attempts at the 2K unit: ${String(money?.worstMicros === photos * ATTEMPTS_PER_PHOTO * BOLD_ATTEMPT_MICROS)}; expected one attempt each: ${String(money?.expectedMicros === photos * BOLD_ATTEMPT_MICROS)}`);
      const before = await quietly(t, "photos.list", { avatarId: w.avatarId });
      const held = new Set((before.ok ? rowsOf(before.result.photos) : []).map((p) => p.photoId));
      const { launch } = await begin(t, w, { categories: [...FIVE], level: "bold" });
      await t.untilLaunch(launch, "done", isDone);
      const got = await quietly(t, "autopilot.get", { launchId: launch });
      const view = record(got.ok ? got.result.launch : null);
      t.note(`the launch spent within the figure it was accepted at: ${String(Number(view?.spentMicros) <= Number(view?.acceptedMicros))}`);
      const gallery = await quietly(t, "photos.list", { avatarId: w.avatarId });
      const drawn = gallery.ok ? rowsOf(gallery.result.photos).filter((p) => !held.has(p.photoId)) : [];
      t.note(`the launch drew ${drawn.length} photos, every one on the Seedream route: ${String(drawn.length > 0 && drawn.every((p) => p.route === "seedream"))}`);
    },
  },
  {
    name: "clips, «Смелая» everywhere (S5.BA7, story 5): a clip of a «Смелая» «Дом» photo is Kling's alone, with no fallback, as a «Дом» photo off the route is not",
    rig: { clips: { boldHome: true } },
    async run(t, world, control) {
      const w = world.clipWorld;
      if (w?.boldHome === undefined) throw new Error("the story needs `rig: { clips: { boldHome: true } }`");
      t.note("a «Дом» frame drawn on the Seedream route: the worst is Kling's alone (the fallback is none)");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.boldHome });
      t.note("an ordinary «Дом» frame, for the contrast: Grok may stand behind Kling");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      t.note("a clip of the «Смелая» frame at Kling's figure alone is made");
      const made = await t.call("clips.create", { avatarId: w.avatarId, photoId: w.boldHome, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "none", acceptedWorstMicros: 504_000 });
      const jobId = made.ok ? made.result.jobId : undefined;
      if (typeof jobId !== "string") throw new Error("the clip was not made");
      await t.untilJobEnds(jobId);
      t.note(`the POSTs that left: ${control.clips.posts().join(", ") || "none"}`);
    },
  },
  {
    name: "scene sets, «Смелая» everywhere (S5.BA7, story 6): in a «Смелая» set stored before 5a.4 «Другая сцена» on a «Дом» scene keeps the ordinary bank and its flirty level, off the route",
    rig: { launch: true, preBoldSet: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("Mia's set stored before 5a.4: «Дом» drawn as «Кокетливая» with no route, nightwear on the route; «Дописать» writes it with the template, for nothing");
      const before = await quietly(t, "scenes.get", { avatarId: w.avatarId });
      const stored = before.ok ? record(before.result.sceneSet) : null;
      const written = { sceneSetId: PARITY_PRE_BOLD_SET_ID, revision: stored?.revision, target: { kind: "unwritten" }, acceptedWorstMicros: NOTHING };
      await t.callLaunch("scenes.write", written, { written: { ...written, revision: "<seen>" } });
      const first = await settledSet(t, w.avatarId);
      const target = first.scenes.find((s) => s.category === "home" && levelOf(s) === "flirty");
      if (target === undefined) throw new Error("the set holds no flirty «Дом» scene");
      t.note("«Другая сцена» on its first flirty «Дом» scene, with a worst case of nothing: the template writes it");
      const sent = { sceneSetId: first.set.sceneSetId, revision: first.set.revision, target: { kind: "rewrite", sceneIds: [target.sceneId], redraw: true }, acceptedWorstMicros: NOTHING };
      await t.callLaunch("scenes.write", sent, { written: { ...sent, revision: "<seen>" } });
      const second = await settledSet(t, w.avatarId);
      const redrawn = second.scenes.find((s) => s.sceneId === target.sceneId);
      const place = record(redrawn?.place);
      t.note(`the scene keeps its level: ${redrawn === undefined ? "gone" : levelOf(redrawn)}; it has no route: ${String(redrawn !== undefined && !("route" in redrawn))}`);
      t.note(`its new place is one of the ordinary «Дом» bank's, with one of its moments: ${String(BANKS.home.places.some((p) => p.name === place?.location && p.moments.some((m) => m.text === place?.activity)))}`);
      t.note(`the set's other scenes kept their routes: ${String(second.scenes.filter((s) => s.sceneId !== target.sceneId).every((s) => (s.route === "seedream") === (first.scenes.find((f) => f.sceneId === s.sceneId)?.route === "seedream")))}`);
    },
  },
  {
    name: "scene sets, «Смелая» everywhere (S5.BA7, story 7): a Studio-created avatar at «Смелая» may draw an implied cover and says its open coverage where the probe proved it; Mia, imported, does neither",
    rig: { launch: true, studioAvatar: true },
    async run(t, w, control) {
      await control.musicTracks();
      const studio = studioOf(w);
      t.note("a bold compose of 100 scenes over «Дом» and «Ночнушки и бельё», 50 each, for the avatar made in Studio");
      await t.callLaunch("scenes.compose", bold(w, 100, ["home", "nightwear"], studio));
      const iris = await settledSet(t, studio);
      t.note(`she draws implied covers: ${String(iris.scenes.some(drewImplied))}`);
      t.note(`every scene ends with a Studio-created avatar's coverage (the open one, or none where the probe drew it without one), never the kept one where they differ: ${String(iris.scenes.every((s) => endsByOrigin(s, true)))}`);
      t.note("the same compose for Mia, imported");
      await t.callLaunch("scenes.compose", bold(w, 100, ["home", "nightwear"]));
      const mia = await settledSet(t, w.avatarId);
      t.note(`scenes of Mia's that draw an implied cover: ${mia.scenes.filter(drewImplied).length}; every scene ends with its kept coverage: ${String(mia.scenes.every((s) => endsByOrigin(s, false)))}`);
      await discard(t, iris.set);
      await discard(t, mia.set);
    },
  },
  {
    name: "autopilot, «Смелая» everywhere (S5.BA7, story 8): at «Смелая» the library gives only «Смелая» photos; at «Кокетливая» it gives them all",
    rig: { launch: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("five «Дом» photos are drawn at «Смелая», on the route; the library held «Дом» photos off it before");
      const started = await quietly(t, "runs.start", { avatarId: w.avatarId, count: 5, categories: ["home"], level: "bold", poses: { profile: false, back: false }, acceptedWorstMicros: ENOUGH });
      const runId = started.ok ? started.result.runId : undefined;
      if (typeof runId !== "string") throw new Error("the run did not start");
      t.norm.register("run", runId);
      await t.untilRunEnds(runId);
      const gallery = await quietly(t, "photos.list", { avatarId: w.avatarId });
      const photos = gallery.ok ? rowsOf(gallery.result.photos).filter((p) => p.category === "home") : [];
      const routed = photos.filter((p) => p.route === "seedream").length;
      t.note(`«Дом» photos on the route: ${routed}; off it: ${photos.length - routed}`);
      const draft = (level: string) => ({ avatarIds: [w.avatarId], videosPerAvatar: 2, mix: { single: 0, collage: 0, slides: 100 }, categories: ["home"], level, poses: { profile: false, back: false }, library: true, generate: true, sceneReview: false, stickers: false, planSeed: 4_242 });
      const freeAt = async (level: "bold" | "flirty"): Promise<{ free: number; fromLibrary: number }> => {
        const answer = await quietly(t, "autopilot.estimate", { draft: draft(level) });
        const row = rowsOf(answer.ok ? record(answer.result.preview)?.avatars : [])[0];
        return { free: Number(row?.free), fromLibrary: Number(row?.fromLibrary) };
      };
      const atBold = await freeAt("bold");
      t.note(`at «Смелая» the library's free photos are the routed ones: ${String(atBold.free === routed)}; the plan takes from it no more than those: ${String(atBold.fromLibrary <= atBold.free)}`);
      const atFlirty = await freeAt("flirty");
      t.note(`at «Кокетливая» it gives the photos off the route too: ${String(atFlirty.free > routed)}; the plan takes from it no more than it gives: ${String(atFlirty.fromLibrary <= atFlirty.free)}`);
    },
  },
  {
    name: "scene sets, «Смелая» everywhere (S5.BA7, BA2 L4): in a «Смелая» set stored before 5a.4 every scene on the route ends with its coverage sentence and no other scene ends with one",
    rig: { launch: true, preBoldSet: true },
    async run(t, w, control) {
      await control.musicTracks();
      t.note("Mia's set stored before 5a.4, written by «Дописать»: «Дом» drawn as «Кокетливая» with no route, nightwear on the route");
      const before = await quietly(t, "scenes.get", { avatarId: w.avatarId });
      const stored = before.ok ? record(before.result.sceneSet) : null;
      const written = { sceneSetId: PARITY_PRE_BOLD_SET_ID, revision: stored?.revision, target: { kind: "unwritten" }, acceptedWorstMicros: NOTHING };
      await t.callLaunch("scenes.write", written, { written: { ...written, revision: "<seen>" } });
      const { scenes } = await settledSet(t, w.avatarId);
      const routed = scenes.filter((s) => s.route === "seedream");
      const others = scenes.filter((s) => s.route !== "seedream");
      t.note(`some scenes are on the route and some are not: ${String(routed.length > 0 && others.length > 0)}`);
      t.note(`every scene on the route ends with its kept coverage: ${String(routed.every((s) => slotCoverageOf(slotOf(s), false) !== undefined && endsByOrigin(s, false)))}`);
      t.note(`no other scene ends with a coverage sentence of any bank: ${String(others.every((s) => !endsWithAnyCoverage(s)))}`);
    },
  },
];
