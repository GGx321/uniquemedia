import { describe, expect, test } from "bun:test";
import {
  CLIP_LOST_TEXT,
  CLIP_QUIT_DETAIL,
  CLIP_QUIT_MESSAGE,
  CLIP_RECOVERED_TEXT,
  CLIP_RECOVERING_TEXT,
  CLIP_RESTART_BANNER,
  clipReconcileWaitText,
} from "./clipRestartTexts";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V6 (plan s5b1 §6 states 40, 45, 46): the sentences the owner approved in the mockups, word for word. The mockups are the source: a changed word here is a changed mockup.

describe("the restart and quit texts", () => {
  test("are the approved sentences", () => {
    expect(CLIP_RESTART_BANNER).toBe("Клип был в работе, когда Studio закрылась. Сверка расходов будет доступна примерно через 5 минут.");
    expect(CLIP_RECOVERING_TEXT).toBe("Восстанавливаем после перезапуска");
    expect(CLIP_RECOVERED_TEXT).toBe("Клип восстановлен после перезапуска");
    expect(CLIP_LOST_TEXT).toBe("Клип не дошёл до OpenRouter или потерян — сверка спишет его по максимуму");
    expect(CLIP_QUIT_MESSAGE).toBe("Клип ещё снимается");
    expect(CLIP_QUIT_DETAIL).toBe("Если выйти сейчас, после запуска понадобится сверка расходов (около 5 минут). Клип, скорее всего, ещё можно будет получить.");
  });

  test("the wait line names the local time as HH:MM", () => {
    expect(clipReconcileWaitText(new Date(2026, 9, 13, 14, 32, 59).getTime())).toBe("Сверка ждёт окончания клипа — до 14:32.");
  });

  test("the wait line pads the hour and the minute", () => {
    expect(clipReconcileWaitText(new Date(2026, 9, 13, 9, 5).getTime())).toBe("Сверка ждёт окончания клипа — до 09:05.");
  });

  test("the wait line at midnight reads 00:00", () => {
    expect(clipReconcileWaitText(new Date(2026, 9, 14, 0, 0).getTime())).toBe("Сверка ждёт окончания клипа — до 00:00.");
  });
});
