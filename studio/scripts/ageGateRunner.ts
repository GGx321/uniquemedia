#!/usr/bin/env bun
/**
 * Age-gate calibration runner for the owner (Stage 2 plan, T6a-2b mandatory
 * item (1)): "the owner checks the image age gate himself ... the spike
 * only showed 83/83 adults pass, never that younger-looking images are
 * refused". This tool runs the ENGINE's own age check — the same question,
 * JSON schema, model, reasoning effort, downscale and pass rule
 * (studio/engine/avatars/ageCheck.ts's `ageCheckMessages()` /
 * `ageJsonSchema()` / `readAgeAnswer()`, and studio/engine/avatars/
 * candidateJob.ts's `ageGate`'s exact request shape) — over every image in
 * a folder the owner passes, so he can see real pass/fail/confidence
 * numbers before picking a threshold.
 *
 * This is a standalone calibration tool, never wired into any avatar or
 * photo job: it makes its own paid calls directly against the real
 * OpenRouter API, spends real money, and is never run by a test (unit tests
 * inject a fake fetch; see ageGateRunner.test.ts) or by an agent — only the
 * owner, by hand, decides to spend.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-v1-... bun studio/scripts/ageGateRunner.ts <folder> --dry-run
 *   OPENROUTER_API_KEY=sk-or-v1-... bun studio/scripts/ageGateRunner.ts <folder> --yes [--max 50] [--csv out.csv]
 *
 * The key is read only from the OPENROUTER_API_KEY environment variable and
 * is never printed, logged, or written to the CSV — it reaches only the
 * Authorization header of the age-check request itself; any error text this
 * tool prints or writes is scrubbed through the engine's own key redaction
 * first, in case OpenRouter ever echoes the key back in an error body.
 *
 * Do not run this between the canary's baseline reconcile and its final
 * reconcile (docs/studio/2026-09-24-stage-2-plan.md, Canary runbook): its
 * spend is on the same OpenRouter account but never enters the Studio
 * ledger, so it would show up as a false mismatch. Run it well before step 2
 * of that runbook, or with a separate OpenRouter key.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { AGE_CHECK_MAX_SIDE, ageCheckMessages, ageJsonSchema, readAgeAnswer, type AgeRejection } from "../engine/avatars/ageCheck";
import { AGE_CHECK_CALL } from "../engine/money/estimate";
import { OPENROUTER_API_BASE, PriceBook } from "../engine/money/prices";
import { chatAttemptWorstMicros, type ChatPriceShape } from "../engine/openrouter/chat";
import { jpegDataUrl } from "../engine/openrouter/image";
import { makeRedactor } from "../engine/openrouter/redact";
import { downscaleToJpeg } from "../node/downscale";

/**
 * studio/engine/avatars/candidateJob.ts's `PREPARE_TIMEOUT_MS` and
 * studio/engine/money/budget.ts's / studio/engine/engine.ts's
 * `REQUEST_TIMEOUT_MS`, reproduced (neither engine file is imported here just
 * for a constant): how long downscaling one image, and one age-check
 * request, may take. A timeout ends that image's attempt; it is never
 * retried — this tool sends each image's age check at most once.
 */
export const DEFAULT_TIMEOUTS = { prepareMs: 30_000, requestMs: 180_000 };

// ---------- the engine's own request shape (kept in sync by hand: neither
// candidateJob.ts's private `ageCheckShape` nor chat.ts's private
// `wireMessages` is exported, so this mirrors them rather than importing
// them) ----------

/** studio/engine/avatars/candidateJob.ts's private `ageCheckShape`, reproduced: what the age check's price depends on. */
function ageCheckShape(): ChatPriceShape {
  return {
    model: AGE_CHECK_CALL.model,
    messages: ageCheckMessages(),
    jsonSchema: ageJsonSchema(),
    maxTokens: AGE_CHECK_CALL.maxTokens,
    inputTokens: AGE_CHECK_CALL.inputTokens,
    images: AGE_CHECK_CALL.images,
  };
}

/**
 * The exact `POST /chat/completions` body the engine's `chat()` sends for an
 * age check (studio/engine/openrouter/chat.ts's `buildBody` + its private
 * `wireMessages`, with `reasoningEffort: "low"` as candidateJob.ts's
 * `ageGate` always passes): the system line verbatim, the question with the
 * image attached as the last user message's second part, the same schema,
 * `max_tokens`, `reasoning.effort` and `usage.include`.
 */
export function ageCheckRequestBody(jpeg: Uint8Array): Record<string, unknown> {
  const [system, user] = ageCheckMessages();
  if (system === undefined || user === undefined) throw new Error("ageCheckMessages() must return exactly [system, user]");
  const schema = ageJsonSchema();
  return {
    model: AGE_CHECK_CALL.model,
    messages: [
      { role: system.role, content: system.content },
      {
        role: user.role,
        content: [
          { type: "text", text: user.content },
          { type: "image_url", image_url: { url: jpegDataUrl(jpeg, "the age-check image") } },
        ],
      },
    ],
    max_tokens: AGE_CHECK_CALL.maxTokens,
    reasoning: { effort: "low" },
    usage: { include: true },
    response_format: { type: "json_schema", json_schema: { name: schema.name, strict: true, schema: schema.schema } },
  };
}

// ---------- plan and refusals ----------

export interface Plan {
  folder: string;
  images: string[];
  /** The age-check worst case per image, from the engine's own price math (money/prices.ts's fallback table: no network needed to plan). */
  worstMicrosPerImage: number;
  worstMicrosTotal: number;
  /** money/prices.ts's `FALLBACK_PRICES_DATE`: how old the fallback price table this plan used is. */
  fallbackDate: string | null;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/** Every image file directly in `folder` (not recursive), sorted for a deterministic plan. */
export async function listImages(folder: string): Promise<string[]> {
  const entries = await readdir(folder, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && IMAGE_EXTENSIONS.has(extname(e.name).toLowerCase()))
    .map((e) => e.name)
    .sort();
}

export function planFor(folder: string, images: string[]): Plan {
  const priceBook = PriceBook.fallback();
  const worstMicrosPerImage = chatAttemptWorstMicros(priceBook, ageCheckShape());
  return { folder, images, worstMicrosPerImage, worstMicrosTotal: worstMicrosPerImage * images.length, fallbackDate: priceBook.fallbackDate };
}

export type Refusal =
  | { reason: "OVER_MAX"; count: number; max: number }
  | { reason: "NO_KEY" }
  | { reason: "NO_YES" };

/** Checked in this order: a folder too big to run at all, then the two spending gates. Never called for --dry-run. */
export function checkRefusal(plan: Plan, opts: { yes: boolean; max: number }, apiKey: string | undefined): Refusal | null {
  if (plan.images.length > opts.max) return { reason: "OVER_MAX", count: plan.images.length, max: opts.max };
  if (apiKey === undefined || apiKey.trim() === "") return { reason: "NO_KEY" };
  if (!opts.yes) return { reason: "NO_YES" };
  return null;
}

// ---------- args ----------

export interface AgeGateOptions {
  folder: string;
  yes: boolean;
  max: number;
  dryRun: boolean;
  csvPath: string | null;
  help: boolean;
}

export function parseArgs(argv: readonly string[]): AgeGateOptions {
  let folder: string | null = null;
  let yes = false;
  let max = 50;
  let dryRun = false;
  let csvPath: string | null = null;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--yes") yes = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--max") max = Number(argv[++i]);
    else if (arg === "--csv") {
      const value = argv[++i];
      if (value === undefined) throw new Error("--csv needs a path");
      csvPath = value;
    } else if (!arg.startsWith("-") && folder === null) folder = arg;
    else throw new Error(`unknown or unexpected argument: ${arg}`);
  }
  if (!help && folder === null) throw new Error("a folder is required");
  if (!Number.isSafeInteger(max) || max < 1) throw new Error(`--max must be a positive integer, got ${String(max)}`);
  return { folder: folder ?? "", yes, max, dryRun, csvPath, help };
}

function printUsage(): void {
  console.log(
    "Usage: OPENROUTER_API_KEY=sk-or-v1-... bun studio/scripts/ageGateRunner.ts <folder> [options]\n\n" +
      "Options:\n" +
      "  --dry-run       print only the plan and the worst-case estimate; no key, no --yes, no network call\n" +
      "  --yes           required to actually spend money on real age checks\n" +
      "  --max <n>       refuse to run over this many images (default 50)\n" +
      "  --csv <path>    also write the per-image results to this CSV file\n" +
      "  --help          show this message\n\n" +
      "The key is read from OPENROUTER_API_KEY and is never printed or written to the CSV.",
  );
}

// ---------- one image ----------

export type AgeGateVerdict = "pass" | AgeRejection | "read-failed" | "request-failed" | "age-check-refused" | "empty-answer";

export interface AgeGateRow {
  file: string;
  /** The raw answer's own fields, for the owner to sort by confidence — independent of `verdict`, which is the engine's authoritative pass rule. */
  adult: boolean | null;
  confidence: number | null;
  reason: string | null;
  /**
   * "pass"; one of readAgeAnswer's own rejection reasons; "age-check-refused"
   * / "empty-answer" mirroring candidateJob.ts:278-279's slot outcomes for a
   * moderation refusal or an empty paid answer; or this tool's own
   * "read-failed" / "request-failed".
   */
  verdict: AgeGateVerdict;
  /** Scrubbed through the engine's own key redaction (openrouter/redact.ts) before it is ever printed or written to CSV. */
  detail?: string;
}

export interface AgeGateFetch {
  (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<{ status: number; json(): Promise<unknown> }>;
}

/** `error instanceof Error` misses DOMException (an `AbortSignal.timeout()` rejection), which has no `.message` guarantee otherwise. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

type ContentResult = { kind: "ok"; content: string } | { kind: "empty" } | { kind: "missing" };

/**
 * `choices[0].message.content`, read as leniently as the engine's own
 * `interpretChat` (openrouter/chat.ts, not exported) distinguishes the same
 * two failure modes it does: "missing" when the envelope itself does not
 * have a usable `choices[0].message` (UNUSABLE_PAID_RESPONSE there);
 * "empty" when the message exists but its content is null, undefined or ""
 * (EMPTY_CONTENT there — candidateJob.ts's `ageGate` reports this as the
 * slot outcome `rejected: "empty-answer"`, mirrored by this tool's verdict
 * of the same name).
 */
function contentOf(body: unknown): ContentResult {
  if (typeof body !== "object" || body === null) return { kind: "missing" };
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return { kind: "missing" };
  const first = choices[0];
  if (typeof first !== "object" || first === null) return { kind: "missing" };
  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null) return { kind: "missing" };
  const content = (message as Record<string, unknown>).content;
  if (content === null || content === undefined || content === "") return { kind: "empty" };
  return typeof content === "string" ? { kind: "ok", content } : { kind: "missing" };
}

/**
 * studio/engine/openrouter/transport.ts's private `isModerationRefusal`,
 * reproduced: a 400/403/422 whose body reads as a moderation refusal, not a
 * real failure — the engine's client reports this as `status: "refused"`,
 * and candidateJob.ts's `ageGate` turns that into the slot outcome
 * `rejected: "age-check-refused"`, mirrored here by the same verdict name.
 */
const MODERATION_MESSAGE = /content moderation|blocked this request|flagged|content[ _]polic|nsfw|sensitive (?:content|information)/i;
const PROVIDER_MODERATION_CODE = /SensitiveContent/;

function looksLikeModerationRefusal(status: number, body: unknown): boolean {
  if (status !== 400 && status !== 403 && status !== 422) return false;
  if (typeof body !== "object" || body === null) return false;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return false;
  const message = (error as Record<string, unknown>).message;
  if (typeof message === "string" && MODERATION_MESSAGE.test(message)) return true;
  const metadata = (error as Record<string, unknown>).metadata;
  const raw = typeof metadata === "object" && metadata !== null ? (metadata as Record<string, unknown>).raw : undefined;
  const rawText = typeof raw === "string" ? raw : raw === undefined || raw === null ? "" : JSON.stringify(raw);
  return PROVIDER_MODERATION_CODE.test(rawText);
}

/**
 * The answer's own `adult`/`confidence`/`reason`, for display only (sortable
 * by the owner) — never the pass/fail authority, which is `readAgeAnswer`
 * alone. A confidence above 1 is read as a percentage, exactly as the
 * engine's own (unexported) `AgeAnswer` schema does; anything unreadable
 * here answers all-null, independent of what `readAgeAnswer` decides.
 */
function rawAnswerFields(content: string): { adult: boolean | null; confidence: number | null; reason: string | null } {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) return { adult: null, confidence: null, reason: null };
    const obj = parsed as Record<string, unknown>;
    const adult = typeof obj.adult === "boolean" ? obj.adult : null;
    const rawConfidence = typeof obj.confidence === "number" ? obj.confidence : null;
    const confidence = rawConfidence === null ? null : rawConfidence > 1 ? rawConfidence / 100 : rawConfidence;
    const reason = typeof obj.reason === "string" ? obj.reason : null;
    return { adult, confidence, reason };
  } catch {
    return { adult: null, confidence: null, reason: null };
  }
}

/**
 * One image, end to end: downscale it exactly as the engine does for an age
 * check (AGE_CHECK_MAX_SIDE, studio/node/downscale.ts's ffmpeg pipeline),
 * send the engine's own request shape, and read the answer with the
 * engine's own pass rule (`readAgeAnswer`). Never throws: every failure is a
 * row, and every `detail` is redacted before it comes back.
 *
 * Bounded like the engine's own paid attempt: downscaling may take at most
 * `timeouts.prepareMs`, the request at most `timeouts.requestMs`. A timeout
 * only ends that image's own attempt — it is never retried, here or by any
 * caller of this function.
 */
export async function checkOneImage(
  fetchFn: AgeGateFetch,
  apiKey: string,
  filePath: string,
  timeouts: { prepareMs: number; requestMs: number } = DEFAULT_TIMEOUTS,
): Promise<AgeGateRow> {
  const file = basename(filePath);
  const redact = makeRedactor(apiKey);
  const row = (partial: Omit<AgeGateRow, "file" | "detail"> & { detail?: string }): AgeGateRow => ({
    file,
    ...partial,
    ...(partial.detail === undefined ? {} : { detail: redact(partial.detail) }),
  });

  let jpeg: Uint8Array;
  try {
    const bytes = new Uint8Array(await readFile(filePath));
    jpeg = await downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal: AbortSignal.timeout(timeouts.prepareMs) });
  } catch (error) {
    return row({ adult: null, confidence: null, reason: null, verdict: "read-failed", detail: messageOf(error) });
  }

  let res: { status: number; json(): Promise<unknown> };
  try {
    res = await fetchFn(`${OPENROUTER_API_BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(ageCheckRequestBody(jpeg)),
      signal: AbortSignal.timeout(timeouts.requestMs),
    });
  } catch (error) {
    return row({ adult: null, confidence: null, reason: null, verdict: "request-failed", detail: messageOf(error) });
  }
  const body = await res.json().catch(() => null);
  if (res.status !== 200) {
    if (looksLikeModerationRefusal(res.status, body)) {
      return row({ adult: null, confidence: null, reason: null, verdict: "age-check-refused", detail: `HTTP ${res.status}: a moderation refusal` });
    }
    return row({ adult: null, confidence: null, reason: null, verdict: "request-failed", detail: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}` });
  }
  const contentResult = contentOf(body);
  if (contentResult.kind === "missing") {
    return row({ adult: null, confidence: null, reason: null, verdict: "unreadable", detail: "no choices[0].message.content in the response" });
  }
  if (contentResult.kind === "empty") {
    return row({ adult: null, confidence: null, reason: null, verdict: "empty-answer", detail: "the message has no content" });
  }
  const raw = rawAnswerFields(contentResult.content);
  const verdict = readAgeAnswer(contentResult.content);
  return row({ adult: raw.adult, confidence: raw.confidence, reason: raw.reason, verdict: verdict.pass ? "pass" : verdict.why });
}

// ---------- output ----------

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(6)}`;
}

function printPlan(plan: Plan, max: number): void {
  console.log(`age gate calibration: ${plan.images.length} image(s) in ${plan.folder}`);
  console.log(
    `worst case (engine price math, fallback table dated ${plan.fallbackDate ?? "unknown"}): ${usd(plan.worstMicrosPerImage)} per image, ${usd(plan.worstMicrosTotal)} total (cap --max ${max})`,
  );
  console.log(
    "NOTE: never run this between the canary runbook's step 2 (baseline reconcile) and step 5 (final reconcile) — " +
      "its spend never enters the Studio ledger and would show up there as a false mismatch; run it before step 2, or with a separate OpenRouter key.",
  );
}

function printRefusal(refusal: Refusal): void {
  switch (refusal.reason) {
    case "OVER_MAX":
      console.error(`refusing to run: ${refusal.count} images is over --max ${refusal.max}; pass a higher --max to proceed`);
      break;
    case "NO_KEY":
      console.error("refusing to spend: no OPENROUTER_API_KEY in the environment");
      break;
    case "NO_YES":
      console.error("refusing to spend without --yes");
      break;
  }
}

function printRow(row: AgeGateRow): void {
  const pass = row.verdict === "pass";
  const suffix = row.detail === undefined ? "" : ` (${row.detail})`;
  console.log(`${pass ? "PASS" : "FAIL"}  ${row.file}  adult=${row.adult ?? "?"}  confidence=${row.confidence ?? "?"}  verdict=${row.verdict}${suffix}`);
}

function printSummary(rows: AgeGateRow[]): void {
  const passed = rows.filter((r) => r.verdict === "pass").length;
  console.log(`\n${passed}/${rows.length} passed the age gate`);
  const byVerdict = new Map<string, number>();
  for (const row of rows) {
    if (row.verdict === "pass") continue;
    byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
  }
  for (const [verdict, count] of byVerdict) console.log(`  ${verdict}: ${count}`);
}

function csvField(value: string | number | boolean | null | undefined): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: AgeGateRow[]): string {
  const header = ["file", "adult", "confidence", "reason", "verdict", "detail"];
  const lines = rows.map((r) => [r.file, r.adult, r.confidence, r.reason, r.verdict, r.detail].map(csvField).join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}

// ---------- main ----------

async function main(): Promise<void> {
  let opts: AgeGateOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(messageOf(error));
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    printUsage();
    return;
  }

  const images = await listImages(opts.folder);
  const plan = planFor(opts.folder, images);
  printPlan(plan, opts.max);
  if (opts.dryRun) return;

  // Read only here, at the very last moment before it would be used, and
  // never logged: `apiKey` is used only in the Authorization header below.
  const apiKey = process.env.OPENROUTER_API_KEY;
  const refusal = checkRefusal(plan, opts, apiKey);
  if (refusal !== null) {
    printRefusal(refusal);
    process.exitCode = 1;
    return;
  }

  const doFetch: AgeGateFetch = (url, init) => fetch(url, init);
  const rows: AgeGateRow[] = [];
  for (const file of images) {
    const row = await checkOneImage(doFetch, apiKey as string, join(opts.folder, file));
    rows.push(row);
    printRow(row);
  }
  printSummary(rows);
  if (opts.csvPath !== null) {
    await writeFile(opts.csvPath, toCsv(rows), "utf8");
    console.log(`\nwrote ${opts.csvPath}`);
  }
}

if (import.meta.main) await main();
