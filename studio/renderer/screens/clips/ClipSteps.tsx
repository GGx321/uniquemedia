// Stage 5, 5b.1, S5.V8 (README §S5.VD decision 5): the steps of a clip at work as a bar of segments (`progressCounts`: video, download, check, save): the done ones in the accent, the one
// under way paler, a late clip's in the warning's tone. On its tile and on its queue row alike. 5b.2 (S5.WB4): a batch member waiting its turn has begun no step (`idle`): no segment is under way.

export function ClipSteps({ done, total, warn, idle = false }: { done: number; total: number; warn: boolean; idle?: boolean }) {
  return (
    <div className={warn ? "clip-steps clip-steps-warn" : "clip-steps"} aria-hidden="true">
      {Array.from({ length: Math.max(1, total) }, (_, i) => (
        <span key={i} className={i < done ? "done" : i === done && !idle ? "now" : undefined} />
      ))}
    </div>
  );
}
