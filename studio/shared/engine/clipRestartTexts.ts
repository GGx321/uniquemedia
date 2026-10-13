// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, §6 states 40, 45 and 46): the Russian words of a quit and a restart with a clip in flight. Pure strings, no imports, so main (the quit dialog), the engine's
// tests and the renderer (the banner, the tile) all read the same sentences the owner approved in the mockups. Nothing here computes money: the renderer shows the engine's figures with these
// lines around them.

/** State 46, the banner's clip line: shown while the clip was in work when Studio closed and the reconcile cannot run yet (about 5 min after the restart). */
export const CLIP_RESTART_BANNER = "Клип был в работе, когда Studio закрылась. Сверка расходов будет доступна примерно через 5 минут.";

/** State 46, the same line while `MoneyStatus.reconcileAvailableAt` is ahead: «Сверка ждёт окончания клипа — до 14:32.» The time is local, as the owner's clock reads. */
export function clipReconcileWaitText(availableAtMs: number): string {
  const at = new Date(availableAtMs);
  const hh = String(at.getHours()).padStart(2, "0");
  const mm = String(at.getMinutes()).padStart(2, "0");
  return `Сверка ждёт окончания клипа — до ${hh}:${mm}.`;
}

/** State 40, the tile of a recovery job (`phase: "recovering"`). */
export const CLIP_RECOVERING_TEXT = "Восстанавливаем после перезапуска";

/** State 46, a tile of a clip a restart brought back: followed by « · до сверки: $X (OpenRouter: $Y)» and, after the reconcile, « · списано по максимуму $X (OpenRouter: $Y)». */
export const CLIP_RECOVERED_TEXT = "Клип восстановлен после перезапуска";

/** State 46, a tile of a clip a restart could not trace (`lost`): its open reserve is settled at worst by the reconcile. */
export const CLIP_LOST_TEXT = "Клип не дошёл до OpenRouter или потерян — сверка спишет его по максимуму";

/** State 45, the quit question while a clip renders: the dialog's message and detail, with «Остаться» / «Выйти». */
export const CLIP_QUIT_MESSAGE = "Клип ещё снимается";
export const CLIP_QUIT_DETAIL = "Если выйти сейчас, после запуска понадобится сверка расходов (около 5 минут). Клип, скорее всего, ещё можно будет получить.";
