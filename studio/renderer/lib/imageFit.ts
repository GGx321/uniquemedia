// The large-screen audit (H2): a picture is never drawn noticeably past its own pixels. The renderer is always served the original
// file and an imported master has no minimum size (the owner's is 246 × 281), so a frame that grows with the window, or a 2× screen,
// can stretch one picture pixel over two or three screen pixels: soft, then blocky. The rule is the same for every library picture:
// it may take at most `drawCap` CSS px, `MAX_UPSCALE` screen pixels per picture pixel at the screen's own pixel ratio. A picture that
// can fill its frame within that is drawn as before (cover); one that cannot is drawn at the cap, centred, and `coversFrame` tells
// the frame to fill the band around it.

export interface PixelSize {
  readonly width: number;
  readonly height: number;
}

/** How many screen pixels one picture pixel may be stretched over: the audit saw artefacts start around 1.3×, plainly soft by 2×. */
export const MAX_UPSCALE = 1.25;

/**
 * How far a cap may fall short of its frame, per side, and the frame still count as filled: 5 % of the side, at least 8 px. A band
 * thinner than that round a print reads as a sizing bug rather than a print, so the picture fills the frame instead, stretched at
 * most ~1.3× (1.25 / 0.95: the audit's threshold for artefacts) where the cap alone allows 1.25×.
 */
const BAND_SLACK_SHARE = 0.05;
const BAND_SLACK_MIN_PX = 8;

const slack = (side: number): number => Math.max(side * BAND_SLACK_SHARE, BAND_SLACK_MIN_PX);

const positive = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * The largest box, in CSS px, a picture of `natural` pixels may be drawn at on a screen of `dpr` screen pixels per CSS pixel without
 * any of its pixels stretched over more than `maxUpscale` screen pixels. Null while the natural size is unknown (not loaded yet, or a
 * picture without one): nothing caps it then. A pixel ratio or a limit that is not a positive number counts as 1 and `MAX_UPSCALE`.
 */
export function drawCap(natural: PixelSize, dpr: number, maxUpscale: number = MAX_UPSCALE): PixelSize | null {
  if (!positive(natural.width) || !positive(natural.height)) return null;
  const ratio = positive(dpr) ? dpr : 1;
  const limit = positive(maxUpscale) ? maxUpscale : MAX_UPSCALE;
  return { width: (natural.width * limit) / ratio, height: (natural.height * limit) / ratio };
}

/**
 * Whether a picture held to `cap` fills `frame` (CSS px) on both sides, or falls short by no more than the slack (then it is drawn
 * filling the frame all the same). No cap, or a frame not laid out yet, counts as filled.
 */
export function coversFrame(frame: PixelSize, cap: PixelSize | null): boolean {
  if (cap === null || !positive(frame.width) || !positive(frame.height)) return true;
  return cap.width >= frame.width - slack(frame.width) && cap.height >= frame.height - slack(frame.height);
}
