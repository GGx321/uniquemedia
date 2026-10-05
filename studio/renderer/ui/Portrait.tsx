import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useEngine } from "../engine/react";
import { coversFrame, drawCap, type PixelSize } from "../lib/imageFit";
import { photoUrl, placeholderGradient } from "../lib/media";
import { useDevicePixelRatio } from "./useDevicePixelRatio";

/** The neutral figure over a placeholder; screens tint it with CSS (unreadable tiles, drawing slots). */
export function Silhouette() {
  return (
    <svg className="portrait-silhouette" viewBox="0 0 100 130" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">
      <g fill="#140c0a" opacity="0.34">
        <ellipse cx="50" cy="50" rx="19" ry="23" />
        <rect x="44" y="66" width="12" height="22" rx="4" />
        <path d="M12 130 C14 100 30 84 50 84 C70 84 86 100 88 130 Z" />
      </g>
    </svg>
  );
}

/**
 * A neutral stand-in: the mock engine has no images, and a real one may fail to load. A span (`.portrait` is a block), so it
 * may sit inside a button: the gallery tile's photo is one.
 */
export function PortraitPlaceholder({ seed, label }: { seed: string; label: string }) {
  return (
    <span className="portrait portrait-placeholder" role="img" aria-label={label} style={{ background: placeholderGradient(seed) }}>
      <Silhouette />
    </span>
  );
}

/**
 * Whether a picture held to `cap` leaves a band in its frame, followed as the frame resizes (a window resize grows the avatar
 * cards). Nothing is observed until there is a cap, that is until the picture has loaded.
 */
function useBanded(frame: RefObject<HTMLElement | null>, cap: PixelSize | null): boolean {
  const [banded, setBanded] = useState(false);
  const capWidth = cap?.width ?? null;
  const capHeight = cap?.height ?? null;
  useLayoutEffect(() => {
    const node = frame.current;
    if (capWidth === null || capHeight === null || node === null || typeof ResizeObserver === "undefined") {
      setBanded(false);
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const own = entries.find((entry) => entry.target === node);
      if (own === undefined) return;
      setBanded(!coversFrame({ width: own.contentRect.width, height: own.contentRect.height }, { width: capWidth, height: capHeight }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [frame, capWidth, capHeight]);
  return banded;
}

/**
 * A library photo through `studio-media://`, or a placeholder in mock mode or when it cannot load.
 *
 * The large-screen audit (H2): once loaded, the picture is never drawn past `drawCap` for the screen's pixel ratio. One that can fill
 * its frame within that is drawn as ever (cover, filling the frame). One that cannot (an imported master of a few hundred pixels in
 * a wide card on a 2× screen) is drawn at its cap, centred like a print, and the band around it is the same picture blurred and
 * dimmed: the frame keeps its size and colour, the grid its rhythm, and nothing on screen is softer than the file itself.
 */
export function Portrait({ avatarId, photoId, label }: { avatarId: string; photoId: string; label: string }) {
  const { client } = useEngine();
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState<{ src: string; natural: PixelSize } | null>(null);
  const frame = useRef<HTMLSpanElement>(null);
  const dpr = useDevicePixelRatio();
  const src = photoUrl(avatarId, photoId);
  // A natural size belongs to the picture it was read from: a new photo id waits for its own load.
  const natural = loaded !== null && loaded.src === src ? loaded.natural : null;
  const cap = natural === null ? null : drawCap(natural, dpr);
  const banded = useBanded(frame, cap);
  if (client.kind === "mock" || failed || src === null) return <PortraitPlaceholder seed={photoId} label={label} />;
  const capStyle: CSSProperties | undefined = cap === null ? undefined : { maxWidth: `${cap.width}px`, maxHeight: `${cap.height}px` };
  return (
    <span ref={frame} className="portrait" data-fit={banded ? "capped" : undefined}>
      {banded && <img className="portrait-backdrop" src={src} alt="" aria-hidden="true" decoding="async" draggable={false} />}
      <img
        className="portrait-img"
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        style={capStyle}
        onLoad={(e) => setLoaded({ src, natural: { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight } })}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
