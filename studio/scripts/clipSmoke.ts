// What the E2E smoke (smoke-engine.ts) checks of a clip, as functions with no Electron in them: they are held by clipSmoke.test.ts, and the engine's own run against the mock OpenRouter by
// clipSmoke.engine.test.ts; the smoke only has to call them with what its mock and the app reported. Stage 5, 5b.1, S5.V7.

/** A `POST /videos` as the mock recorded it. */
export interface SentVideo {
  model: string | null;
}

/** One call of the mock's video routes (`MockVideoCall`). */
export interface VideoCall {
  kind: string;
  jobId: string | null;
  status: number;
}

const CLIP_ATTEMPT = /^.+:video#[12]$/;

/**
 * I5.44: one POST per attempt id, never resent. The ledger holds a `reserve` line for each attempt (`<clipId>:video#<n>`), and the mock saw exactly one `POST /videos` for each, of the model the
 * story expected, in the order the attempts ran. Empty when it is right; otherwise one line per fault.
 */
export function clipPostProblems(requests: readonly SentVideo[], attemptIds: readonly string[], expectedModels: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const id of attemptIds) {
    if (!CLIP_ATTEMPT.test(id)) problems.push(`${id} is not a clip attempt's id`);
    else if (seen.has(id)) problems.push(`attempt id ${id} was reserved twice`);
    seen.add(id);
  }
  if (requests.length !== attemptIds.length) problems.push(`${requests.length} POST /videos left for ${attemptIds.length} attempt ids: a POST is sent once per attempt`);
  expectedModels.forEach((model, i) => {
    const sent = requests[i];
    if (sent !== undefined && sent.model !== model) problems.push(`POST ${i + 1} named ${String(sent.model)}, not ${model}`);
  });
  return problems;
}

/**
 * Probe P0: a job the provider's risk control refused is polled, then proven free by TWO readings of `/generation`, each the API's own 404; nothing else of it is asked for: its file is never
 * fetched. Empty when it is right.
 */
export function refusedJobProblems(calls: readonly VideoCall[], jobId: string): string[] {
  const mine = calls.filter((c) => c.jobId === jobId);
  const problems: string[] = [];
  if (!mine.some((c) => c.kind === "poll")) problems.push("the refused job was never polled");
  const readings = mine.filter((c) => c.kind === "generation");
  for (const reading of readings) if (reading.status !== 404) problems.push(`the refused job had a /generation answer of ${reading.status}, not 404`);
  if (readings.length < 2) problems.push(`the refused job was read on /generation ${readings.length === 1 ? "once" : `${readings.length} times`}: the proof needs two readings`);
  if (mine.some((c) => c.kind === "content")) problems.push("the file of the refused job was asked for");
  return problems;
}

/** The exporter's verdict on a copy (`verifyClipExport`), as far as the smoke reads it. */
export interface ExportVerdict {
  ok: boolean;
  reasons: readonly { code: string; path?: string | undefined }[];
}

/** I5.55, I5.58: the export job named its copy `<avatar>/<date>_clip_<NNN>.mp4`, and the file passes the export's own verifier. */
export function exportedCopyProblems(relPath: string | undefined, verdict: ExportVerdict): string[] {
  if (relPath === undefined) return ["the export job named no copy"];
  const problems: string[] = [];
  if (!/^[^/]+\/\d{4}-\d{2}-\d{2}_clip_\d{3}\.mp4$/.test(relPath)) problems.push(`the copy's name ${relPath} is not <avatar>/<date>_clip_<NNN>.mp4`);
  if (!verdict.ok) problems.push(`the copy fails I5.58: ${verdict.reasons.map((r) => (r.path === undefined ? r.code : `${r.code} at ${r.path}`)).join("; ")}`);
  return problems;
}
