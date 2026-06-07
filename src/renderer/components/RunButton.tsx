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
      <button className="run-btn stop" onClick={onStop}>
        ⏹ Стоп
      </button>
    );
  }
  return (
    <button className="run-btn" disabled={disabled} onClick={onClick}>
      Уникализировать
    </button>
  );
}
