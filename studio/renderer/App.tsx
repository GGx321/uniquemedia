import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EngineClient } from "./engine/client";
import { EngineProvider, useEngineView } from "./engine/react";
import { sidebarCounts } from "./engine/renderJobs";
import { readStudioVersion } from "./engine/windowStudio";
import { arriving, createNavigation, NavigationProvider, type Route, type SectionId, sectionOf } from "./navigation";
import { AvatarImport } from "./screens/AvatarImport";
import { AvatarsScreen } from "./screens/AvatarsScreen";
import { AvatarWizard } from "./screens/AvatarWizard";
import { DraftsScreen } from "./screens/DraftsScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { DraftFlushes, DraftFlushesProvider } from "./screens/montage/flushes";
import { DraftSessions, DraftSessionsProvider } from "./screens/montage/sessions";
import { PhotosScreen } from "./screens/PhotosScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { countOf, monthName } from "./lib/format";
import { formatUsd } from "./lib/money";
import { EngineNotices } from "./ui/EngineNotices";
import { RenderNotices } from "./ui/RenderNotices";
import { Icon } from "./ui/Icon";
import { ScreenTitle } from "./ui/ScreenTitle";

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
      return <PhotosScreen avatarId={route.avatarId} tab={route.tab ?? "photos"} />;
    case "montages":
      return <DraftsScreen lastAvatarId={lastPhotos} />;
    case "editor":
      return <EditorScreen montageId={route.montageId} created={route.created ?? false} />;
    case "section": {
      const label = SECTIONS.find((s) => s.id === route.id)?.label ?? "";
      return (
        <div className="page">
          <ScreenTitle>{label}</ScreenTitle>
          <p className="muted">Скоро</p>
        </div>
      );
    }
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
      return route.id;
    default:
      return route.name;
  }
}

/** Engine-wide notices belong above every screen, not one of them: useEngineView needs the provider, which App sits outside of. */
function EngineNoticesBar() {
  const view = useEngineView();
  return <EngineNotices notices={view.notices} />;
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
      <NavigationProvider value={navigation}>
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
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={isActive ? "nav-item active" : "nav-item"}
                    aria-current={isActive ? "page" : undefined}
                    onClick={() => navigation.navigate(routeFor(s.id, lastPhotos.current))}
                  >
                    <svg
                      className="nav-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      {s.icon}
                    </svg>
                    <span>{s.label}</span>
                  </button>
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
                <Screen key={screenKey(route)} route={route} lastPhotos={lastPhotos.current} />
              </DraftSessionsProvider>
            </DraftFlushesProvider>
          </main>
        </div>
      </NavigationProvider>
    </EngineProvider>
  );
}
