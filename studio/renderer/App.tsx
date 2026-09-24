import { useEffect, useState, type ReactNode } from "react";

interface Section {
  id: "avatars" | "photo" | "montage" | "autopilot" | "settings";
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

export function App() {
  const [active, setActive] = useState<Section>(SECTIONS[0]);
  const [versionLabel, setVersionLabel] = useState("");

  useEffect(() => {
    let alive = true;
    window.studio.version().then(
      (v) => { if (alive) setVersionLabel(`v${v}`); },
      // The version is informational: a failed lookup shows a dash, not a crash.
      () => { if (alive) setVersionLabel("—"); }
    );
    return () => {
      alive = false;
    };
  }, []);

  return (
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
            const isActive = s.id === active.id;
            return (
              <button
                key={s.id}
                type="button"
                className={isActive ? "nav-item active" : "nav-item"}
                aria-current={isActive ? "page" : undefined}
                onClick={() => setActive(s)}
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

        <div className="version">{versionLabel}</div>
      </aside>

      <main className="content">
        <h1>{active.label}</h1>
        <p className="muted">Скоро</p>
      </main>
    </div>
  );
}
