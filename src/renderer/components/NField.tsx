import { useEffect, useState } from "react";

export function NField({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => {
    setText(String(value));
  }, [value]);
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "var(--muted)" }}>Копии</span>
      <input
        aria-label="копии"
        type="text"
        inputMode="numeric"
        value={text}
        onChange={(e) => {
          const t = e.target.value.replace(/[^0-9]/g, "");
          setText(t);
          if (t !== "") onChange(Math.max(1, Number(t)));
        }}
        onBlur={() => {
          if (text === "" || Number(text) < 1) {
            setText("1");
            onChange(1);
          }
        }}
        style={{
          padding: 8, borderRadius: 8, background: "var(--panel)",
          color: "var(--text)", border: "1px solid var(--border)",
        }}
      />
    </label>
  );
}
