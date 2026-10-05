import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { useEngine } from "../engine/react";
import { coversFrame, drawCap, type PixelSize } from "../lib/imageFit";
import { photoUrl, placeholderGradient } from "../lib/media";
import { type ContentSize, observeSize } from "./observeSize";
import { useDevicePixelRatio } from "./useDevicePixelRatio";
import { useMediaRetry } from "./useMediaRetry";

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
 * A neutral stand-in: the mock engine has no images, and a real one may fail to load. A span (`.portrait` is laid out as a
 * box), so it may sit inside a button: the gallery tile's photo is one.
 */
export function PortraitPlaceholder({ seed, label }: { seed: string; label: string }) {
  return (
    <span className="portrait portrait-placeholder" role="img" aria-label={label} style={{ background: placeholderGradient(seed) }}>
      <Silhouette />
    </span>
  );
}


/** How a frame holds one picture: whether the picture's cap leaves a band now, and whether it ever has for this picture. */
interface FrameFit {
  readonly src: string;
  readonly banded: boolean;
  /** Its backdrop is kept from the first band on, hidden while the frame is filled, so a resize back and forth never remakes it. */
  readonly kept: boolean;
}

/**
 * Whether a picture held to `cap` leaves a band in its frame (`coversFrame`), and whether its backdrop is kept. Measured on the spot
 * when there is a cap (the picture has loaded), before the browser paints, then followed by the one shared observer as the frame
 * resizes (a window resize grows the avatar cards). A fit belongs to its picture: another photo starts with none.
 */
function useFrameFit(frame: RefObject<HTMLElement | null>, src: string | null, cap: PixelSize | null): { banded: boolean; backdrop: boolean } {
  const [fit, setFit] = useState<FrameFit | null>(null);
  const capWidth = cap?.width ?? null;
  const capHeight = cap?.height ?? null;
  useLayoutEffect(() => {
    const node = frame.current;
    if (src === null || capWidth === null || capHeight === null || node === null) return;
    const judge = (size: ContentSize): void => {
      const banded = !coversFrame(size, { width: capWidth, height: capHeight });
      setFit((now) => {
        const mine = now !== null && now.src === src;
        const kept = banded || (mine && now.kept);
        return mine && now.banded === banded && now.kept === kept ? now : { src, banded, kept };
      });
    };
    // The content box, as the observer reports it (a hover's scale is not a resize).
    judge({ width: node.clientWidth, height: node.clientHeight });
    return observeSize(node, judge);
  }, [frame, src, capWidth, capHeight]);
  const own = fit !== null && fit.src === src && cap !== null;
  return { banded: own && fit.banded, backdrop: own && fit.kept };
}

/**
 * A library photo through `studio-media://`, or a placeholder in mock mode or when it cannot load.
 *
 * The large-screen audit (H2): once loaded, the picture is never drawn noticeably past `drawCap` for the screen's pixel ratio. One
 * that can fill its frame within that (or within a few pixels of it, see `coversFrame`) is drawn as ever, covering the frame. One
 * that cannot (an imported master of a few hundred pixels in an avatar card on a 2× screen) is drawn at its cap, centred like a
 * print, and the band around it is the same picture blurred and dimmed: the frame keeps its size and colour, the grid its rhythm,
 * and nothing on screen is softer than the file itself.
 */
export function Portrait({ avatarId, photoId, label }: { avatarId: string; photoId: string; label: string }) {
  const { client } = useEngine();
  const [loaded, setLoaded] = useState<{ src: string; natural: PixelSize } | null>(null);
  const frame = useRef<HTMLSpanElement>(null);
  const src = photoUrl(avatarId, photoId);
  // A failure and a natural size belong to the picture they came from: another photo id gets its own chance and its own load. A failed load is tried once
  // more after a pause (a busy or slow disk answers 503/504, which an `<img>` cannot tell from a missing file) before it is a placeholder.
  const retry = useMediaRetry(src);
  const failed = retry.failed;
  const natural = loaded !== null && loaded.src === src && !failed ? loaded.natural : null;
  // The ratio is followed only once there is a picture whose cap depends on it.
  const dpr = useDevicePixelRatio(natural !== null);
  const cap = natural === null ? null : drawCap(natural, dpr);
  const { banded, backdrop } = useFrameFit(frame, src, cap);
  if (client.kind === "mock" || failed || retry.waiting || src === null) return <PortraitPlaceholder seed={photoId} label={label} />;
  // Held only when banded. Each side is held on its own: a frame wider than the cap but not taller (or the other way) gets a box of
  // the frame's height and the cap's width, and `cover` crops inside it; either way no side is stretched past the cap.
  const capStyle: CSSProperties | undefined = banded && cap !== null ? { maxWidth: `${cap.width}px`, maxHeight: `${cap.height}px` } : undefined;
  // Keyed by its address: another photo is a new element, so the last picture is never left on screen, uncapped, while it loads.
  return (
    <span ref={frame} className="portrait" data-fit={banded ? "capped" : undefined}>
      {backdrop && <img key={`backdrop-${src}`} className="portrait-backdrop" src={src} alt="" aria-hidden="true" decoding="async" draggable={false} />}
      <img
        key={`${src}#${retry.key}`}
        className="portrait-img"
        src={src}
        alt={label}
        loading="lazy"
        decoding="async"
        style={capStyle}
        onLoad={(e) => setLoaded({ src, natural: { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight } })}
        onError={retry.onError}
      />
    </span>
  );
}
