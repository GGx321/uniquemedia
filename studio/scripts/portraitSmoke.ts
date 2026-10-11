// What the E2E smoke (smoke-engine.ts) checks of the reference portrait batch, as functions with no Electron in them: they are held by portraitSmoke.test.ts, and the smoke only has to call
// them with what its mock OpenRouter and the app reported.

/** The images in one batch of reference portraits. */
export const PORTRAIT_BATCH_SIZE = 5;

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

/**
 * What a batch of reference portraits sent, from the mock's recorded `/images` requests: exactly five, each 9:16 and each with exactly one `input_references` image (the imported photo).
 * Empty when it is right; otherwise one line per fault, with the number of the request (1-based).
 */
export function portraitBatchProblems(imageRequests: readonly { body: unknown }[]): string[] {
  const problems: string[] = [];
  if (imageRequests.length !== PORTRAIT_BATCH_SIZE) problems.push(`${imageRequests.length} image requests were sent, not ${PORTRAIT_BATCH_SIZE}`);
  imageRequests.forEach((request, i) => {
    const body = recordOf(request.body);
    if (body === null) {
      problems.push(`request ${i + 1} has no JSON body`);
      return;
    }
    const references = body.input_references;
    const count = Array.isArray(references) ? references.length : 0;
    if (count !== 1) problems.push(`request ${i + 1} carries ${count} input_references, not 1`);
    if (body.aspect_ratio !== "9:16") problems.push(`request ${i + 1} asks for ${String(body.aspect_ratio)}, not 9:16`);
  });
  return problems;
}

/** The facts the smoke reads before and after a refused batch: the image requests the mock saw, the reserves left open, and what the ledger has spent. */
export interface PortraitRefusalFacts {
  imageRequests: number;
  unsettledCount: number;
  spentMicros: number;
}

/** A batch refused for free: it came back with `expectedCode` (the source photo has no face), and nothing was requested, reserved or spent on the way. */
export function portraitSmokeProblems(code: string | undefined, before: PortraitRefusalFacts, after: PortraitRefusalFacts): string[] {
  const problems: string[] = [];
  if (code !== "MASTER_FACE_UNUSABLE") problems.push(`the batch was answered ${String(code)}, not MASTER_FACE_UNUSABLE`);
  if (after.imageRequests !== before.imageRequests) problems.push(`${after.imageRequests - before.imageRequests} image requests were sent`);
  if (after.unsettledCount !== before.unsettledCount) problems.push(`${after.unsettledCount - before.unsettledCount} reserves were left open`);
  if (after.spentMicros !== before.spentMicros) problems.push(`${after.spentMicros - before.spentMicros} micro-dollars were spent`);
  return problems;
}
