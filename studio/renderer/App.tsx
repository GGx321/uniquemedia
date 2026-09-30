import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EngineClient } from "./engine/client";
import { EngineProvider, useEngineView } from "./engine/react";
import { isActiveJob } from "./engine/store";
import { readStudioVersion } from "./engine/windowStudio";
import { NavigationProvider, type Route, type SectionId, sectionOf } from "./navigation";
import { AvatarImport } from "./screens/AvatarImport";
import { AvatarsScreen } from "./screens/AvatarsScreen";
import { AvatarWizard } from "./screens/AvatarWizard";
import { DraftsScreen } from "./screens/DraftsScreen";
import { EditorScreen } from "./screens/EditorScreen";
import { PhotosScreen } from "./screens/PhotosScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { countOf, monthName } from "./lib/format";
import { formatUsd } from "./lib/money";
import { EngineNotices } from "./ui/EngineNotices";
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
      return <SettingsScreen focus={route.focus} />;
    case "photos":
      return <PhotosScreen avatarId={route.avatarId} />;
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
      return `photos:${route.avatarId ?? "last"}`;
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
 * The sidebar's foot boxes, from what the engine actually reports: the paid
 * jobs still running (their summed progress) and this month's spend against
 * the budget. The sheet's render row and OpenRouter balance have no data in
 * the contract yet, so they are not drawn at all rather than drawn with
 * made-up numbers.
 */
function SidebarStatus() {
  const view = useEngineView();
  if (view.phase !== "ready") return null;
  const active = view.jobs.filter(isActiveJob);
  const done = active.reduce((sum, j) => sum + j.done, 0);
  // A job just tracked from its command answer has no total yet (store.ts's
  // emptyJob): the same "|| 4" fallback AvatarsScreen's draftState and
  // CandidatesCard already use, so the queue never reads "0 / 0".
  const total = active.reduce((sum, j) => sum + (j.total || 4), 0);
  const money = view.money?.ledger === "open" ? view.money : null;
  return (
    <>
      <section className="side-box" aria-label="Очередь">
        <div className="side-box-head">
          <span className="side-box-title">Очередь</span>
          <span className="mono">{active.length > 0 ? countOf(active.length, TASK_FORMS) : "пусто"}</span>
        </div>
        {active.length > 0 && (
          <div className="side-meter">
            <div className="side-meter-row">
              <span>Генерация</span>
              <span className="mono link-text">
                {done} / {total}
              </span>
            </div>
            {/* The numbers above already say it; the screen's own job card carries the real progressbar. */}
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${total > 0 ? (done / total) * 100 : 0}%` }} />
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
      <NavigationProvider value={setRoute}>
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
                    onClick={() => setRoute(routeFor(s.id, lastPhotos.current))}
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
            <Screen key={screenKey(route)} route={route} lastPhotos={lastPhotos.current} />
          </main>
        </div>
      </NavigationProvider>
    </EngineProvider>
  );
}
