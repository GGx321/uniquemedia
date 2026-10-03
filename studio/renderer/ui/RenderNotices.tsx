import { useEffect, useState } from "react";
import { useEngine, useEngineView } from "../engine/react";
import { dismissNotice, NO_NOTICES, trackNotices, type RenderNotice, type RenderNoticeState } from "../engine/renderJobs";
import { isActiveJob, type JobView } from "../engine/store";
import { errorSettingsFocus, errorText, settingsLinkLabel } from "../lib/errors";
import { useNavigate } from "../navigation";
import { Notice } from "./Notice";

/** While a render is saving, the window looks again this often to see whether the phase has outlasted its limit. */
export const STALL_POLL_MS = 5_000;

/**
 * Renders that end while the owner is somewhere else (3d.6): «Видео готово» and «Рендер не удался», on whatever screen is open, and a
 * «сохранение» phase that has lasted too long (told anywhere: the editor's header only says «Сохранение…»). Which notices exist is the
 * render job model's call (`trackNotices`); this only shows them, with the existing notice component. `viewing` is the draft whose editor
 * is on screen: that editor's header says how its own render ended, so it raises no notice for it.
 */
export function RenderNotices({ viewing }: { viewing: string | null }) {
  const view = useEngineView();
  const { client } = useEngine();
  const navigate = useNavigate();
  const [state, setState] = useState<RenderNoticeState>(NO_NOTICES);
  const [tick, setTick] = useState(0);
  /** Videos «Открыть в папке» could not show: their file is not there. */
  const [lost, setLost] = useState<ReadonlySet<string>>(new Set());
  const saving = view.jobs.some((job) => job.kind === "render" && job.saving && isActiveJob(job));

  useEffect(() => {
    setState((prev) => trackNotices(prev, view.jobs, Date.now(), viewing));
  }, [view.jobs, viewing, tick]);

  useEffect(() => {
    if (!saving) return;
    const timer = setInterval(() => setTick((n) => n + 1), STALL_POLL_MS);
    return () => clearInterval(timer);
  }, [saving]);

  const close = (notice: RenderNotice): void => setState((prev) => dismissNotice(prev, notice.id));
  const draftLink = (job: JobView) =>
    job.montageId === null ? null : (
      <button type="button" className="btn btn-s" onClick={() => navigate({ name: "editor", montageId: job.montageId ?? "" })}>
        К черновику
      </button>
    );

  async function reveal(videoId: string): Promise<void> {
    const reply = await client.request("videos.reveal", { videoId });
    if (!reply.ok) setLost((prev) => new Set(prev).add(videoId));
  }

  return (
    <>
      {state.notices.map((notice) => {
        const job = view.jobs.find((j) => j.jobId === notice.jobId);
        if (job === undefined) return null;
        const avatar = view.avatars.find((a) => a.avatarId === job.avatarId)?.name;
        const whose = avatar === undefined ? "" : `«${avatar}»: `;
        const closeButton = (
          <button type="button" className="btn btn-s" onClick={() => close(notice)}>
            Закрыть
          </button>
        );
        if (notice.kind === "saving-stalled") {
          return (
            <Notice key={notice.id} tone="warn" title="Сохранение идёт дольше обычного" actions={closeButton}>
              {whose}видео записывается в «Готовые видео», но папка отвечает слишком долго. Не закрывайте Studio: видео сохранится, когда папка ответит. Если она отключена, подключите её.
            </Notice>
          );
        }
        if (notice.kind === "failed") {
          const error = job.error ?? { code: "INTERNAL" as const };
          const focus = errorSettingsFocus(error.code);
          return (
            <Notice
              key={notice.id}
              tone="danger"
              title="Рендер не удался"
              actions={
                <>
                  {draftLink(job)}
                  {focus !== null && (
                    <button type="button" className="btn btn-s" onClick={() => navigate({ name: "settings", focus })}>
                      {settingsLinkLabel(focus)}
                    </button>
                  )}
                  {closeButton}
                </>
              }
            >
              {whose}
              {errorText(error)}
            </Notice>
          );
        }
        const videoId = job.result?.kind === "render" ? job.result.videoId : job.videoId;
        return (
          <Notice
            key={notice.id}
            tone="ok"
            title="Видео готово"
            actions={
              <>
                {videoId !== null && (
                  <button type="button" className="btn btn-s" onClick={() => void reveal(videoId)}>
                    Открыть в папке
                  </button>
                )}
                {draftLink(job)}
                {closeButton}
              </>
            }
          >
            {whose}видео собрано и лежит в «Готовых видео».
            {videoId !== null && lost.has(videoId) && " Файла нет в папке «Готовые видео»: его удалили или переместили."}
          </Notice>
        );
      })}
    </>
  );
}
