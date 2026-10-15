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

// ---------- 5b.2, S5.WB3: a batch ----------

/** A ledger line as the smoke reads it: the type and the attempt it belongs to. */
export interface BatchLedgerLine {
  type: string;
  attemptId: string;
}

/**
 * I5.61: a batch is one clip money unit at a time. The ledger's clip lines show it: the reserves are those of the attempts the batch made, in the order they ran (`attemptIds`), and no attempt was
 * reserved while another was still open (a `settle` or a `release` closes one). Empty when it is right; otherwise one line per fault.
 */
export function batchLedgerProblems(lines: readonly BatchLedgerLine[], attemptIds: readonly string[]): string[] {
  const problems: string[] = [];
  const open = new Set<string>();
  const reserved: string[] = [];
  for (const line of lines) {
    if (!CLIP_ATTEMPT.test(line.attemptId)) continue;
    if (line.type === "reserve") {
      const [other] = open;
      if (other !== undefined) problems.push(`${line.attemptId} was reserved while ${other} was still open: a batch runs one clip money unit at a time`);
      open.add(line.attemptId);
      reserved.push(line.attemptId);
    } else if (line.type === "settle" || line.type === "release") open.delete(line.attemptId);
  }
  if (reserved.join(", ") !== attemptIds.join(", ")) problems.push(`the reserves are ${reserved.join(", ")}, not ${attemptIds.join(", ")}`);
  return problems;
}

/** A clip as `clips.list` tells it, as far as a batch's header reads it. */
export interface BatchClip {
  clipId: string;
  batchId?: string | undefined;
  batchIndex?: number | undefined;
  batchSize?: number | undefined;
}

/**
 * I5.63 (L9): every member's record tells the batch it was made in, its place and the batch's size, so the «Клипы» header survives the job registry. `clips` are the batch's members as `clips.list` tells
 * them (one clip per member here: no 429 requeue). Empty when it is right; otherwise one line per fault.
 */
export function batchClipProblems(clips: readonly BatchClip[], batchId: string, size: number): string[] {
  const problems: string[] = [];
  const places: number[] = [];
  for (const clip of clips) {
    if (clip.batchId === undefined || clip.batchIndex === undefined || clip.batchSize === undefined) {
      problems.push(`clip ${clip.clipId} tells no place in the batch`);
      continue;
    }
    if (clip.batchId !== batchId) {
      problems.push(`clip ${clip.clipId} belongs to batch ${clip.batchId}, not ${batchId}`);
      continue;
    }
    if (clip.batchSize !== size) problems.push(`clip ${clip.clipId} says the batch has ${clip.batchSize} clips, not ${size}`);
    places.push(clip.batchIndex);
  }
  const wanted = Array.from({ length: size }, (_, i) => i + 1);
  const told = [...places].sort((a, b) => a - b);
  if (told.join(", ") !== wanted.join(", ")) problems.push(`the places told are ${told.join(", ")}, not 1 to ${size}`);
  return problems;
}
