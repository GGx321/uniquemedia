import type { CaptionIssue, EngineError, TextLayer } from "../../shared/engine";
import { textPreviewUrl } from "../lib/media";
import type { EngineClient } from "./client";

// How the editor's text tab asks the engine for the picture of one text layer (`montages.textPreview`, plan 3b.4b, 3d.1b) and what
// it makes of the answer. The window asks again on every keystroke, so the engine drops a preview still waiting for its turn when
// a newer one of the same layer arrives and answers it TEXT_PREVIEW_SUPERSEDED. That is not an error: nothing is wrong, and the
// newer preview is on its way. It is told apart here, so no screen shows it as one (its Russian text says "no error" for the logs).

export type TextPreviewOutcome =
  /** The layer's picture: `url` is where the window shows it (null when the mock no longer holds it). */
  | { kind: "picture"; previewId: string; width: number; height: number; url: string | null }
  /** A newer preview of the layer replaced this one in the queue. Show nothing: the answer to the newer one is what the window waits for. */
  | { kind: "superseded" }
  /** The caption breaks a technical rule; the text has to change. */
  | { kind: "invalid"; captionIssue: CaptionIssue; error: EngineError }
  /** Anything else the engine said (the rasteriser timed out, nothing to draw, the text worker is down). */
  | { kind: "failed"; error: EngineError };

export async function requestTextPreview(client: EngineClient, avatarId: string, layer: TextLayer): Promise<TextPreviewOutcome> {
  const answer = await client.request("montages.textPreview", { avatarId, layer });
  if (answer.ok) return { kind: "picture", ...answer.result, url: textPreviewUrl(client, answer.result.previewId) };
  const { error } = answer;
  if (error.code === "TEXT_PREVIEW_SUPERSEDED") return { kind: "superseded" };
  if (error.code === "TEXT_INVALID" && error.captionIssue !== undefined) return { kind: "invalid", captionIssue: error.captionIssue, error };
  return { kind: "failed", error };
}
