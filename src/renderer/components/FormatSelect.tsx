import type { ExportFormat } from "../../core/types";

const OPTS: { id: ExportFormat; label: string }[] = [
  { id: "original", label: "Оригинал" },
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
    <label className="field">
      <span className="micro-label">Формат</span>
      <span className="select-wrap">
        <select
          className="input"
          value={value}
          onChange={(e) => onChange(e.target.value as ExportFormat)}
        >
          {OPTS.map((o) => (
            <option key={o.id} value={o.id}>{o.label}</option>
          ))}
        </select>
      </span>
    </label>
  );
}
