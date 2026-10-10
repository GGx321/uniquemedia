import { CHECK_ASPECTS, type CheckAspect, type DescriptorCheck } from "../../../shared/engine";
import { isActiveJob, type EngineView } from "../../engine/store";

// S5.0d: what the «Внешность» tab says, apart from the components that draw it — the check's verdict and its aspects, the proposal as an edit (struck
// out and inserted), the «последняя: …» line, and whether the avatar is held by work the check must wait for. No money is computed here: every figure
// the tab shows is the engine's estimate, formatted where it is drawn.

/** Where a check was asked for: on the tab, after «Сохранить» in the wizard, or inside «Импортировать». */
export type CheckContext = "page" | "create" | "import";

export const ASPECT_LABEL: Record<CheckAspect, string> = { hair: "Волосы", eyes: "Глаза", marks: "Приметы", body: "Тело" };

/** The aspects a text proposal can fix: a body mismatch is never fixed in text (it goes to the body traits, S5.2). */
const TEXT_ASPECTS: readonly CheckAspect[] = ["hair", "eyes", "marks"];

export type AspectMark = "ok" | "bad" | "skip" | "wait";

export interface AspectRow {
  readonly aspect: CheckAspect;
  readonly label: string;
  readonly mark: AspectMark;
  /** Grey words after the name: «на фото не видно», «если в кадре». */
  readonly note: string | null;
  /** What a screen reader hears after the name. */
  readonly spoken: string;
  /** A mismatch's own words: «В описании: …» and «На фото: …» (model output, plain text, at most 40 chars each). */
  readonly said: string | null;
  readonly seen: string | null;
}

/** The four rows of the card: all waiting while a check runs (`check` null), else each aspect's verdict. An aspect the answer left out was not checked. */
export function aspectRows(check: DescriptorCheck | null): AspectRow[] {
  return CHECK_ASPECTS.map((aspect) => {
    const label = ASPECT_LABEL[aspect];
    if (check === null) {
      const note = aspect === "body" ? "если в кадре" : null;
      return { aspect, label, mark: "wait", note, spoken: "сверяем", said: null, seen: null };
    }
    const verdict = check.aspects[aspect];
    if (verdict === undefined) return { aspect, label, mark: "skip", note: "не проверено", spoken: "не проверено", said: null, seen: null };
    switch (verdict.state) {
      case "ok":
        return { aspect, label, mark: "ok", note: null, spoken: "совпадает", said: null, seen: null };
      case "not-visible":
        return { aspect, label, mark: "skip", note: "на фото не видно", spoken: "на фото не видно", said: null, seen: null };
      case "mismatch":
        return { aspect, label, mark: "bad", note: null, spoken: "не совпадает", said: verdict.descriptor ?? null, seen: verdict.photo ?? null };
    }
  });
}

/** The aspects the check found contradicted, in the card's order. */
export function mismatchedAspects(check: DescriptorCheck): CheckAspect[] {
  return CHECK_ASPECTS.filter((aspect) => check.aspects[aspect]?.state === "mismatch");
}

/** «Не совпадает: волосы» / «Не совпадает: волосы, глаза». */
export function mismatchTitle(check: DescriptorCheck): string {
  return `Не совпадает: ${mismatchedAspects(check)
    .map((aspect) => ASPECT_LABEL[aspect].toLowerCase())
    .join(", ")}`;
}

/** Whether the mismatch is one the owner can fix in the text (hair, eyes, marks): a body-only mismatch is not. */
export function textMismatch(check: DescriptorCheck): boolean {
  return TEXT_ASPECTS.some((aspect) => check.aspects[aspect]?.state === "mismatch");
}

/** «Сверка видит на фото: волосы — прямые платиновые с чёлкой.»: the proposal's reason beside its buttons, from the check's own words. */
export function proposalReason(check: DescriptorCheck): string {
  const seen = TEXT_ASPECTS.flatMap((aspect) => {
    const verdict = check.aspects[aspect];
    return verdict?.state === "mismatch" && verdict.photo !== undefined ? [`${ASPECT_LABEL[aspect].toLowerCase()} — ${verdict.photo}`] : [];
  });
  if (seen.length > 0) return `Сверка видит на фото: ${seen.join("; ")}.`;
  const names = TEXT_ASPECTS.filter((aspect) => check.aspects[aspect]?.state === "mismatch").map((aspect) => ASPECT_LABEL[aspect].toLowerCase());
  return `Сверка нашла расхождение: ${names.join(", ")}.`;
}

/** When a finished check ran, as its verdict says it: «при сохранении», «при импорте», or «сегодня, 14:22». */
export function whenLabel(context: CheckContext, at: Date, now: Date = new Date()): string {
  if (context === "create") return "при сохранении";
  if (context === "import") return "при импорте";
  return `${sameDay(at, now) ? "сегодня" : DAY.format(at)}, ${CLOCK.format(at)}`;
}

/** The latest finished check of this visit, for «последняя: …» under a later attempt. */
export interface LastCheck {
  readonly at: Date;
  readonly context: CheckContext;
  readonly matches: boolean;
}

/** «последняя: ещё не было» / «последняя: 14:22 · совпадало» / «последняя: при сохранении · не совпадало». */
export function lastLine(last: LastCheck | null, now: Date = new Date()): string {
  if (last === null) return "последняя: ещё не было";
  const when = last.context === "page" ? (sameDay(last.at, now) ? CLOCK.format(last.at) : `${DAY.format(last.at)}, ${CLOCK.format(last.at)}`) : whenLabel(last.context, last.at, now);
  return `последняя: ${when} · ${last.matches ? "совпадало" : "не совпадало"}`;
}

const CLOCK = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const DAY = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" });

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** «Сверка доступна, когда закончатся съёмка и другие задачи этого аватара» — the IN_FLIGHT state the mockup does not draw (plan §5.5). */
export const CHECK_HELD_REASON = "Сверка доступна, когда закончатся съёмка и другие задачи этого аватара";

/** An edit refused IN_FLIGHT: a check, a delete or another job holds the avatar (a photo run does not). */
export const EDIT_HELD_REASON = "Описание можно изменить, когда закончится сверка или другая задача этого аватара";

/**
 * Whether this window knows of work that holds the avatar, so the paid check would be refused IN_FLIGHT: a photo run or a candidates batch of hers that
 * is queued or running, or a paid start of hers on its way. A launch holds her through its own runs, which are run jobs. What the window cannot see (a
 * check from another window, a launch between its steps) still comes back as IN_FLIGHT, and the card says the same thing then.
 */
export function avatarHeld(view: Pick<EngineView, "jobs" | "paidInFlightAvatars">, avatarId: string): boolean {
  if (view.paidInFlightAvatars.has(avatarId)) return true;
  return view.jobs.some((job) => job.avatarId === avatarId && (job.kind === "run" || job.kind === "avatar.candidates") && isActiveJob(job));
}

/** Whether a photo run of hers is drawing now: an edit is allowed, and that run finishes with the text it started with. */
export function runDrawing(view: Pick<EngineView, "jobs">, avatarId: string): boolean {
  return view.jobs.some((job) => job.avatarId === avatarId && job.kind === "run" && isActiveJob(job));
}

// ---------- the proposal as an edit ----------

export interface DiffPart {
  readonly kind: "same" | "del" | "ins";
  readonly text: string;
}

/** Words (with their hyphens and apostrophes), single punctuation marks, and the spaces between them. */
const TOKEN = /\s+|[\p{L}\p{N}'-]+|[^\s\p{L}\p{N}'-]/gu;

/**
 * The proposal against the text it was made from, as runs of kept, struck-out and inserted text («shoulder-length <del>wavy blonde</del>
 * <ins>straight platinum-white</ins> hair»). A longest common subsequence of the tokens; a lone space kept between two changes joins them, so a
 * changed phrase reads as one strike and one insert rather than a word-by-word ladder. Both texts are at most 600 chars (≈ 250 tokens).
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = before.match(TOKEN) ?? [];
  const b = after.match(TOKEN) ?? [];
  // lcs[i][j]: the common subsequence of a[i..] and b[j..].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    const row = lcs[i] ?? [];
    const below = lcs[i + 1] ?? [];
    for (let j = b.length - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
  }
  const steps: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const ai = a[i];
    const bj = b[j];
    if (ai !== undefined && bj !== undefined && ai === bj) {
      steps.push({ kind: "same", text: ai });
      i++;
      j++;
    } else if (bj !== undefined && (ai === undefined || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      steps.push({ kind: "ins", text: bj });
      j++;
    } else if (ai !== undefined) {
      steps.push({ kind: "del", text: ai });
      i++;
    }
  }
  return groupRuns(absorbSpaces(steps));
}

/** A space kept between two changes belongs to both: struck out on one side and inserted on the other. */
function absorbSpaces(steps: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  steps.forEach((step, k) => {
    const prev = steps[k - 1];
    const next = steps[k + 1];
    if (step.kind === "same" && /^\s+$/.test(step.text) && prev !== undefined && next !== undefined && prev.kind !== "same" && next.kind !== "same") {
      out.push({ kind: "del", text: step.text }, { kind: "ins", text: step.text });
    } else out.push(step);
  });
  return out;
}

/** Between two kept runs, every struck token goes into one strike and every inserted token into one insert, the strike first. */
function groupRuns(steps: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let del = "";
  let ins = "";
  const flush = (): void => {
    if (del !== "") out.push({ kind: "del", text: del });
    if (ins !== "") out.push({ kind: "ins", text: ins });
    del = "";
    ins = "";
  };
  for (const step of steps) {
    if (step.kind === "del") del += step.text;
    else if (step.kind === "ins") ins += step.text;
    else {
      flush();
      const last = out.at(-1);
      if (last?.kind === "same") out[out.length - 1] = { kind: "same", text: last.text + step.text };
      else out.push(step);
    }
  }
  flush();
  return out;
}
