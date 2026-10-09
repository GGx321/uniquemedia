import { allocateLaunch, launchEstimate, type LaunchEstimate, type LaunchUnitPrices } from "../../shared/autopilot/estimate";
import { hashText } from "../../shared/autopilot/hash";
import { monthFit, type MonthRoom } from "../../shared/autopilot/money";
import type { EngineError, ExportStatus, ImageAgeCheck } from "../../shared/engine";
import {
  LaunchDraft,
  type LaunchBlockerCode,
  type LaunchDraftInput,
  type LaunchPreview,
  type LaunchView,
} from "../../shared/engine/autopilot";
import { isCustomCategory, type CategoryPoses, type CategoryRef } from "../../shared/engine/categories";
import type { Montage } from "../../shared/engine/montage";
import { EngineFailure } from "../engineFailure";
import type { Library } from "../library";
import type { PriceModels, PricedBook } from "../money/priceCache";
import type { RunModels } from "../runs/plan";
import { scenePhotoIds } from "../videos/record";
import { launchPriceModels, unitPricesOf } from "./prices";
import { buildLaunchPreview } from "./preview";
import { planAvatarInput } from "./libraryInput";
import { planLaunch, type LaunchPlan } from "./planner";
import type { Orchestrator } from "./orchestrator";

// Stage 4 (plan §4.2, §4.3, §9): the engine's side of `autopilot.estimate` and `autopilot.start`. It reads the library into the planner's input, prices the plan with the engine's
// own estimates (`launchEstimate` over `unitPricesOf`), and answers the preview; the start does the same and then refuses in the order the contract lists, all BEFORE anything
// is written: the library, the avatars, a launch already unfinished, an unreadable entry, nothing enabled, a blocked avatar, the key and the ledger, the export folder, the
// price (PRICE_CHANGED) and the month (BUDGET_EXCEEDED). Only then does the orchestrator write the launch file.

export interface DraftListing {
  montages: readonly Montage[];
  skipped: number;
  notRead: number;
  truncated: boolean;
}

export interface AutopilotCommandsDeps {
  orchestrator: Orchestrator;
  /** The live library, confirmed (LIBRARY_UNAVAILABLE / IN_FLIGHT otherwise). */
  liveLibrary(): Promise<Library>;
  /** Throws NOT_FOUND unless the avatar is a saved, active one of the library. */
  runnableAvatar(library: Library, avatarId: string): void;
  models(): RunModels;
  imageAgeCheck(): ImageAgeCheck;
  prices(models: PriceModels): Promise<PricedBook>;
  /** The month's free room with live caps; null when the ledger cannot be read. */
  monthRoom(): MonthRoom | null;
  monthlyBudgetMicros(): number;
  /** Another job of the avatar's own holds it now. */
  isBusy(avatarId: string): boolean;
  listDrafts(library: Library, avatarId: string): Promise<DraftListing>;
  /** The engine's first checks before any paid call: the key, then the ledger. Null when both are open. */
  paidGate(): EngineError | null;
  exportStatus(): ExportStatus;
  musicKeyStored(): boolean;
  clock(): number;
  newId(): string;
}

interface Planned {
  draft: LaunchDraft;
  plan: LaunchPlan;
  unit: LaunchUnitPrices | null;
  estimate: LaunchEstimate;
}

/** The blocker a refused paid gate stands for in the preview. */
function gateBlocker(error: EngineError): LaunchBlockerCode {
  if (error.code === "RECONCILE_REQUIRED") return "reconcile-required";
  if (error.code === "SETTLE_ABOVE_WORST" || error.code === "LEDGER_WRITE_FAILED") return "halt";
  if (error.code === "LEDGER_CORRUPT" || error.code === "LEDGER_UNREADABLE") return "ledger";
  return "no-key";
}

export class AutopilotCommands {
  readonly #d: AutopilotCommandsDeps;

  constructor(deps: AutopilotCommandsDeps) {
    this.#d = deps;
  }

  async estimate(input: LaunchDraftInput): Promise<LaunchPreview> {
    const library = await this.#d.liveLibrary();
    const planned = await this.#plan(library, this.#withSeed(input));
    const blockers = await this.#launchBlockers(planned);
    const room = this.#d.monthRoom();
    const budgetMicros = this.#d.monthlyBudgetMicros();
    return buildLaunchPreview({
      draft: planned.draft,
      plan: planned.plan,
      estimate: planned.estimate,
      unit: planned.unit,
      month: room ?? { budgetMicros, committedMicros: budgetMicros, freeMicros: 0 },
      busy: new Set(planned.draft.avatarIds.filter((id) => this.#d.isBusy(id))),
      launchBlockers: blockers,
      // The music card and the balance are filled by the tasks that own them (S4.5d, S4.5e, S4.6c2): until then nothing is claimed that is not known.
      music: { candidates: 0, ownFlagged: 0, explicitSkipped: 0, autoRefresh: this.#d.musicKeyStored() ? "not-needed" : "no-key", quotaRemaining: null },
      balance: null,
      freeBytes: null,
    });
  }

  async start(input: { draft: LaunchDraft; acceptedWorstMicros: number }): Promise<LaunchView> {
    const library = await this.#d.liveLibrary();
    const planned = await this.#plan(library, input.draft);
    const { plan, estimate } = planned;
    const reason = (launchReason: "open-set" | "too-many-photos" | "usage-unknown" | "launch-unreadable" | "nothing-enabled", detail: string): EngineFailure =>
      new EngineFailure({ code: "VALIDATION", launchReason, detail });
    const blockers = await this.#d.orchestrator.startBlockers();
    if (blockers.active) throw new EngineFailure({ code: "IN_FLIGHT", detail: "a launch is already unfinished in this library; stop it or wait for it to end" });
    if (blockers.unreadable) throw reason("launch-unreadable", "a launch file cannot be read; remove the entry first");
    if (!planned.draft.library && !planned.draft.generate) throw reason("nothing-enabled", "both the library and the generation are off");
    for (const avatar of plan.avatars) {
      if (avatar.blocked !== null) throw reason(avatar.blocked, `avatar ${avatar.avatarId} cannot be planned: ${avatar.blocked}`);
    }
    if (plan.totals.toGenerate > 0) {
      const gate = this.#d.paidGate();
      if (gate !== null) throw new EngineFailure(gate);
    }
    const status = this.#d.exportStatus();
    if (plan.totals.videos > 0 && status.status === "unavailable") {
      throw new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: status.reason, detail: `the export folder cannot take a video (${status.reason})` });
    }
    const allocation = allocateLaunch(estimate, input.acceptedWorstMicros);
    if (!allocation.ok) {
      throw new EngineFailure({ code: "PRICE_CHANGED", detail: `the launch's worst case is now ${allocation.plannedWorstMicros} µ$, above the accepted ${allocation.acceptedMicros} µ$` });
    }
    const room = this.#d.monthRoom();
    const budgetMicros = this.#d.monthlyBudgetMicros();
    const free = room?.freeMicros ?? 0;
    if (monthFit(free, estimate.expectedMicros, estimate.worstMicros) === "short") {
      throw new EngineFailure({ code: "BUDGET_EXCEEDED", detail: `the month has ${free} µ$ of room, the launch's expected cost is ${estimate.expectedMicros} µ$ (budget ${budgetMicros} µ$)` });
    }
    return this.#d.orchestrator.start({ draft: planned.draft, acceptedMicros: input.acceptedWorstMicros, plan, estimate, allocations: allocation.avatars }, library);
  }

  // ---------- the plan ----------

  /** The seed is the owner's when the draft has one (a refresh keeps its videos), else drawn here: `hashText` of the clock and a fresh id. */
  #withSeed(input: LaunchDraftInput): LaunchDraft {
    const planSeed = input.planSeed ?? hashText(this.#d.clock() % 4_294_967_296, this.#d.newId());
    return LaunchDraft.parse({ ...input, planSeed });
  }

  async #plan(library: Library, draft: LaunchDraft): Promise<Planned> {
    for (const avatarId of draft.avatarIds) this.#runnable(library, avatarId);
    const avatars = [];
    for (const avatarId of draft.avatarIds) avatars.push(planAvatarInput(library, avatarId, await this.#hasOpenSet(library, avatarId)));
    const plan = planLaunch({ draft, avatars, draftHeldPhotoIds: await this.#heldByDrafts(library, draft.avatarIds), customPoses: await this.#customPoses(library, draft.categories) });
    const needs = plan.avatars.filter((a) => a.blocked === null).map((a) => ({ avatarId: a.avatarId, photos: a.toGenerate }));
    const generates = needs.some((n) => n.photos > 0);
    // A plan that generates nothing (Σn = 0, a library-only launch) needs no price and asks for none (§19): `unitPricesOf` wants the text model's price, which such a launch has
    // no use for, and a price list that cannot be read must not refuse a launch that spends nothing. Its estimate is zero.
    let unit: LaunchUnitPrices | null = null;
    if (generates) unit = await this.#unitPrices();
    const estimate = unit === null ? { avatars: [], worstMicros: 0, expectedMicros: 0, prices: "fallback" as const, pricesAsOf: new Date(this.#d.clock()).toISOString().slice(0, 10) } : launchEstimate(needs, unit);
    return { draft, plan, unit, estimate };
  }

  /** The launch's own wording for an avatar that is not a saved, active one (the mock's, so the two engines answer alike); other refusals pass through. */
  #runnable(library: Library, avatarId: string): void {
    try {
      this.#d.runnableAvatar(library, avatarId);
    } catch (error) {
      if (error instanceof EngineFailure && error.error.code === "NOT_FOUND") throw new EngineFailure({ code: "NOT_FOUND", detail: `avatar ${avatarId} is not a saved, active avatar` });
      throw error;
    }
  }

  async #unitPrices(): Promise<LaunchUnitPrices> {
    const models = this.#d.models();
    const check = this.#d.imageAgeCheck();
    return unitPricesOf(await this.#d.prices(launchPriceModels(models, check)), models, check);
  }

  /** An avatar has an open scene set when one of its sets has no run folder yet. A set that cannot be read may be that set, so it counts (fail closed). */
  async #hasOpenSet(library: Library, avatarId: string): Promise<boolean> {
    try {
      for (const set of await library.sceneSets.listForWrite(avatarId)) if (!(await library.runFolderExists(set.runId))) return true;
      return false;
    } catch {
      return true;
    }
  }

  /**
   * The photos any saved montage draft holds (§19: `{ photoIds, complete }`). A listing that is not complete cannot say which photos are held, so it fails closed: every photo
   * of the chosen avatars counts as held and none is taken from the library.
   */
  async #heldByDrafts(library: Library, avatarIds: readonly string[]): Promise<ReadonlySet<string>> {
    const held = new Set<string>();
    let complete = true;
    for (const avatarId of avatarIds) {
      try {
        const listing = await this.#d.listDrafts(library, avatarId);
        for (const montage of listing.montages) for (const photoId of scenePhotoIds(montage.spec.clips)) held.add(photoId);
        if (listing.skipped > 0 || listing.notRead > 0 || listing.truncated) complete = false;
      } catch {
        complete = false;
      }
    }
    if (complete) return held;
    for (const avatarId of avatarIds) for (const photo of library.photosByAvatar(avatarId)) held.add(photo.id);
    return held;
  }

  async #customPoses(library: Library, categories: readonly CategoryRef[]): Promise<Map<CategoryRef, CategoryPoses>> {
    const poses = new Map<CategoryRef, CategoryPoses>();
    for (const ref of categories) {
      if (!isCustomCategory(ref)) continue;
      const stored = await library.categories.get(ref);
      if (stored === null) throw new EngineFailure({ code: "NOT_FOUND", detail: `no custom category ${ref}` });
      if (stored.pool.poses !== undefined) poses.set(ref, [...stored.pool.poses]);
    }
    return poses;
  }

  // ---------- the launch's blockers (the card's, not a refusal) ----------

  async #launchBlockers(planned: Planned): Promise<LaunchBlockerCode[]> {
    const { draft, plan } = planned;
    const out: LaunchBlockerCode[] = [];
    const found = await this.#d.orchestrator.startBlockers();
    if (found.active) out.push("launch-active");
    if (found.unreadable) out.push("launch-unreadable");
    if (!draft.library && !draft.generate) out.push("nothing-enabled");
    const gate = plan.totals.toGenerate > 0 ? this.#d.paidGate() : null;
    if (gate !== null) out.push(gateBlocker(gate));
    const status = this.#d.exportStatus();
    if (plan.totals.videos > 0 && status.status === "unavailable") out.push("export-unavailable");
    return out;
  }
}
