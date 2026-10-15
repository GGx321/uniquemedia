import { useEffect, useRef, useState } from "react";
import type { AvatarSummary } from "../../../shared/engine";
import { clipQueueRows } from "../../engine/renderJobs";
import type { JobView } from "../../engine/store";
import { useNavigate } from "../../navigation";
import { ClipSteps } from "./ClipSteps";

// Stage 5, 5b.1, S5.V8 (README §S5.VD decision 10, mockups 37b, 40, 46): each clip at work has its row in the sidebar's «Очередь» — «Клип · Nini», its short phase («Снимается 1:20»
// counting), and its steps for the bar; an export reads «Сохраняем 40 %» over its frames. A clip never joins «Генерация» (`sidebarCounts`).

/** «Клип 5/10 · Nini» as a link to Nini's «Клипы», where the batch's header and «Отменить оставшиеся» are. */
function BatchRowLink({ label, avatarId }: { label: string; avatarId: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" className="side-clip-link" title={label} onClick={() => navigate({ name: "photos", avatarId, tab: "clips" })}>
      {label}
    </button>
  );
}

export function ClipQueueRows({ jobs, avatars }: { jobs: readonly JobView[]; avatars: readonly AvatarSummary[] }) {
  const seen = useRef(new Map<string, number>());
  const [now, setNow] = useState(() => Date.now());
  const rows = clipQueueRows(jobs, avatars, { nowMs: now, seenAt: (jobId) => seen.current.get(jobId) ?? now });
  for (const row of rows) if (!seen.current.has(row.jobId)) seen.current.set(row.jobId, Date.now());
  const counting = rows.length > 0;
  useEffect(() => {
    if (!counting) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [counting]);
  return (
    <>
      {rows.map((row) => (
        // 5b.2 (S5.WB4): a batch's one row, «Клип 5/10 · Nini»: a long name ends in «…» and the phase goes under it, to the right; a wait reads grey. S5.WB4c: its name leads to that avatar's «Клипы».
        <div key={row.jobId} className={row.batch !== undefined ? "side-meter side-clip side-clip-batch" : "side-meter side-clip"}>
          <div className="side-meter-row">
            {row.batch !== undefined ? (
              <BatchRowLink label={row.label} avatarId={row.batch.avatarId} />
            ) : (
              <span>{row.label}</span>
            )}
            <span className={row.warn ? "side-clip-warn" : row.quiet === true ? "side-clip-quiet" : "link-text"}>{row.phase}</span>
          </div>
          {row.meter.kind === "steps" ? (
            <ClipSteps done={row.meter.done} total={row.meter.total} warn={row.warn} idle={row.quiet === true} />
          ) : (
            <div className="bar" aria-hidden="true">
              <span style={{ width: `${row.meter.percent}%` }} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}
