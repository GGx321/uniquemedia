import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { EngineClient } from "./engine/client";
import { EngineProvider, useEngineView } from "./engine/react";
import { sidebarCounts } from "./engine/renderJobs";
import { readStudioVersion } from "./engine/windowStudio";
import { arriving, createNavigation, NavigationProvider, type Route, type SectionId, sectionOf } from "./navigation";
import { AutopilotScreen } from "./screens/AutopilotScreen";
import { HistoryScreen } from "./screens/autopilot/HistoryScreen";
import { LaunchForms, LaunchFormsProvider } from "./screens/autopilot/launchForm";
import { LaunchScreen } from "./screens/autopilot/LaunchScreen";
import { SidebarMarkView, useSidebarMark } from "./screens/autopilot/SidebarMark";
import { AvatarImport } from "./screens/AvatarImport";
import { AvatarsScreen } from "./screens/AvatarsScreen";
import { AvatarWizard } from "./screens/AvatarWizard";
import { DraftsScreen } from "./screens/DraftsScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { DraftFlushes, DraftFlushesProvider } from "./screens/montage/flushes";
import { DraftSessions, DraftSessionsProvider } from "./screens/montage/sessions";
import { MontagePicks, MontagePicksProvider } from "./screens/photos/picks";
import { RunForms, RunFormsProvider } from "./screens/photos/runForms";
import { PhotosScreen } from "./screens/PhotosScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { countOf, monthName } from "./lib/format";
import { formatUsd } from "./lib/money";
import { dismissalKey, EngineNotices } from "./ui/EngineNotices";
import { Docked, NoticeDockProvider } from "./ui/NoticeDock";
import { RenderNotices } from "./ui/RenderNotices";
import { Icon } from "./ui/Icon";

interface Section {
  id: SectionId;
  label: string;
  icon: ReactNode;
}

// Icons are the sidebar sheet's own (Sidebar.dc.html), drawn at stroke 1.8.
const SECTIONS: readonly Section[] = [
  {
    id: "avatars",
    label: "Аватары",
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-3.9 3.6-6 8-6s8 2.1 8 6" />
      </>
    ),
  },
  {
    id: "photo",
    label: "Фото",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <circle cx="9" cy="9" r="2" />
        <path d="M21 15l-5-5L5 21" />
      </>
    ),
  },
  {
    id: "montage",
    label: "Монтаж",
    icon: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4" />
      </>
    ),
  },
  {
    id: "autopilot",
    label: "Автопилот",
    icon: <path d="M13 2L4 14h7l-1 8 9-12h-7z" />,
  },
  {
    id: "settings",
    label: "Настройки",
    icon: (
      <>
        <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
        <circle cx="15" cy="6" r="2" />
        <circle cx="9" cy="12" r="2" />
        <circle cx="17" cy="18" r="2" />
      </>
    ),
  },
];

/** `lastPhotos`: the avatar the Photos screen showed last, so the sidebar's «Фото» comes back to it. */
function routeFor(id: SectionId, lastPhotos: string | null): Route {
  switch (id) {
    case "avatars":
      return { name: "avatars" };
    case "photo":
      return { name: "photos", avatarId: lastPhotos };
    case "montage":
      return { name: "montages" };
    case "settings":
      return { name: "settings" };
    case "autopilot":
      return { name: "section", id };
  }
}

/** `lastPhotos`: the avatar the Photos screen showed last, for the drafts screen's «Открыть фото …». */
function Screen({ route, lastPhotos }: { route: Route; lastPhotos: string | null }) {
  switch (route.name) {
    case "avatars":
      return <AvatarsScreen saved={route.saved} />;
    case "avatarNew":
      return <AvatarWizard draftId={route.draftId} />;
    case "avatarImport":
      return <AvatarImport />;
    case "settings":
      return <SettingsScreen focus={route.focus} back={route.back} />;
    case "photos":
      return <PhotosScreen avatarId={route.avatarId} tab={route.tab ?? "photos"} focus={route.focus ?? null} landing={route.landing ?? null} />;
    case "montages":
      return <DraftsScreen lastAvatarId={lastPhotos} />;
    case "editor":
      return <EditorScreen montageId={route.montageId} created={route.created ?? false} />;
    case "section":
      return <AutopilotScreen chosen={route.chosen ?? null} />;
    case "launches":
      return <HistoryScreen focus={route.focus ?? null} />;
    case "launch":
      return <LaunchScreen launchId={route.launchId} from={route.from} />;
  }
}

function screenKey(route: Route): string {
  switch (route.name) {
    case "avatarNew":
      return `avatarNew:${route.draftId ?? "new"}`;
    case "photos":
      return `photos:${route.avatarId ?? "last"}:${route.tab ?? "photos"}`;
    case "editor":
      return `editor:${route.montageId}`;
    case "section":
      return route.chosen === undefined ? route.id : `${route.id}:${route.chosen.join(",")}`;
    case "launch":
      return `launch:${route.launchId}`;
    default:
      return route.name;
  }
}

/**
 * Engine-wide notices belong above every screen, not one of them: useEngineView needs the provider, which App sits outside of. The ones the
 * owner closed are kept here, by the window, for as long as it runs (slice review 5, L1).
 */
function EngineNoticesBar() {
  const view = useEngineView();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  return (
    <Docked>
      <EngineNotices notices={view.notices} dismissed={dismissed} onDismiss={(notice) => setDismissed((now) => new Set(now).add(dismissalKey(notice)))} />
    </Docked>
  );
}

/**
 * A library switch (review r1 LOW-7): what the window keeps of the old library's drafts and photos (the closed editors' sessions, the picks for a
 * montage) belongs to it, not to the new one, whose ids may be the same: `onSwitch` forgets it. The first folder heard is no switch.
 */
function ForgetOnLibrarySwitch({ onSwitch }: { onSwitch: () => void }) {
  // Compared without trailing separators (review r2 NIT): the same folder written with one is no switch.
  const libraryPath = useEngineView().settings?.libraryPath.replace(/(?<=.)[\\/]+$/, "") ?? null;
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (libraryPath === null) return;
    if (last.current !== null && last.current !== libraryPath) onSwitch();
    last.current = libraryPath;
  }, [libraryPath, onSwitch]);
  return null;
}

/** One section of the sidebar; `mark` (S4.9a) is what «Автопилот» says of the launch, described with the item (`describedBy`) rather than named in it. */
function NavButton({ section, active, onClick, mark, describedBy }: { section: Section; active: boolean; onClick: () => void; mark?: ReactNode; describedBy?: string }) {
  return (
    <button
      type="button"
      className={active ? "nav-item active" : "nav-item"}
      aria-current={active ? "page" : undefined}
      aria-describedby={describedBy}
      onClick={onClick}
    >
      <svg className="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {section.icon}
      </svg>
      <span>{section.label}</span>
      {mark}
    </button>
  );
}

/** «Автопилот» with the launch's mark («14 / 30», «сцены», «пауза», «ждёт», «готово»), read with the item through aria-describedby. */
function AutopilotNavItem({ section, active, onClick }: { section: Section; active: boolean; onClick: () => void }) {
  const mark = useSidebarMark(active);
  const descriptionId = useId();
  return (
    <NavButton
      section={section}
      active={active}
      onClick={onClick}
      describedBy={mark === null ? undefined : descriptionId}
      mark={mark === null ? undefined : <SidebarMarkView mark={mark} descriptionId={descriptionId} />}
    />
  );
}

const TASK_FORMS = ["задача", "задачи", "задач"] as const;

/**
 * The sidebar's foot boxes, from what the engine actually reports: the queue (every job still queued or
 * running, renders included) with a row per kind, «Генерация» for photo runs and candidate batches and
 * «Рендер a / b» for renders (AM4), and this month's spend against the budget. The counts are the render job
 * model's (`sidebarCounts`). The sheet's OpenRouter balance has no data in the contract yet, so it is not
 * drawn at all rather than drawn with made-up numbers.
 */
function SidebarStatus() {
  const view = useEngineView();
  if (view.phase !== "ready") return null;
  // A photo job just tracked from its command answer has no total yet (store.ts's emptyJob): `sidebarCounts`
  // counts its 4 slots, as AvatarsScreen's draftState and CandidatesCard do, so the queue never reads "0 / 0".
  const counts = sidebarCounts(view.jobs, view.renderBatch);
  const money = view.money?.ledger === "open" ? view.money : null;
  return (
    <>
      <section className="side-box" aria-label="Очередь">
        <div className="side-box-head">
          <span className="side-box-title">Очередь</span>
          <span className="mono">{counts.queue > 0 ? countOf(counts.queue, TASK_FORMS) : "пусто"}</span>
        </div>
        {counts.generation !== null && (
          <div className="side-meter">
            <div className="side-meter-row">
              <span>Генерация</span>
              <span className="mono link-text">
                {counts.generation.done} / {counts.generation.total}
              </span>
            </div>
            {/* The numbers above already say it; the screen's own job card carries the real progressbar. */}
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${(counts.generation.done / counts.generation.total) * 100}%` }} />
            </div>
          </div>
        )}
        {counts.scenes !== null && (
          <div className="side-meter">
            <div className="side-meter-row">
              <span>Сцены</span>
              <span className="mono link-text">
                {counts.scenes.done} / {counts.scenes.total}
              </span>
            </div>
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${counts.scenes.total > 0 ? (counts.scenes.done / counts.scenes.total) * 100 : 0}%` }} />
            </div>
          </div>
        )}
        {counts.render !== null && (
          <div className="side-meter">
            <div className="side-meter-row">
              <span>Рендер</span>
              <span className="mono side-render-count">
                {counts.render.ended} / {counts.render.size}
              </span>
            </div>
            <div className="bar side-render-bar" aria-hidden="true">
              <span style={{ width: `${counts.render.fraction * 100}%` }} />
            </div>
          </div>
        )}
      </section>
      {money && (
        <section className="side-box side-spend" aria-label="Расходы за месяц">
          <span className="side-spend-label">{monthName(money.month)} · потрачено</span>
          <span className="mono side-spend-figure">{formatUsd(money.spentMicros)}</span>
          <span className="mono">из {formatUsd(money.monthlyBudgetMicros)}</span>
        </section>
      )}
    </>
  );
}

export function App({ client }: { client: EngineClient }) {
  const [route, setRoute] = useState<Route>({ name: "avatars" });
  // Every way to another screen, the sidebar included, goes through the leave guard of the screen on show (3d.2
  // review: the montage editor's unsaved edit). Settings entered from a draft remembers it (`arriving`, slice review 5-M2).
  const [navigation] = useState(() => createNavigation((next) => setRoute((current) => arriving(current, next))));
  // The saves of montage editors that closed, so the same draft opened again waits for them.
  const [draftFlushes] = useState(() => new DraftFlushes());
  // Their sessions and places, so the same draft opened again in this window goes on where it was (slice review 5-M2).
  const [draftSessions] = useState(() => new DraftSessions());
  // The photos picked for a montage on each avatar's Photos screen, kept while the window runs (slice review 5-L3).
  const [montagePicks] = useState(() => new MontagePicks());
  // The run's form on each avatar's Photos screen, kept while the window runs (CS.7 L4).
  const [runForms] = useState(() => new RunForms());
  // The «Автопилот» launch form, kept while the window runs (S4.9a).
  const [launchForms] = useState(() => new LaunchForms());
  const forgetLibrary = useCallback(() => {
    draftSessions.clear();
    montagePicks.clear();
    runForms.clear();
    launchForms.clear();
  }, [draftSessions, montagePicks, runForms, launchForms]);
  const [versionLabel, setVersionLabel] = useState("");
  const active = sectionOf(route);
  const lastPhotos = useRef<string | null>(null);
  useEffect(() => {
    if (route.name === "photos" && route.avatarId !== null) lastPhotos.current = route.avatarId;
  }, [route]);

  useEffect(() => {
    let alive = true;
    readStudioVersion().then(
      (v) => { if (alive) setVersionLabel(`v${v}`); },
      // The version is informational: a failed lookup shows a dash, not a crash.
      () => { if (alive) setVersionLabel("—"); }
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
    <EngineProvider client={client}>
      <ForgetOnLibrarySwitch onSwitch={forgetLibrary} />
      <NavigationProvider value={navigation}>
        <NoticeDockProvider>
          <div className="shell">
            <aside className="sidebar">
              <div className="logo">
                <span className="logo-mark" aria-hidden="true">
                  <Icon name="sun" size={18} strokeWidth={2.2} />
                </span>
                <span className="logo-text">
                  <span className="logo-name">studio</span>
                  <span className="logo-by">by uniquemedia</span>
                </span>
              </div>
  
              <nav className="nav" aria-label="Разделы">
                {SECTIONS.map((s) => {
                  const isActive = s.id === active;
                  const go = () => navigation.navigate(routeFor(s.id, lastPhotos.current));
                  return s.id === "autopilot" ? (
                    <AutopilotNavItem key={s.id} section={s} active={isActive} onClick={go} />
                  ) : (
                    <NavButton key={s.id} section={s} active={isActive} onClick={go} />
                  );
                })}
              </nav>
  
              <div className="sidebar-foot">
                <SidebarStatus />
                {client.kind === "mock" && (
                  <p className="demo-badge" title="Движок не подключён: данные демонстрационные, деньги не тратятся, картинок нет">
                    <span className="demo-dot" aria-hidden="true" />
                    Демо-движок
                  </p>
                )}
                <div className="version">{versionLabel}</div>
              </div>
            </aside>
  
            <main className="content">
              <EngineNoticesBar />
              <RenderNotices viewing={route.name === "editor" ? route.montageId : null} />
              <DraftFlushesProvider value={draftFlushes}>
                <DraftSessionsProvider value={draftSessions}>
                  <MontagePicksProvider value={montagePicks}>
                    <RunFormsProvider value={runForms}>
                      <LaunchFormsProvider value={launchForms}>
                        <Screen key={screenKey(route)} route={route} lastPhotos={lastPhotos.current} />
                      </LaunchFormsProvider>
                    </RunFormsProvider>
                  </MontagePicksProvider>
                </DraftSessionsProvider>
              </DraftFlushesProvider>
            </main>
          </div>
        </NoticeDockProvider>
      </NavigationProvider>
    </EngineProvider>
  );
}
