import { CHECK_ASPECTS, type CheckAspect, type DescriptorCheck } from "../../../shared/engine";
import { isActiveJob, type EngineView, type JobView } from "../../engine/store";
import { paidStop } from "../../lib/paidStop";
import type { LookLanding, SettingsFocus } from "../../navigation";

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
 * Where the import's reference portraits stand, for the landing line (S5.3d, design decision 8): `drawing` while the batch the import started runs (15),
 * `ready` once it ended with portraits to choose from (16, 16b, 16e, 16f, 19a); null otherwise (none started, or none came: 17, 18, 18b, 23).
 */
export type LandingPortraits = "drawing" | "ready" | null;

/**
 * The line over the tab right after the avatar was made, as the mockup's 05, 06 and 11 say it. `bodyWaits` (S5.2d): an import's body proposal is still
 * open, so the line says the body is left to do. `portraits` (S5.3d): an import's reference portraits, said after it.
 */
export function landingText(landing: LookLanding, name: string, bodyWaits: boolean, portraits: LandingPortraits = null): string {
  if (landing.kind === "created") return `Аватар «${name}» сохранён. Мастер-портрет готов для фото.`;
  const tail = portraits === "drawing" ? " Рисуем варианты мастер-портрета." : portraits === "ready" ? " Варианты готовы — выберите мастер-портрет." : "";
  return `${importedText(landing.check, name, bodyWaits)}${tail}`;
}

function importedText(check: DescriptorCheck | null, name: string, bodyWaits: boolean): string {
  const head = `Аватар «${name}» импортирован.`;
  if (check === null) return bodyWaits ? `${head} Описание прочитано с фото — осталось тело.` : `${head} Описание прочитано с фото.`;
  if (check.matches) return bodyWaits ? `${head} Описание прочитано с фото и сверено с ним — осталось тело.` : `${head} Описание прочитано с фото и сверено с ним.`;
  return bodyWaits ? `${head} Описание прочитано с фото — проверьте тело и сверку.` : `${head} Описание прочитано с фото — проверьте сверку.`;
}

/** S5.2d: `avatars.setBody` (or «Не нужно») refused IN_FLIGHT, or waiting for this window's own check: the same claim as an edit. */
export const BODY_HELD_REASON = "Тело можно сохранить, когда закончится сверка или другая задача этого аватара";

/** The jobs that hold an avatar while they run: a photo run, a candidates batch and (S5.3d) a reference-portrait batch, which claims her like a run. */
const HOLDING_KINDS: ReadonlySet<JobView["kind"]> = new Set(["run", "avatar.candidates", "avatar.portraits"]);

/**
 * Whether this window knows of work that holds the avatar, so the paid check would be refused IN_FLIGHT: a photo run, a candidates batch or a portrait
 * batch of hers that is queued or running, or a paid start of hers on its way. A launch holds her through its own runs, which are run jobs. What the
 * window cannot see (a check from another window, a launch between its steps) still comes back as IN_FLIGHT, and the card says the same thing then.
 */
export function avatarHeld(view: Pick<EngineView, "jobs" | "paidInFlightAvatars">, avatarId: string): boolean {
  if (view.paidInFlightAvatars.has(avatarId)) return true;
  return view.jobs.some((job) => job.avatarId === avatarId && HOLDING_KINDS.has(job.kind) && isActiveJob(job));
}

/**
 * S5.3d: where in Settings the paid stop is fixed, when it is the key (an engine away is said first, `paidBlockedReason`'s order) or a reconcile: the
 * button beside the reason the card gives. Null for any other stop and for none.
 */
export function paidSettingsFocus(view: Pick<EngineView, "phase" | "money" | "engineError" | "settings">): SettingsFocus | null {
  const stop = paidStop(view);
  const key = view.settings?.apiKey;
  if (stop?.kind !== "offline" && (key === undefined || !key.stored || key.rejected)) return "key";
  return stop?.kind === "reconcile" ? "money" : null;
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
 * The proposal against the text it was made from, as runs of kept, struck-out and inserted text, the way the mockup's 10 draws it:
 * «shoulder-length <del>wavy blonde hair</del> <ins>straight platinum-white hair with choppy layers and bangs</ins>, a small mole». A longest
 * common subsequence of the tokens; then a kept run of at most one word (no punctuation) between two changes joins them, so a changed phrase reads
 * as one strike and one insert rather than a word-by-word ladder, and the spaces a strike and its insert share at their edges stay kept text.
 * Both texts are at most 600 chars (≈ 250 tokens).
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
  return trimEdges(groupRuns(joinChanges(steps)));
}

/** A kept run two changes may swallow: spaces only, or one word with its spaces — never a comma or another mark that divides the text. */
const JOINABLE = /^\s*(?:[\p{L}\p{N}'-]+\s*)?$/u;

/** A short kept run between two changes belongs to both: struck out on one side and inserted on the other. */
function joinChanges(steps: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  let k = 0;
  while (k < steps.length) {
    const step = steps[k];
    if (step === undefined) break;
    if (step.kind !== "same") {
      out.push(step);
      k++;
      continue;
    }
    let end = k;
    let run = "";
    for (let s = steps[end]; s?.kind === "same"; s = steps[++end]) run += s.text;
    // Maximal runs: a step before `k` and one at `end` are both changes.
    if (k > 0 && end < steps.length && JOINABLE.test(run)) out.push({ kind: "del", text: run }, { kind: "ins", text: run });
    else out.push({ kind: "same", text: run });
    k = end;
  }
  return out;
}

/** The longest run of spaces at the start (`end` false) or the end of a text. */
function edgeSpace(text: string, end: boolean): string {
  return (end ? /\s*$/u : /^\s*/u).exec(text)?.[0] ?? "";
}

/** The common prefix (or suffix) of two runs of spaces. */
function shared(a: string, b: string, end: boolean): string {
  let n = 0;
  while (n < a.length && n < b.length && (end ? a[a.length - 1 - n] === b[b.length - 1 - n] : a[n] === b[n])) n++;
  return end ? a.slice(a.length - n) : a.slice(0, n);
}

/** A strike and its insert that start or end with the same spaces give them back to the kept text around them. */
function trimEdges(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  const keep = (text: string): void => {
    if (text === "") return;
    const last = out.at(-1);
    if (last?.kind === "same") out[out.length - 1] = { kind: "same", text: last.text + text };
    else out.push({ kind: "same", text });
  };
  for (let k = 0; k < parts.length; k++) {
    const part = parts[k];
    const next = parts[k + 1];
    if (part === undefined) break;
    if (part.kind === "same") keep(part.text);
    else if (part.kind === "del" && next?.kind === "ins") {
      const lead = shared(edgeSpace(part.text, false), edgeSpace(next.text, false), false);
      const del = part.text.slice(lead.length);
      const ins = next.text.slice(lead.length);
      const trail = shared(edgeSpace(del, true), edgeSpace(ins, true), true);
      keep(lead);
      if (del.length > trail.length) out.push({ kind: "del", text: del.slice(0, del.length - trail.length) });
      if (ins.length > trail.length) out.push({ kind: "ins", text: ins.slice(0, ins.length - trail.length) });
      keep(trail);
      k++;
    } else out.push(part);
  }
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
