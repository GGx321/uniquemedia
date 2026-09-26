import { useEffect, useState, type ReactNode } from "react";
import type { EngineClient } from "./engine/client";
import { EngineProvider, useEngineView } from "./engine/react";
import { readStudioVersion } from "./engine/windowStudio";
import { NavigationProvider, type Route, type SectionId, sectionOf } from "./navigation";
import { AvatarsScreen } from "./screens/AvatarsScreen";
import { AvatarWizard } from "./screens/AvatarWizard";
import { SettingsScreen } from "./screens/SettingsScreen";
import { EngineNotices } from "./ui/EngineNotices";
import { ScreenTitle } from "./ui/ScreenTitle";

interface Section {
  id: SectionId;
  label: string;
  icon: ReactNode;
}

const SECTIONS: readonly Section[] = [
  {
    id: "avatars",
    label: "Аватары",
    icon: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-3.5 3.6-6 8-6s8 2.5 8 6" />
      </>
    ),
  },
  {
    id: "photo",
    label: "Фото",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <circle cx="9" cy="10" r="2" />
        <path d="M21 16l-5-5-9 9" />
      </>
    ),
  },
  {
    id: "montage",
    label: "Монтаж",
    icon: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <path d="M3 9h18M3 15h18M8 5v4M16 5v4M8 15v4M16 15v4" />
      </>
    ),
  },
  {
    id: "autopilot",
    label: "Автопилот",
    icon: <path d="M13 3L5 14h6l-1 7 8-11h-6l1-7z" />,
  },
  {
    id: "settings",
    label: "Настройки",
    icon: (
      <>
        <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
        <circle cx="16" cy="7" r="2" />
        <circle cx="10" cy="17" r="2" />
      </>
    ),
  },
];

function routeFor(id: SectionId): Route {
  switch (id) {
    case "avatars":
      return { name: "avatars" };
    case "settings":
      return { name: "settings" };
    default:
      return { name: "section", id };
  }
}

function Screen({ route }: { route: Route }) {
  switch (route.name) {
    case "avatars":
      return <AvatarsScreen saved={route.saved} />;
    case "avatarNew":
      return <AvatarWizard draftId={route.draftId} />;
    case "settings":
      return <SettingsScreen focus={route.focus} />;
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
  return route.name === "avatarNew" ? `avatarNew:${route.draftId ?? "new"}` : route.name === "section" ? route.id : route.name;
}

/** Engine-wide notices belong above every screen, not one of them: useEngineView needs the provider, which App sits outside of. */
function EngineNoticesBar() {
  const view = useEngineView();
  return <EngineNotices notices={view.notices} />;
}

export function App({ client }: { client: EngineClient }) {
  const [route, setRoute] = useState<Route>({ name: "avatars" });
  const [versionLabel, setVersionLabel] = useState("");
  const active = sectionOf(route);

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
              <span className="logo-mark" aria-hidden="true" />
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
                    onClick={() => setRoute(routeFor(s.id))}
                  >
                    <svg
                      className="nav-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.6"
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
            <Screen key={screenKey(route)} route={route} />
          </main>
        </div>
      </NavigationProvider>
    </EngineProvider>
  );
}
