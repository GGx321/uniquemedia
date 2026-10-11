import { useEffect, useRef, useState, type RefObject } from "react";
import type { AvatarPortraits, AvatarSummary, EngineError, Estimate, PortraitCandidate } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { isActiveJob, type EngineView, type JobView } from "../../engine/store";
import type { LookLanding } from "../../navigation";
import { useMounted } from "../photos/shared";
import { avatarHeld, type LandingPortraits } from "./lookModel";
import { answerLost, type MasterKind } from "./portraitModel";

// S5.3d: an imported avatar's reference portrait on «Внешность» (.omc/stage5/design 15–23), held by the avatar's screen like the check (useLookCheck),
// so a look at «Фото» and back keeps the batch, the choice and what was said. The list of portraits is the engine's (`avatars.portraits`), read again on
// every step of this avatar's batch (each portrait is stored before the `job.progress` that counts it, B1), on its end, and on a new master. The paid
// command is only ever sent at a worst case the owner saw: the card's own «до $X», or the one the import screen showed under its button (`landing`).

/** Where the paid start came from: the landing after «Импортировать», or a button on the page. */
export type StartFrom = "landing" | "page";

export type StartPhase =
  | { readonly kind: "idle" }
  | { readonly kind: "sending"; readonly from: StartFrom }
  /** Refused before anything was paid (18b): the window says why, and that nothing was started. */
  | { readonly kind: "refused"; readonly error: EngineError; readonly from: StartFrom }
  /**
   * M1: the answer never came (main's deadline): the batch may have started. Said as the app says it, never as «nothing spent»; a batch of hers the
   * window did not know when it sent (`known`) is that start, and its events take the panel over.
   */
  | { readonly kind: "unknown"; readonly error: EngineError; readonly from: StartFrom; readonly known: ReadonlySet<string> };

/** A free write (the pick, the reset, the way back): idle, being saved, or refused. */
export type WritePhase = { readonly kind: "idle" } | { readonly kind: "saving" } | { readonly kind: "refused"; readonly error: EngineError };

export interface Portraits {
  /** `avatars.portraits` as last read; null until the first answer, and while a read fails. */
  readonly list: AvatarPortraits | null;
  /** The imported photo; null for a wizard avatar (no card, no panel) and before the first answer. */
  readonly sourcePhotoId: string | null;
  /** What the variants would replace (H1): the imported photo, or a portrait picked earlier. */
  readonly masterKind: MasterKind;
  /** The portrait master's likeness to the imported photo; null for the imported photo itself, or when it is not known. */
  readonly masterLikeness: number | null;
  /** The master is a portrait whose file is gone (S5.3c): only the way back is offered. */
  readonly masterMissing: boolean;
  /** The waiting portraits, best first. */
  readonly pending: readonly PortraitCandidate[];
  /** The batch this screen shows: the avatar's running one, else the last one that ended while the screen was open. */
  readonly job: JobView | null;
  readonly running: boolean;
  /** «Варианты мастер-портрета» is open: a batch runs, portraits wait, or the last batch's end is still to be read. */
  readonly panelOpen: boolean;
  /** Only an active avatar draws, picks and resets (the engine refuses the rest NOT_FOUND). */
  readonly actionable: boolean;
  readonly estimate: Estimate | null;
  readonly estimating: boolean;
  readonly estimateError: EngineError | null;
  /** PRICE_CHANGED: the worst case the refused start had accepted («Было не больше $A, теперь не больше $B»). */
  readonly previousWorst: number | null;
  readonly start: StartPhase;
  /** The landing's start was not sent: no key, a reconcile or a halt stopped it before anything was spent (18b `key`, `reconcile`). */
  readonly landingSkipped: boolean;
  /** Another job of hers holds the avatar (a photo run, a launch's run, a check): a start, a pick and a reset would be refused IN_FLIGHT (22, 22b). */
  readonly held: boolean;
  /** The chosen portrait: the owner's own choice while it waits, else the best; none while the batch runs. */
  readonly picked: string | null;
  readonly best: string | null;
  readonly pickPhase: WritePhase;
  readonly discardPhase: WritePhase;
  readonly revertPhase: WritePhase;
  /** A portrait was just made the master (19): the line over the tab says what that changes. */
  readonly saved: boolean;
  readonly cancelling: boolean;
  readonly cancelError: EngineError | null;
  /** What the landing line says of the import's portraits (design decision 8). */
  readonly landing: LandingPortraits;
  /** The panel's heading, and the master card's: where focus goes when the button pressed goes away. */
  readonly panelHeading: RefObject<HTMLHeadingElement | null>;
  readonly masterHeading: RefObject<HTMLHeadingElement | null>;
  choose(photoId: string): void;
  /** «Получить 5 вариантов» / «Ещё 5 вариантов»: the batch at the price on the button. */
  startBatch(): void;
  cancel(): void;
  /** «Сделать мастером»: the chosen portrait becomes the master. */
  pick(): void;
  /** The reset: every waiting portrait goes; the master stays. */
  discard(): void;
  /** 17: no portrait waits, so the reset only closes the panel. */
  closePanel(): void;
  /** «Вернуть»: the imported photo is the master again. */
  revert(): void;
  reprice(): void;
}

/** Landings already acted on: a screen mounted again for the same route (React's development double mount, say) never starts a second paid batch. */
const consumed = new WeakSet<LookLanding>();

/**
 * `shown`: the tab is on screen (the price is asked for then); `ready`: the engine answers; `paidBlocked`: a paid command would be refused before any
 * spend (no key, offline, a halt) — the landing's start is then not sent at all, and the card says why.
 */
export function usePortraits(
  avatar: AvatarSummary,
  landing: LookLanding | null,
  options: { view: EngineView; shown: boolean; ready: boolean; paidBlocked: boolean },
): Portraits {
  const { view, shown, ready, paidBlocked } = options;
  const { client, store } = useEngine();
  const mounted = useMounted();
  const { avatarId, masterPhotoId } = avatar;

  const [list, setList] = useState<AvatarPortraits | null>(null);
  const [readAsk, setReadAsk] = useState(0);
  const readSeq = useRef(0);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimateError, setEstimateError] = useState<EngineError | null>(null);
  const [priceAsk, setPriceAsk] = useState(0);
  const [previousWorst, setPreviousWorst] = useState<number | null>(null);
  const [start, setStart] = useState<StartPhase>({ kind: "idle" });
  const [landingSkipped, setLandingSkipped] = useState(false);
  const sending = useRef(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const [pickPhase, setPickPhase] = useState<WritePhase>({ kind: "idle" });
  const [discardPhase, setDiscardPhase] = useState<WritePhase>({ kind: "idle" });
  const [revertPhase, setRevertPhase] = useState<WritePhase>({ kind: "idle" });
  const [saved, setSaved] = useState<{ photoId: string; likeness: number | null } | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<EngineError | null>(null);
  const [focus, setFocus] = useState<"panel" | "master" | null>(null);
  const panelHeading = useRef<HTMLHeadingElement | null>(null);
  const masterHeading = useRef<HTMLHeadingElement | null>(null);

  // A batch that had already ended when the screen opened is old news: its end is not said again (its portraits, if any wait, are in the list).
  const [endedAtOpen] = useState<ReadonlySet<string>>(
    () => new Set(view.jobs.filter((j) => j.kind === "avatar.portraits" && j.avatarId === avatarId && !isActiveJob(j)).map((j) => j.jobId)),
  );
  const own = view.jobs.filter((j) => j.kind === "avatar.portraits" && j.avatarId === avatarId && !endedAtOpen.has(j.jobId));
  const job = own.filter(isActiveJob).at(-1) ?? own.at(-1) ?? null;
  const running = job !== null && isActiveJob(job);
  const jobKey = job === null ? "none" : `${job.jobId}:${job.done}:${job.status}`;

  // The list, while the tab is on screen: when it comes on, on every step and end of the batch, on a new master, and after a free write.
  useEffect(() => {
    if (!ready || !shown) return;
    const seq = ++readSeq.current;
    void client.request("avatars.portraits", { avatarId }).then((reply) => {
      // An answer older than the last question must not undo it.
      if (!mounted.current || seq !== readSeq.current) return;
      if (reply.ok) setList(reply.result);
    });
  }, [ready, shown, client, avatarId, masterPhotoId, jobKey, readAsk, mounted]);

  const sourcePhotoId = list?.sourcePhotoId ?? null;
  const imported = sourcePhotoId !== null;
  const imageAgeCheck = view.settings?.imageAgeCheck;

  // The free price, asked for when the tab is on screen (and again when the age check, which moves it, does).
  useEffect(() => {
    if (!ready || !shown || !imported) return;
    let alive = true;
    setEstimating(true);
    setEstimateError(null);
    void client.request("avatars.estimatePortraits", {}).then((reply) => {
      if (!alive) return;
      setEstimating(false);
      if (reply.ok) setEstimate(reply.result);
      else {
        setEstimate(null);
        setEstimateError(reply.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [ready, shown, imported, imageAgeCheck, client, priceAsk]);

  useEffect(() => {
    if (focus === null) return;
    (focus === "panel" ? panelHeading.current : masterHeading.current)?.focus();
    setFocus(null);
  }, [focus]);

  async function send(acceptedWorstMicros: number, from: StartFrom): Promise<void> {
    // Two clicks before the busy button is drawn must not buy two batches.
    if (sending.current) return;
    sending.current = true;
    // The window-wide paid lock: every other paid button of hers waits for the answer (the batch will hold her from then on).
    store.setPaidInFlight(avatarId, true);
    setStart({ kind: "sending", from });
    // Her batches the window knows now: one that shows up after a lost answer is the batch that answer started.
    const known = new Set(store.getView().jobs.filter((j) => j.kind === "avatar.portraits" && j.avatarId === avatarId).map((j) => j.jobId));
    try {
      const reply = await client.request("avatars.generatePortraits", { avatarId, acceptedWorstMicros });
      // Recorded even when the screen is gone: the job is the window's.
      if (reply.ok) store.trackPortraitsJob(reply.result.jobId, avatarId);
      if (!mounted.current) return;
      if (!reply.ok && answerLost(reply.error)) {
        setStart({ kind: "unknown", error: reply.error, from, known });
        return;
      }
      if (reply.ok) {
        setStart({ kind: "idle" });
        setPreviousWorst(null);
        setLandingSkipped(false);
        setSaved(null);
        setDismissed(null);
        setPickPhase({ kind: "idle" });
        setDiscardPhase({ kind: "idle" });
        return;
      }
      if (reply.error.code === "PRICE_CHANGED") {
        // The new price before the button can be pressed again: the refused one must not be clickable meanwhile.
        const fresh = await client.request("avatars.estimatePortraits", {});
        if (!mounted.current) return;
        if (fresh.ok) {
          setEstimate(fresh.result);
          setPreviousWorst(acceptedWorstMicros);
        } else {
          setEstimate(null);
          setEstimateError(fresh.error);
        }
      }
      setStart({ kind: "refused", error: reply.error, from });
    } finally {
      sending.current = false;
      store.setPaidInFlight(avatarId, false);
    }
  }

  // After «Импортировать»: the batch the import screen priced under its button, started once, at the worst case it showed. Never without a key or under a
  // reconcile (or another halt): it is then not sent at all, and the card says so.
  useEffect(() => {
    if (landing?.kind !== "imported" || !ready || consumed.has(landing)) return;
    consumed.add(landing);
    if (landing.portraitsWorstMicros === null) return;
    if (paidBlocked) {
      setLandingSkipped(true);
      return;
    }
    void send(landing.portraitsWorstMicros, "landing");
  }, [landing, ready, paidBlocked]);

  // M1: a batch of hers the window did not know when an answer was lost is the batch that start began: its events take over from the notice.
  const startedUnseen = start.kind === "unknown" && job !== null && !start.known.has(job.jobId);
  useEffect(() => {
    if (startedUnseen) setStart({ kind: "idle" });
  }, [startedUnseen]);

  const pending = list?.candidates ?? [];
  const best = pending[0]?.photoId ?? null;
  const picked = running ? null : chosen !== null && pending.some((c) => c.photoId === chosen) ? chosen : best;
  const masterKind: MasterKind = sourcePhotoId !== null && masterPhotoId === sourcePhotoId ? "source" : "portrait";
  // Until the list is read again after a pick, the picked portrait's likeness is the one it was offered with.
  const masterLikeness = list !== null && list.masterPhotoId === masterPhotoId ? list.masterLikeness : saved?.photoId === masterPhotoId ? saved.likeness : null;
  const masterMissing = list !== null && list.masterPhotoId === masterPhotoId && list.masterMissing === true;
  const actionable = avatar.status === "active";
  const shownJob = job !== null && job.jobId !== dismissed ? job : null;
  const panelOpen = imported && actionable && (running || pending.length > 0 || shownJob !== null);
  const held = avatarHeld(view, avatarId) && start.kind !== "sending" && !running;
  const cancelling = cancelBusy || (job !== null && view.cancellingJobs.has(job.jobId));

  let landingPortraits: LandingPortraits = null;
  if (landing?.kind === "imported" && !saved) {
    if (running || (start.kind === "sending" && start.from === "landing")) landingPortraits = "drawing";
    else if (job?.status === "done" && pending.length > 0) landingPortraits = "ready";
  }

  /** The list is known to have lost its waiting portraits (a pick or a reset the engine confirmed): drawn so at once, read again for the rest. */
  function dropPending(): void {
    setList((now) => (now === null ? now : { ...now, candidates: [] }));
    setReadAsk((n) => n + 1);
  }

  return {
    list,
    sourcePhotoId,
    masterKind,
    masterLikeness,
    masterMissing,
    pending,
    job,
    running,
    panelOpen,
    actionable,
    estimate,
    estimating,
    estimateError,
    previousWorst,
    start,
    landingSkipped,
    held,
    picked,
    best,
    pickPhase,
    discardPhase,
    revertPhase,
    saved: saved !== null,
    cancelling,
    cancelError,
    landing: landingPortraits,
    panelHeading,
    masterHeading,
    choose(photoId) {
      setChosen(photoId);
    },
    startBatch() {
      if (estimate === null || start.kind === "sending" || running) return;
      void send(estimate.worstMicros, "page");
    },
    cancel() {
      if (job === null || !isActiveJob(job)) return;
      const { jobId } = job;
      setCancelBusy(true);
      setCancelError(null);
      void client.request("avatars.cancel", { jobId }).then((reply) => {
        if (!mounted.current) return;
        setCancelBusy(false);
        if (reply.ok) {
          // Accepted is not ended (M-optimistic-cancel): the store waits for the job's real end.
          store.markCancelling(reply.result.jobId);
          setFocus("panel");
        } else setCancelError(reply.error);
      });
    },
    pick() {
      const photoId = picked;
      if (photoId === null || pickPhase.kind === "saving") return;
      const likeness = pending.find((c) => c.photoId === photoId)?.likeness ?? null;
      setPickPhase({ kind: "saving" });
      void client.request("avatars.pickPortrait", { avatarId, photoId }).then((reply) => {
        if (reply.ok) store.saveAvatar(reply.result.avatar);
        if (!mounted.current) return;
        if (!reply.ok) {
          setPickPhase({ kind: "refused", error: reply.error });
          // A portrait no longer there (another window picked or reset): the list says what is left.
          if (reply.error.code !== "IN_FLIGHT") setReadAsk((n) => n + 1);
          return;
        }
        setPickPhase({ kind: "idle" });
        setSaved({ photoId, likeness });
        setChosen(null);
        setDismissed(job?.jobId ?? null);
        setStart({ kind: "idle" });
        dropPending();
        setFocus("master");
      });
    },
    discard() {
      if (discardPhase.kind === "saving") return;
      setDiscardPhase({ kind: "saving" });
      void client.request("avatars.discardPortraits", { avatarId }).then((reply) => {
        if (!mounted.current) return;
        if (!reply.ok) {
          setDiscardPhase({ kind: "refused", error: reply.error });
          return;
        }
        setDiscardPhase({ kind: "idle" });
        setChosen(null);
        setDismissed(job?.jobId ?? null);
        dropPending();
        setFocus("master");
      });
    },
    closePanel() {
      setDismissed(job?.jobId ?? null);
      setFocus("master");
    },
    revert() {
      if (sourcePhotoId === null || revertPhase.kind === "saving") return;
      setRevertPhase({ kind: "saving" });
      void client.request("avatars.pickPortrait", { avatarId, photoId: sourcePhotoId }).then((reply) => {
        if (reply.ok) store.saveAvatar(reply.result.avatar);
        if (!mounted.current) return;
        if (!reply.ok) {
          setRevertPhase({ kind: "refused", error: reply.error });
          return;
        }
        setRevertPhase({ kind: "idle" });
        setSaved(null);
        setReadAsk((n) => n + 1);
        setFocus("master");
      });
    },
    reprice() {
      setPriceAsk((n) => n + 1);
    },
  };
}
