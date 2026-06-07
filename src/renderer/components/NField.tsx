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
    <label className="field">
      <span className="micro-label">Копии</span>
      <input
        className="input"
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
      />
    </label>
  );
}
