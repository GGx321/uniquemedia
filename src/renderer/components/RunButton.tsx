export function RunButton({
  disabled,
  running,
  onClick,
  onStop,
}: {
  disabled: boolean;
  running: boolean;
  onClick: () => void;
  onStop: () => void;
}) {
  if (running) {
    return (
      <button
        onClick={onStop}
        style={{ padding: "10px 0", borderRadius: 8, border: "none", background: "#c0453b", color: "#fff", fontWeight: 600 }}
      >
        ⏹ Стоп
      </button>
    );
  }
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      style={{ padding: "10px 0", borderRadius: 8, border: "none", background: disabled ? "var(--border)" : "var(--accent)", color: "#fff", fontWeight: 600 }}
    >
      Уникализировать
    </button>
  );
}
