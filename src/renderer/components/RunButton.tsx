export function RunButton({
  disabled,
  running,
  onClick,
}: {
  disabled: boolean;
  running: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled || running}
      onClick={onClick}
      style={{
        padding: "10px 0", borderRadius: 8, border: "none",
        background: disabled || running ? "var(--border)" : "var(--accent)",
        color: "#fff", fontWeight: 600,
      }}
    >
      {running ? "Processing…" : "Uniquify"}
    </button>
  );
}
