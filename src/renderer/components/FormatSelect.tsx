import type { ExportFormat } from "../../core/types";

const OPTS: { id: ExportFormat; label: string }[] = [
  { id: "reels", label: "Reels 9:16" },
  { id: "feed", label: "Лента 4:5" },
  { id: "square", label: "Квадрат 1:1" },
];

export function FormatSelect({
  value,
  onChange,
}: {
  value: ExportFormat;
  onChange: (f: ExportFormat) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as ExportFormat)}
      style={{
        width: "100%", padding: 8, borderRadius: 8,
        background: "var(--panel)", color: "var(--text)", border: "1px solid var(--border)",
      }}
    >
      {OPTS.map((o) => (
        <option key={o.id} value={o.id}>{o.label}</option>
      ))}
    </select>
  );
}
