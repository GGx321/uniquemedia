import { useEffect, useRef, useState } from "react";
import type { TextLayer } from "../../../shared/engine";
import type { EngineClient } from "../../engine/client";
import { requestTextPreview } from "../../engine/textPreview";
import { answerCaption, askCaption, type CaptionCheck, NO_CHECK } from "./captionCheck";

/**
 * The engine's verdict on a text layer's caption (3d.5): `montages.textPreview` is asked again whenever what decides the picture
 * changes (the caption, the font, the style, the colour, the size), on every keystroke; the engine drops a queued ask that a newer
 * one of the same layer replaced (`superseded`, ignored). The answers go through `answerCaption`, so only the newest counts.
 * Mount it per layer (keyed by its id): a verdict belongs to one layer.
 */
export function useCaptionCheck(client: EngineClient, avatarId: string, layer: TextLayer): CaptionCheck {
  const [check, setCheck] = useState<CaptionCheck>(NO_CHECK);
  const current = useRef<CaptionCheck>(NO_CHECK);
  const latest = useRef(layer);
  latest.current = layer;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const look = JSON.stringify([layer.value, layer.font, layer.style, layer.color, layer.scale]);

  useEffect(() => {
    const asked = askCaption(current.current);
    current.current = asked.check;
    setCheck(asked.check);
    // An older ask's answer is still taken (it may be shown, marked pending, until the newest one comes): no cancel here.
    void requestTextPreview(client, avatarId, latest.current).then((outcome) => {
      if (!alive.current) return;
      current.current = answerCaption(current.current, asked.ask, outcome);
      setCheck(current.current);
    });
  }, [client, avatarId, look]);

  return check;
}
