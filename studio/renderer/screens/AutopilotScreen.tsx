import { type RefObject, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_LAUNCH_AVATARS, type CategoryRef, type LaunchMix, type LaunchPreview, type LaunchPreviewAvatar, type LaunchSummary, type LaunchView } from "../../shared/engine";
import { useCategoryLibrary, useEngine, useEngineView } from "../engine/react";
import { useNavigate } from "../navigation";
import { Icon } from "../ui/Icon";
import { ScreenTitle } from "../ui/ScreenTitle";
import { AvatarColumn } from "./autopilot/AvatarColumn";
import { lastLaunchLine, resultsDoneOf, statusTag } from "./autopilot/historyModel";
import { MusicDialog } from "./autopilot/MusicDialog";
import { useLaunchList } from "./autopilot/useLaunches";
import {
  DEFAULT_MIX,
  defaultForm,
  launchSettings,
  mixStorage,
  readMix,
  selectAll,
  selectNone,
  stepVideos,
  toggleAvatar,
  useLaunchForms,
  writeMix,
  type LaunchForm,
} from "./autopilot/launchForm";
import { useWide } from "./autopilot/layout";
import { LaunchCard } from "./autopilot/LaunchCard";
import { PlanCard, PlanColumn, PlanMini, type GoButtonState } from "./autopilot/PlanColumn";
import { aboutUsd, figuresOf, goTitle, goWhy, isUnfinished, limitText, musicLine, planNotes } from "./autopilot/planModel";
import { SettingsColumn } from "./autopilot/SettingsColumn";
import { probeWorldKey, useLaunchPlan, worldKey } from "./autopilot/useLaunchPlan";
import { readSceneReview, viewerStorage } from "./photos/sceneReview";
import { arrangeCategories } from "./photos/runForm";

// S4.9a: the «Автопилот» screen (AutopilotS4.dc.html, states plan … from-main; the owner's mockup Autopilot.dc.html): three columns — the avatars, «Настройки
// запуска», and the plan with «Запустить: N видео · до $W». The plan is the engine's (`autopilot.estimate`), asked again as the form changes; the click
// sends exactly its worst case. While a launch is unfinished the two columns on the left show its settings read only and the plan folds to one line; under
// it the live card (S4.9b: pause, stop, «Продолжить · до $R», the holds, the avatars' progress, the log). S4.9c: «История запусков» in the header, «Последний
// запуск» under the plan, the music chip's window, and the avatars «Автопилот для выбранных» brought from «Аватары» (ApFromMain).

/** The launch the screen shows: the engine's, or the one this window just started while the engine's word on it is on its way. */
function shownLaunch(engine: LaunchView | null, started: LaunchView | null): LaunchView | null {
  if (started === null) return engine;
  if (engine === null) return started;
  if (engine.launchId === started.launchId) return engine;
  return isUnfinished(engine) ? engine : started;
}

/** A launch's settings as the form shows them (read only). */
function formOfLaunch(launch: LaunchView): LaunchForm {
  const { draft } = launch;
  return {
    avatarIds: draft.avatarIds,
    videosPerAvatar: draft.videosPerAvatar,
    mix: draft.mix,
    categories: draft.categories,
    poses: draft.poses,
    library: draft.library,
    generate: draft.generate,
    sceneReview: draft.sceneReview,
    stickers: draft.stickers,
  };
}

/** Focuses `ref`'s element once the screen shows it (an effect: the element may only just be mounted), when `ask` is called. */
function useFocusAfter<T extends HTMLElement>(): readonly [RefObject<T | null>, () => void] {
  const ref = useRef<T>(null);
  const [wanted, setWanted] = useState(0);
  useEffect(() => {
    if (wanted === 0) return;
    ref.current?.focus();
  }, [wanted]);
  return [ref, useCallback(() => setWanted((n) => n + 1), [])] as const;
}

/** «Последний запуск» (ApPlan, at 1440 under the plan): the newest launch of the history, when none is on the card, with «Результаты». */
function LastLaunchCard({ summary, nameOf }: { summary: LaunchSummary; nameOf: (avatarId: string) => string | null }) {
  const navigate = useNavigate();
  const tag = statusTag(summary.status);
  return (
    <section className="card ap-last" aria-labelledby="ap-last-title">
      <div className="ap-last-head">
        <h2 id="ap-last-title" className="ap-h2">
          Последний запуск
        </h2>
        <span className={`tag ap-st ap-st-${tag.tone}`}>{tag.text}</span>
      </div>
      <p className="mono muted ap-last-line">{lastLaunchLine(summary, nameOf)}</p>
      <button type="button" className="btn btn-s ap-last-go" onClick={() => navigate({ name: "launch", launchId: summary.launchId, from: "autopilot" })}>
        Результаты
      </button>
    </section>
  );
}

/**
 * S4.10 fix C (UI LOW 1): the right column with no launch in the history (LaunchStates, «правая колонка без истории — вместо «Последний запуск»»; README
 * decision 15): what to do for the first one.
 */
function NoLaunchesCard() {
  return (
    <section className="card ap-last ap-last-empty" aria-labelledby="ap-last-empty-title">
      <span className="ap-empty-mark" aria-hidden="true">
        <Icon name="bolt" size={20} strokeWidth={1.9} />
      </span>
      <h2 id="ap-last-empty-title" className="ap-empty-title">
        Запусков пока не было
      </h2>
      <p className="faint ap-empty-text">Выберите аватаров слева и нажмите «Запустить» — здесь появится ход запуска.</p>
    </section>
  );
}

export function AutopilotScreen({ chosen = null }: { chosen?: readonly string[] | null }) {
  const view = useEngineView();
  const { client } = useEngine();
  const navigate = useNavigate();
  const forms = useLaunchForms();
  const wide = useWide();
  const { list: history } = useLaunchList();
  const { view: categorySlice } = useCategoryLibrary();
  const customs = categorySlice.list.status === "ready" ? categorySlice.list.categories : null;
  const customOrder = useMemo(() => (customs ?? []).map((c) => c.categoryId), [customs]);

  const [form, setFormState] = useState<LaunchForm>(() => forms.get() ?? defaultForm(readSceneReview(viewerStorage()), readMix(mixStorage())));
  const setForm = useCallback(
    (next: LaunchForm) => {
      forms.set(next);
      setFormState(next);
    },
    [forms],
  );

  const ready = view.phase === "ready";
  const active = useMemo(() => view.avatars.filter((a) => a.status === "active"), [view.avatars]);
  const activeIds = useMemo(() => active.map((a) => a.avatarId), [active]);
  const names = useMemo(() => new Map(view.avatars.map((a) => [a.avatarId, a.name])), [view.avatars]);

  // An avatar archived or deleted since it was chosen leaves the form (an estimate naming it would be refused).
  useEffect(() => {
    if (!ready) return;
    const kept = form.avatarIds.filter((id) => activeIds.includes(id));
    if (kept.length !== form.avatarIds.length) setForm({ ...form, avatarIds: kept });
  }, [ready, activeIds, form, setForm]);

  // S4.9c (ApFromMain): «Автопилот для выбранных» opens the screen with those avatars chosen, once, in the list's order (the active ones, at most a launch's).
  // Fix round 1: while a launch is unfinished the form on screen is that launch's, so the choice is not slipped into the next launch's form unseen — it is
  // left alone, and the column says so; and a choice that has no active avatar left changes nothing and says nothing («Выбраны: 0» is never shown). The count
  // is of the ones still active: one archived or deleted after the screen opened leaves the line's number too, and the line goes with the last.
  const [fromMain, setFromMain] = useState<{ readonly ids: readonly string[]; readonly held: boolean } | null>(null);
  const chosenTaken = useRef(false);
  useEffect(() => {
    if (chosen === null || chosenTaken.current || !ready) return;
    chosenTaken.current = true;
    const picked = activeIds.filter((id) => chosen.includes(id)).slice(0, MAX_LAUNCH_AVATARS);
    if (picked.length === 0) return;
    if (isUnfinished(view.autopilot)) {
      setFromMain({ ids: picked, held: true });
      return;
    }
    setForm({ ...form, avatarIds: picked });
    setFromMain({ ids: picked, held: false });
  }, [chosen, ready, activeIds, form, setForm, view.autopilot]);
  const fromMainCount = fromMain === null ? 0 : fromMain.ids.filter((id) => activeIds.includes(id)).length;
  const fromMainLine = fromMain === null || fromMainCount === 0 ? null : { count: fromMainCount, held: fromMain.held };

  // S4.9c: the music chip's window (ApPlanMusic), opened by the chip or by «Мои треки…» of the waiting-music notice; the focus goes back to what opened it.
  const musicChip = useRef<HTMLButtonElement>(null);
  const [musicWindow, setMusicWindow] = useState<{ readonly opener: HTMLElement | null } | null>(null);
  const [musicMarks, setMusicMarks] = useState(0);
  const openMusic = useCallback(() => setMusicWindow({ opener: document.activeElement instanceof HTMLElement ? document.activeElement : null }), []);

  const [started, setStarted] = useState<LaunchView | null>(null);
  const launch = shownLaunch(view.autopilot, started);
  const running = isUnfinished(launch);
  const [liveTitle, focusLive] = useFocusAfter<HTMLHeadingElement>();
  const [firstHandle, focusHandle] = useFocusAfter<HTMLButtonElement>();
  const goRef = useRef<HTMLButtonElement>(null);

  const settings = launchSettings(form, customOrder);
  const plan = useLaunchPlan({
    client,
    settings: ready ? settings : null,
    activeIds,
    categories: settings?.categories ?? arrangeCategories(form.categories, customOrder),
    // An own track marked or unmarked in the music window moves the plan's tracks: the plan is asked again.
    world: `${worldKey(view, customOrder)}:${musicMarks}`,
    probeWorld: probeWorldKey(view, customOrder),
    enabled: ready && !running,
    onStarted: (next) => {
      setStarted(next);
      focusLive();
    },
  });

  // The legend's per-shape price does not depend on the avatars: the last plan's stays for a launch's read-only settings and while the next is asked.
  const perShapeNow = plan.shown?.perShapeExpectedMicros ?? plan.probePerShape;
  const lastPerShape = useRef<LaunchMix | null>(null);
  useLayoutEffect(() => {
    if (perShapeNow !== null) lastPerShape.current = perShapeNow;
  });
  const perShape = perShapeNow ?? lastPerShape.current;
  const shapePrices = perShape === null ? null : { single: aboutUsd(perShape.single), collage: aboutUsd(perShape.collage), slides: aboutUsd(perShape.slides) };

  const locked = running || plan.sending;
  const shownForm = running && launch !== null ? formOfLaunch(launch) : form;
  const edit = (next: LaunchForm): void => {
    if (!locked) setForm(next);
  };
  const setMix = (mix: LaunchMix): void => {
    if (locked) return;
    writeMix(mixStorage(), mix);
    setForm({ ...form, mix });
  };
  const toggleCategory = (ref: CategoryRef): void => {
    const on = form.categories.includes(ref);
    edit({ ...form, categories: on ? form.categories.filter((c) => c !== ref) : [...form.categories, ref] });
  };

  const planned = useMemo(() => new Map<string, LaunchPreviewAvatar>((plan.shown?.avatars ?? []).map((a) => [a.avatarId, a])), [plan.shown]);
  const noAvatars = useMemo(() => new Map<string, LaunchPreviewAvatar>(), []);
  const nameOf = (avatarId: string): string => names.get(avatarId) ?? "Аватар";
  // The notes and the «почему» line follow the plan on screen (no flicker while the next is asked); the button opens only on the plan of the form as it is.
  const notes = running ? [] : planNotes({ preview: plan.shown, videosPerAvatar: form.videosPerAvatar, generate: form.generate, nameOf });
  const whyInput = { activeCount: active.length, chosen: form.avatarIds.length, categories: settings?.categories.length ?? 0, library: form.library, generate: form.generate };
  const whyForm = goWhy({ ...whyInput, preview: null });
  const whyShown = goWhy({ ...whyInput, preview: plan.shown });
  const whyNow = goWhy({ ...whyInput, preview: plan.current });
  const go: GoButtonState =
    plan.estimateError !== null && whyForm === null
      ? { title: "Повторить оценку", enabled: true, busy: false, retry: true, why: null }
      : {
          title: plan.sending ? "Запускаем…" : plan.shown === null && plan.estimating && whyForm === null ? "Считаем…" : goTitle(figuresOf(plan.current ?? plan.shown)),
          enabled: !plan.sending && plan.current !== null && whyNow === null,
          busy: plan.sending || (plan.estimating && whyForm === null),
          retry: false,
          why: plan.sending ? null : whyShown,
        };

  // The music line keeps the last plan's words for a launch's read-only settings (nothing is estimated while it runs).
  const musicNow = plan.shown?.music ?? null;
  const lastMusic = useRef<LaunchPreview["music"] | null>(null);
  useLayoutEffect(() => {
    if (musicNow !== null) lastMusic.current = musicNow;
  });
  const music = musicLine(musicNow ?? lastMusic.current);
  const figures = figuresOf(plan.shown);
  const limit = running && launch !== null ? limitText(launch.plannedWorstMicros) : limitText(figures === null ? null : figures.estimate.worstMicros);
  const launches = history.state === "ready" ? history.launches : null;
  const last = launches?.[0] ?? null;
  const knownName = (avatarId: string): string | null => names.get(avatarId) ?? null;

  return (
    <div className="page ap-page">
      <header className="ap-head">
        <div className="ap-head-text">
          <ScreenTitle>Автопилот</ScreenTitle>
          <p className="muted ap-head-sub">
            {wide ? "Аватары пачкой → сцены → фото → видео до 10 с. Сначала библиотека, недостающее догенерируется." : "Аватары пачкой → сцены → фото → видео до 10 с."}
          </p>
        </div>
        <button type="button" className="btn ap-history-btn" onClick={() => navigate({ name: "launches" })}>
          История запусков
          {launches !== null && <span className="mono faint ap-history-n">{launches.length}</span>}
        </button>
      </header>

      <div className="ap-cols">
        <AvatarColumn
          avatars={ready ? active : null}
          chosen={shownForm.avatarIds}
          planned={running ? noAvatars : planned}
          probed={running ? noAvatars : plan.probe}
          readOnly={locked}
          running={running}
          showFree={!running}
          onToggle={(id) => edit(toggleAvatar(form, id, activeIds))}
          onAll={() => edit(selectAll(form, activeIds))}
          onNone={() => edit(selectNone(form))}
          fromMain={fromMainLine}
        />

        <SettingsColumn
          form={shownForm}
          launchSettings={running}
          readOnly={locked}
          customs={customs}
          prices={shapePrices}
          music={music}
          limit={limit}
          wide={wide}
          firstHandleRef={firstHandle}
          onVideos={(delta) => edit(stepVideos(form, delta))}
          onMix={setMix}
          onMixReset={() => {
            setMix(DEFAULT_MIX);
            focusHandle();
          }}
          onCategory={toggleCategory}
          onPose={(pose) => edit({ ...form, poses: { ...form.poses, [pose]: !form.poses[pose] } })}
          onSwitch={(which) => edit({ ...form, [which]: !form[which] })}
          musicOpen={musicWindow !== null}
          musicChipRef={musicChip}
          onMusic={() => (musicWindow === null ? openMusic() : setMusicWindow(null))}
        />

        {/* One place for the launch's card whatever the state, so its heading (with the focus after «Запустить» or «Остановить») survives running → stopped. */}
        <PlanColumn>
          {running && wide && launch !== null && <PlanMini launch={launch} />}
          {launch !== null && (
            <LaunchCard key={launch.launchId} launch={launch} titleRef={liveTitle} wide={wide} nameOf={nameOf} onMusic={openMusic} resultsDone={resultsDoneOf(launches, launch.launchId, launch.status)} />
          )}
          {!running && (
            <PlanCard
              preview={figures}
              videosPerAvatar={form.videosPerAvatar}
              notes={notes}
              priceChanged={plan.priceChanged}
              estimateError={whyForm === null ? plan.estimateError : null}
              startError={plan.startError}
              go={go}
              goRef={goRef}
              onGo={go.retry ? plan.retry : plan.start}
            />
          )}
          {launch === null && wide && last !== null && <LastLaunchCard summary={last} nameOf={knownName} />}
          {/* Only once the history has answered with nothing at all: an entry that cannot be read is a launch too. */}
          {launch === null && wide && history.state === "ready" && history.launches.length === 0 && history.unreadable.length === 0 && <NoLaunchesCard />}
        </PlanColumn>
      </div>

      {musicWindow !== null && (
        <MusicDialog
          music={musicNow ?? lastMusic.current}
          anchor={musicChip.current}
          wide={wide}
          onClose={() => setMusicWindow(null)}
          onChanged={() => setMusicMarks((n) => n + 1)}
          returnFocus={() => (musicWindow.opener?.isConnected === true ? musicWindow.opener : musicChip.current)}
        />
      )}
    </div>
  );
}
