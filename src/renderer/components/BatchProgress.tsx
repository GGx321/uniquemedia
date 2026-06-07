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
  return (
    <div className="batch-progress">
      <span className="counter">
        копия {Math.min(index + 1, count)}/{count}
      </span>
      <div className="bar">
        <div className="bar-fill" style={{ width: `${Math.round(fraction * 100)}%` }} />
      </div>
    </div>
  );
}
