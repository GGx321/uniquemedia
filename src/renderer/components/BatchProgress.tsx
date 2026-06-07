export function BatchProgress({
  index,
  count,
  fraction,
}: {
  index: number;
  count: number;
  fraction: number;
}) {
  if (count <= 0) return null;
  const r = 13;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(1, fraction)));
  return (
    <div className="batch-progress" role="progressbar" aria-valuenow={Math.round(fraction * 100)}>
      <span className="batch-ring">
        <svg viewBox="0 0 32 32" aria-hidden>
          <circle className="ring-track" cx="16" cy="16" r={r} />
          <circle
            className="ring-fill"
            cx="16"
            cy="16"
            r={r}
            strokeDasharray={circ}
            strokeDashoffset={offset}
          />
        </svg>
      </span>
      <span className="counter">
        {Math.min(index + 1, count)}/{count}
      </span>
    </div>
  );
}
