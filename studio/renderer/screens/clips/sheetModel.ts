import { clipOptionKey, type ClipMotionId, type ClipOptionKey, type ClipOptions, type ClipQuality, type ClipSeconds, type Estimate } from "../../../shared/engine";
import { nearUsd, upUsd } from "./clipModel";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §6 38, 38c, 38e; README §S5.VD «Деньги на экране», decisions 12–14): what the «Оживить фото» sheet shows for the option on show, read off the
// engine's `clips.options` alone. The price line and both buttons' ceilings are the engine's estimates, what fits the month is its `monthFits` (the figure `clips.create` checks, I5.47),
// and the lines under the price follow its `fallback` and `bold`. Nothing here adds, subtracts or compares money.

export type SuitableOptions = Extract<ClipOptions, { suitable: true }>;

export interface SheetChoice {
  readonly motionId: ClipMotionId;
  readonly quality: ClipQuality;
  readonly seconds: ClipSeconds;
}

export interface SheetButton {
  /** The accepted worst a click sends: the engine's figure for this option. */
  readonly worstMicros: number;
  /** «до $0.85». */
  readonly label: string;
}

export interface SheetView {
  readonly key: ClipOptionKey;
  /** «Kling 3.0 · 720p», on «Чётче» «Kling 3.0 · 1080p» (the approved 38's label; the owner's decision for V8). */
  readonly modelLine: string;
  /** «Запасная модель (Grok) снимает в 720p»: «Чётче» in mode auto, where Grok may run behind Kling (decision 12). */
  readonly proNote: boolean;
  /** The estimate the price line and the main button show. */
  readonly estimate: Estimate;
  /** «Обычно $0.42 · не больше $0.85». */
  readonly expected: string;
  readonly worst: string;
  /** «Если Kling откажет бесплатно, клип снимет Grok…»: mode auto only. */
  readonly autoNote: boolean;
  /** «Для кадров «Смелой» запасной модели нет…» in place of the Grok line (38e, I5.57). */
  readonly boldNote: boolean;
  /** The month takes the option as the main button sends it. */
  readonly fits: boolean;
  readonly main: SheetButton;
  /** «Оживить без запасной модели · до $0.51» (38c): mode auto, the month holds Kling alone and not Kling + Grok. */
  readonly noFallback: SheetButton | null;
  /** 38c's notice, «клипу нужно до $0.85», while the main button waits; null when it fits. */
  readonly budgetNeed: string | null;
}

export function sheetView(options: SuitableOptions, choice: SheetChoice): SheetView {
  const key = clipOptionKey(choice.quality, choice.seconds);
  const estimate = options.prices[key];
  const auto = options.fallback === "auto";
  const fit = options.monthFits[key];
  // Mode auto fits with Grok's reserve behind Kling; mode offer and a frame of «Смелая» send Kling alone, which `without-fallback` says fits.
  const fits = auto ? fit === "with-fallback" : fit !== "none";
  const klingAlone = options.noFallbackPrices[key];
  return {
    key,
    modelLine: choice.quality === "pro" ? "Kling 3.0 · 1080p" : "Kling 3.0 · 720p",
    proNote: auto && choice.quality === "pro",
    estimate,
    expected: nearUsd(estimate.expectedMicros),
    worst: upUsd(estimate.worstMicros),
    autoNote: auto,
    boldNote: options.bold && options.fallback === "none",
    fits,
    main: { worstMicros: estimate.worstMicros, label: `до ${upUsd(estimate.worstMicros)}` },
    noFallback: auto && fit === "without-fallback" ? { worstMicros: klingAlone.worstMicros, label: `до ${upUsd(klingAlone.worstMicros)}` } : null,
    budgetNeed: fits ? null : upUsd(estimate.worstMicros),
  };
}
