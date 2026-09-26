import { Buffer } from "node:buffer";
import { z } from "zod";
import { sniffImageMediaType, type ImageMediaType } from "../library/media";
import { omitImageData } from "./redact";
import { RAW_KEEP_BYTES_IMAGE, runPaidAttempt, type ClientContext, type Interpretation } from "./transport";
import type { ImageParams, ImageResult } from "./types";

/** Lenient: only `data[0].b64_json` is required; everything else may be missing, null or unknown. */
const ImageEnvelope = z.object({ data: z.array(z.unknown()).min(1) });
const FirstImage = z.object({ b64_json: z.string().min(1) });

const DATA_URL_PREFIX = /^data:[^,]*,/;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** A JPEG as a data URL; throws for anything else, so a wrong reference is never sent. */
export function jpegDataUrl(bytes: Uint8Array, what: string): string {
  if (sniffImageMediaType(bytes) !== "image/jpeg") throw new TypeError(`${what} is not a JPEG`);
  return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
}

/** Strict base64 (standard or URL-safe, padding optional); null when it does not decode. */
function decodeBase64(text: string): Uint8Array | null {
  const compact = text.replace(DATA_URL_PREFIX, "").replace(/\s+/g, "");
  if (!BASE64.test(compact) || compact.replace(/=+$/, "").length % 4 === 1) return null;
  const bytes = Buffer.from(compact, "base64");
  return bytes.length > 0 ? new Uint8Array(bytes) : null;
}

function interpretImage(body: unknown): Interpretation<{ bytes: Uint8Array; mediaType: ImageMediaType }> {
  if (body === undefined) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "the body is not JSON" };
  const envelope = ImageEnvelope.safeParse(body);
  if (!envelope.success) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "the body has no data[0]" };
  const first = FirstImage.safeParse(envelope.data.data[0]);
  if (!first.success) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "data[0].b64_json is missing or empty" };
  const bytes = decodeBase64(first.data.b64_json);
  if (bytes === null) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "data[0].b64_json is not base64" };
  const mediaType = sniffImageMediaType(bytes);
  if (mediaType === null) return { ok: false, kind: "UNUSABLE_PAID_RESPONSE", why: "the image bytes are not PNG, JPEG or WebP" };
  return { ok: true, value: { bytes, mediaType } };
}

/** One image attempt via OpenRouter's Image API (`POST /images`). */
export async function generateImage(ctx: ClientContext, params: ImageParams): Promise<ImageResult> {
  const quality = params.quality ?? null;
  const worstMicros = params.priceBook.imageWorstCase({
    model: params.model,
    resolution: params.resolution,
    quality,
    refs: params.references.length,
  });
  const result = await runPaidAttempt(ctx, {
    attemptId: params.attemptId,
    jobId: params.jobId,
    scope: params.scope,
    model: params.model,
    worstMicros,
    budget: params.budget,
    signal: params.signal,
    path: "/images",
    buildBody: () => ({
      model: params.model,
      prompt: params.prompt,
      resolution: params.resolution,
      aspect_ratio: params.aspectRatio,
      ...(quality === null ? {} : { quality }),
      ...(params.references.length > 0
        ? { input_references: params.references.map((ref, i) => ({ type: "image_url", image_url: { url: jpegDataUrl(ref, `reference ${i}`) } })) }
        : {}),
    }),
    interpret: interpretImage,
    // An unusable image body may still hold a whole image that no age check has seen.
    scrubRaw: omitImageData,
    // A usable image is never text worth keeping long; a small cap is the
    // last line of defence against whatever escapes the scrub above.
    rawKeepBytes: RAW_KEEP_BYTES_IMAGE,
  });
  if (result.status !== "ok") return result;
  const { value, ...paid } = result;
  return { ...paid, bytes: value.bytes, mediaType: value.mediaType };
}
