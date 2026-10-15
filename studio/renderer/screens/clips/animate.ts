import { CLIP_REASONS_RU, type ClipPhase } from "../../../shared/engine";
import { isActiveJob, type EngineView } from "../../engine/store";
import { paidStop, restartStopText } from "../../lib/paidStop";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §6 37b, 37c; I5.50): why «Оживить» waits before the engine is even asked. The engine refuses the same on its own; this keeps the window from offering a
// paid sheet it would refuse. A photo the engine finds unsuitable says its own reason (`clips.options`), after these.

/** The phases in which a clip holds the one paid slot: from its dispatch until its money closes (I5.50). A recovery, an export and a `retryDownload` never hold it. */
const SLOT_PHASES: ReadonlySet<ClipPhase> = new Set(["preparing", "submitting", "rendering", "proving"]);

/** A paid clip is on its way, in any avatar: a second one is refused `one-at-a-time`. */
export function clipSlotTaken(view: EngineView): boolean {
  return view.jobs.some((job) => {
    const clip = job.clip;
    return job.kind === "clip" && clip !== undefined && isActiveJob(job) && !clip.export && !clip.recovery && SLOT_PHASES.has(clip.phase ?? "preparing");
  });
}

/**
 * 5b.2 (S5.WB4; I5.61, mockup 37e): a batch holds the clip money unit, so a single clip and a second batch are refused `batch-running`. It holds it from its start until its last member's money closes: while
 * a member waits its turn (`queued`), and while one is between its dispatch and its money's close (the slot phases). A last member downloading or saving holds nothing.
 */
export function batchHoldsUnit(view: EngineView): boolean {
  return view.jobs.some((job) => {
    const clip = job.clip;
    if (job.kind !== "clip" || clip === undefined || clip.batch === undefined || !isActiveJob(job) || clip.export || clip.recovery) return false;
    const phase = clip.phase ?? "queued";
    return phase === "queued" || SLOT_PHASES.has(phase);
  });
}

/** Why «Оживить» waits: a text, or `nokey` (37c #nokey: «Нужен ключ OpenRouter — Настройки.», «Настройки» a link); null when the sheet may open. */
export type AnimateBlock = { readonly kind: "text"; readonly text: string } | { readonly kind: "nokey" } | { readonly kind: "batch"; readonly text: string };

/** The new string of this slice for an archived avatar, whose clips the engine no longer makes (it answers NOT_FOUND). */
export const ARCHIVED_CLIP_TEXT = "Аватар в архиве — новые клипы для него не снимаются.";

/** `active`: the avatar makes new content (an archived one does not). */
export function animateBlock(view: EngineView, active: boolean): AnimateBlock | null {
  const stop = paidStop(view);
  const key = view.settings?.apiKey;
  if (stop?.kind === "offline") return { kind: "text", text: "Нет связи с движком — дождитесь, пока он снова ответит." };
  if (key !== undefined && !key.stored) return { kind: "nokey" };
  if (key?.rejected === true) return { kind: "text", text: "Нужен рабочий ключ OpenRouter — добавьте его в Настройках." };
  // 37c: the account's own banner holds the button; its words are short here.
  if (stop?.kind === "reconcile") return { kind: "text", text: "Сначала сверка расходов" };
  if (stop?.kind === "restart") return { kind: "text", text: restartStopText(stop.code) };
  if (!active) return { kind: "text", text: ARCHIVED_CLIP_TEXT };
  // 37e: «отмените оставшиеся» is a link to the «Клипы» tab, where the batch's header has the button.
  if (batchHoldsUnit(view)) return { kind: "batch", text: CLIP_REASONS_RU["batch-running"] };
  if (clipSlotTaken(view)) return { kind: "text", text: CLIP_REASONS_RU["one-at-a-time"] };
  return null;
}
