/** Where the inter-copy check is: `done` copies settled out of `total`. */
export interface PostPassPhase {
  done: number;
  total: number;
}

export function BatchProgress({
  index,
  count,
  fraction,
  postPass = null,
}: {
  index: number;
  count: number;
  fraction: number;
  /**
   * Set while the batch is in its inter-copy check. Every card is already
   * green by then and the tally reads full, so the phase takes over the ring
   * and the counter — otherwise the only thing still moving is the Stop
   * button, which on a 50-copy run meant 3 min 40 s that read as a hang.
   */
  postPass?: PostPassPhase | null;
}) {
  if (count <= 0) return null;
  const shown = postPass
    ? { fraction: postPass.total > 0 ? postPass.done / postPass.total : 0, done: postPass.done, total: postPass.total }
    : { fraction, done: Math.min(index + 1, count), total: count };
  const r = 13;
  const circ = 2 * Math.PI * r;
  const offset = circ * (1 - Math.max(0, Math.min(1, shown.fraction)));
  return (
    <div className="batch-progress" role="progressbar" aria-valuenow={Math.round(shown.fraction * 100)}>
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
      {postPass && <span className="phase-label">Проверка уникальности между копиями</span>}
      <span className="counter">
        {shown.done}/{shown.total}
      </span>
    </div>
  );
}
