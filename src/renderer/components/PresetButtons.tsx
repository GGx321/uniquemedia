import type { PresetName } from "../../core/types";

const PRESETS: { id: PresetName; label: string }[] = [
  { id: "light", label: "Лёгкая" },
  { id: "medium", label: "Средняя" },
  { id: "aggressive", label: "Агрессивная" },
];

const DESC: Record<PresetName, string> = {
  light: "Минимальные изменения — едва заметно, базовая уникализация.",
  medium: "Баланс — заметная уникализация без сильных искажений.",
  aggressive: "Максимум уникализации — сильнее меняет картинку.",
};

export function PresetButtons({
  value,
  onChange,
}: {
  value: PresetName;
  onChange: (p: PresetName) => void;
}) {
  return (
    <div>
      <div style={{ display: "flex", gap: 6 }}>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            aria-pressed={value === p.id}
            onClick={() => onChange(p.id)}
            style={{
              flex: 1,
              padding: "8px 0",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: value === p.id ? "var(--accent)" : "var(--panel)",
              color: value === p.id ? "#fff" : "var(--text)",
            }}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p style={{ fontSize: 12, color: "var(--muted)", margin: "6px 0 0" }}>{DESC[value]}</p>
    </div>
  );
}
