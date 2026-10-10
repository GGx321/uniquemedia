import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_LAUNCH_AVATARS, type CategoryRef, type EngineError, type LaunchMix, type LaunchPreview, type LaunchPreviewAvatar, type LaunchView } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { isActiveJob, type EngineView } from "../../engine/store";
import { useMounted } from "../photos/shared";
import { DEFAULT_MIX, settingsKey, type LaunchSettingsInput } from "./launchForm";

// S4.9a: what the «Автопилот» screen asks the engine, and when (plan §9, §4.3):
// - `autopilot.estimate` for the form as it stands: at once the first time, then a moment after the form stops changing (a run of stepper clicks asks
//   once), and a little longer after the world the plan stands on moves (the budget, the key, an avatar's photos, a job that holds an avatar), so a burst of
//   engine events asks once. The seed of the first preview is kept, so the start plans the very videos the last preview showed;
// - a second, cheap estimate of every active avatar (one video each, library only) for the list's «своб.» and «занята», which the plan of the chosen ones
//   cannot tell for the others. It stands on the avatars, the jobs and the categories only: money and models do not move it;
// - `autopilot.start` with exactly the preview's worst case. PRICE_CHANGED asks the price again and needs a new click; nothing is ever sent by itself.
// Nothing is asked while a launch is unfinished: the form is that launch's then, and its paid work must not race a preview's balance read (plan §19).

/** How long the form must stay still before its plan is asked again. */
export const FORM_DEBOUNCE_MS = 250;
/** How long the engine's world must stay still (a burst of `avatar.changed`, `money.changed`) before the plan is asked again… */
export const WORLD_DEBOUNCE_MS = 1_500;
/** …but never longer than this after the first change of a burst, so a steady stream of events cannot hold an old plan on screen. */
export const WORLD_MAX_WAIT_MS = 4_000;

export interface PriceChange {
  /** The worst case the refused click had accepted, and the one asked again. */
  readonly from: number;
  readonly to: number;
}

export interface LaunchPlan {
  /** The preview of exactly the current form; null while it is asked, when the ask failed, and when there is nothing to ask. */
  readonly current: LaunchPreview | null;
  /** The last preview of this form's avatars, kept on the tiles while the next one is asked (null after a failed ask). */
  readonly shown: LaunchPreview | null;
  readonly estimating: boolean;
  readonly estimateError: EngineError | null;
  /** Every probed active avatar's line: its free photos in the chosen categories, whether it is busy, whether its usage reads. */
  readonly probe: ReadonlyMap<string, LaunchPreviewAvatar>;
  /** The probe's price of a video of each shape (it does not depend on the avatars): the legend's, before any avatar is chosen. */
  readonly probePerShape: LaunchMix | null;
  readonly retry: () => void;
  readonly sending: boolean;
  /** The last start's refusal (not PRICE_CHANGED), for the current form. */
  readonly startError: EngineError | null;
  /** PRICE_CHANGED on the last click, for the current form: the new price is on the button, waiting for a new click. */
  readonly priceChanged: PriceChange | null;
  readonly start: () => void;
}

export interface LaunchPlanInput {
  readonly client: EngineClient;
  /** The form's settings, or null when there is nothing to plan (no avatar, no category). */
  readonly settings: LaunchSettingsInput | null;
  /** The active avatars in the list's order, for the probe. */
  readonly activeIds: readonly string[];
  /** The form's categories, for the probe. */
  readonly categories: readonly CategoryRef[];
  /** Everything outside the form the plan depends on (`worldKey`). */
  readonly world: string;
  /** Everything outside the form the probe depends on (`probeWorldKey`): no money, no models. */
  readonly probeWorld: string;
  /** False while a launch is unfinished: nothing is asked then. */
  readonly enabled: boolean;
  readonly onStarted: (launch: LaunchView) => void;
}

/** What the probe stands on: the avatars and their photos, the jobs that hold them, the library's categories. */
function avatarsKey(view: EngineView, customCategories: readonly string[]): unknown[] {
  const busy = [...new Set(view.jobs.filter(isActiveJob).map((j) => j.avatarId))].sort();
  return [view.avatars.map((a) => [a.avatarId, a.status, a.photoCount, a.eligibleUnusedCount, a.videoCount, a.usage.state]), busy, customCategories];
}

/** The engine's state the probe stands on, as one string. */
export function probeWorldKey(view: EngineView, customCategories: readonly string[]): string {
  return JSON.stringify(avatarsKey(view, customCategories));
}

/** The engine's state a plan stands on, as one string: a change of any of it asks the plan again. */
export function worldKey(view: EngineView, customCategories: readonly string[]): string {
  const s = view.settings;
  const m = view.money;
  return JSON.stringify([
    s === null ? null : [s.apiKey.stored, s.apiKey.rejected, s.monthlyBudgetMicros, s.imageModel, s.imageQuality, s.imageAgeCheck, s.textModel, s.musicKey.stored, s.musicKey.rejected, s.exportPath],
    m === null ? null : m.ledger === "open" ? [m.monthlyBudgetMicros, m.spentMicros, m.unsettledMicros, m.reconcileNeeded, m.halt !== null] : ["unavailable"],
    view.exportStatus?.status ?? null,
    // The music card stands on these (S4.10 fix B): a refresh that starts or ends, a new list, a request sent, a log that cannot be read. Not the refresh's progress.
    view.music === null ? null : [view.music.refresh.state, view.music.listFetchedAt, view.music.trackCount, view.music.sentLast31d, view.music.quotaLog],
    view.autopilot === null ? null : [view.autopilot.launchId, view.autopilot.status],
    ...avatarsKey(view, customCategories),
  ]);
}

/**
 * Asks with `ask` whenever `form` or `world` changes, while `enabled`: at once the first time (and on `retry`), `FORM_DEBOUNCE_MS` after the form stops
 * changing, `WORLD_DEBOUNCE_MS` after the world alone stops changing (at most `WORLD_MAX_WAIT_MS` after its first change). An answer for a form that is
 * gone is dropped (`alive`). React's StrictMode runs an effect, cleans it up and runs it again with nothing changed: an ask at once that this cleanup dropped
 * before its answer is asked at once again when the very same form and world come back, and only then (a quick second click still waits its turn).
 */
function useAsking(enabled: boolean, form: string | null, world: string, retry: number, ask: (alive: () => boolean) => Promise<void>): void {
  const asked = useRef<{ readonly form: string; readonly retry: number } | null>(null);
  /** The form, world and retry of an ask at once whose answer a cleanup dropped. */
  const dropped = useRef<string | null>(null);
  const worldSince = useRef<number | null>(null);
  const latest = useRef(ask);
  useLayoutEffect(() => {
    latest.current = ask;
  });
  useEffect(() => {
    if (!enabled || form === null) return;
    let alive = true;
    let fired = false;
    let answered = false;
    const at = JSON.stringify([form, world, retry]);
    const go = (): void => {
      fired = true;
      asked.current = { form, retry };
      worldSince.current = null;
      void latest.current(() => alive).then(() => {
        answered = true;
      });
    };
    const last = asked.current;
    const again = dropped.current === at;
    dropped.current = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (last === null || last.retry !== retry || again) go();
    else if (last.form !== form) {
      worldSince.current = null;
      timer = setTimeout(go, FORM_DEBOUNCE_MS);
    } else {
      const now = Date.now();
      worldSince.current ??= now;
      timer = setTimeout(go, Math.max(0, Math.min(WORLD_DEBOUNCE_MS, worldSince.current + WORLD_MAX_WAIT_MS - now)));
    }
    return () => {
      alive = false;
      if (timer !== null) clearTimeout(timer);
      if (fired && !answered) dropped.current = at;
    };
  }, [enabled, form, world, retry]);
}

interface Keyed<T> {
  readonly key: string;
  readonly value: T;
}

export function useLaunchPlan({ client, settings, activeIds, categories, world, probeWorld, enabled, onStarted }: LaunchPlanInput): LaunchPlan {
  const form = settings === null ? null : settingsKey(settings);
  const key = form === null ? null : `${form}|${world}`;
  const probeIds = activeIds.slice(0, MAX_LAUNCH_AVATARS);
  const probeSettings: LaunchSettingsInput | null =
    probeIds.length === 0 || categories.length === 0
      ? null
      : {
          avatarIds: [...probeIds],
          videosPerAvatar: 1,
          mix: { ...DEFAULT_MIX },
          categories: [...categories],
          poses: { profile: false, back: false },
          library: true,
          generate: false,
          sceneReview: false,
          stickers: false,
        };
  const probeForm = probeSettings === null ? null : settingsKey(probeSettings);

  const latest = useRef({ settings, probeSettings, onStarted, key });
  useLayoutEffect(() => {
    latest.current = { settings, probeSettings, onStarted, key };
  });
  const seed = useRef<number | null>(null);
  const mounted = useMounted();

  const [preview, setPreview] = useState<Keyed<LaunchPreview> | null>(null);
  const [estimateError, setEstimateError] = useState<Keyed<EngineError> | null>(null);
  const [probe, setProbe] = useState<{ avatars: ReadonlyMap<string, LaunchPreviewAvatar>; perShape: LaunchMix | null }>(() => ({ avatars: new Map(), perShape: null }));
  const [retry, setRetry] = useState(0);
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [startError, setStartError] = useState<Keyed<EngineError> | null>(null);
  const [priceChanged, setPriceChanged] = useState<Keyed<PriceChange> | null>(null);

  const estimate = useCallback(
    async (draft: LaunchSettingsInput): Promise<{ ok: true; preview: LaunchPreview } | { ok: false; error: EngineError }> => {
      const reply = await client.request("autopilot.estimate", { draft: seed.current === null ? draft : { ...draft, planSeed: seed.current } });
      if (!reply.ok) return { ok: false, error: reply.error };
      seed.current = reply.result.preview.planSeed;
      return { ok: true, preview: reply.result.preview };
    },
    [client],
  );

  // The plan of the form.
  useAsking(enabled, form, world, retry, async (alive) => {
    const { settings: draft, key: askedKey } = latest.current;
    if (draft === null || askedKey === null) return;
    const answer = await estimate(draft);
    if (!alive() || !mounted.current) return;
    if (answer.ok) {
      setPreview({ key: askedKey, value: answer.preview });
      setEstimateError(null);
    } else setEstimateError({ key: askedKey, value: answer.error });
  });

  // The list's probe: every active avatar, one video each from the library, so the engine's own figures for «своб.» and «занята» reach the rows not chosen.
  useAsking(enabled, probeForm, probeWorld, 0, async (alive) => {
    const draft = latest.current.probeSettings;
    if (draft === null) return;
    const reply = await client.request("autopilot.estimate", { draft });
    if (!alive() || !mounted.current || !reply.ok) return;
    const { avatars, perShapeExpectedMicros } = reply.result.preview;
    setProbe({ avatars: new Map(avatars.map((a) => [a.avatarId, a])), perShape: perShapeExpectedMicros });
  });

  const current = preview !== null && preview.key === key ? preview.value : null;
  const currentError = estimateError !== null && estimateError.key === key ? estimateError.value : null;

  const start = useCallback(() => {
    const { settings: draft, key: startKey } = latest.current;
    if (sendingRef.current || draft === null || startKey === null || preview === null || preview.key !== startKey) return;
    const shownPreview = preview.value;
    const accepted = shownPreview.estimate.worstMicros;
    sendingRef.current = true;
    setSending(true);
    setStartError(null);
    void (async () => {
      try {
        const reply = await client.request("autopilot.start", { draft: { ...draft, planSeed: shownPreview.planSeed }, acceptedWorstMicros: accepted });
        if (reply.ok) {
          // The next launch plans its own videos: a new seed from its first preview.
          seed.current = null;
          setPriceChanged(null);
          latest.current.onStarted(reply.result.launch);
          return;
        }
        const error = reply.error;
        if (error.code === "PRICE_CHANGED" || error.code === "BUDGET_EXCEEDED") {
          // The price (or the month's room) moved under the shown plan: ask it again, at once, for the same videos. A new click is needed either way.
          const fresh = await estimate(draft);
          if (!mounted.current || latest.current.key !== startKey) return;
          if (fresh.ok) {
            setPreview({ key: startKey, value: fresh.preview });
            setEstimateError(null);
          } else setEstimateError({ key: startKey, value: fresh.error });
          if (error.code === "PRICE_CHANGED" && fresh.ok) {
            setPriceChanged({ key: startKey, value: { from: accepted, to: fresh.preview.estimate.worstMicros } });
            return;
          }
        }
        if (mounted.current) setStartError({ key: startKey, value: error });
      } finally {
        sendingRef.current = false;
        if (mounted.current) setSending(false);
      }
    })();
  }, [client, estimate, preview, mounted]);

  const shown = current ?? (preview !== null && currentError === null && settings !== null && sameAvatars(preview.value, settings) ? preview.value : null);

  return {
    current,
    shown,
    estimating: enabled && key !== null && current === null && currentError === null,
    estimateError: currentError,
    probe: probe.avatars,
    probePerShape: probe.perShape,
    retry: () => setRetry((n) => n + 1),
    sending,
    startError: startError !== null && startError.key === key ? startError.value : null,
    priceChanged: priceChanged !== null && priceChanged.key === key ? priceChanged.value : null,
    start,
  };
}

/** Whether an older preview is still about the same avatars (its tiles may stay on screen while the new plan is asked). */
function sameAvatars(preview: LaunchPreview, settings: LaunchSettingsInput): boolean {
  return preview.avatars.length === settings.avatarIds.length && preview.avatars.every((a, i) => a.avatarId === settings.avatarIds[i]);
}
