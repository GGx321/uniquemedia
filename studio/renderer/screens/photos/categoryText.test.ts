import { describe, expect, test } from "bun:test";
import { CATEGORY_REASONS_RU, POOL_TIMES, type CategoryInterrupted, type CategoryPool, type CategorySummary } from "../../../shared/engine";
import {
  ANGLES_CLEAR_TITLE,
  ANGLES_NONE_HINT,
  anglesHint,
  anglesLockedTitle,
  anglesNote,
  anglesSaveFailure,
  DESCRIPTION_HINT,
  impliedChipTitle,
  ownAnglesLine,
  callFailure,
  categoryMeta,
  createdLine,
  createdTime,
  deleteConfirmText,
  descriptionProblem,
  hiddenFailure,
  interruptedText,
  libraryHeld,
  nameProblem,
  outfitsNote,
  placeRemoval,
  placesNote,
  poolCounts,
  regenFailure,
  shotShares,
  styleNote,
  timeLabel,
  unreadableNote,
  overLimitNote,
} from "./categoryText";

// CS.3: what the create dialog and the «Мои категории» sheet say, word for word as the CS.0 artboards draw it (CategoryStates.dc.html,
// PhotosCS.dc.html), from the contract's own fields. Money follows the design's «Деньги на экране»: three decimals below $0.10.

/** A count stays on one line with its word (the app's countOf binds them with a no-break space). */
const nb = (text: string): string => text.replace(/(\d) (?=\p{L})/gu, "$1 ");

const place = (name: string, mirror = false, times: CategoryPool["locations"][number]["times"] = ["morning"]) => ({
  name,
  times,
  activities: [
    { text: "reading a paperback", twoHanded: false },
    { text: "sipping a latte", twoHanded: true },
  ],
  mirror,
});

const POOL: CategoryPool = {
  locations: [place("corner cafe window seat"), place("sidewalk cafe terrace"), place("bookshop by the river"), place("Seine riverside walk"), place("boulangerie counter"), place("cafe restroom mirror", true)],
  outfits: ["beige trench coat over a striped tee", "black beret and camel wool coat", "white blouse with high-waisted jeans", "navy knit cardigan and midi skirt"],
  shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
};

const PARIS: CategorySummary = {
  categoryId: "cat-paris-0001",
  name: "Кофейни Парижа",
  description: "Парижские кофейни",
  label: "Paris cafes",
  style: "phone",
  pool: POOL,
  model: "x-ai/grok-4.3",
  spentMicros: 5_000,
  createdAt: "2026-10-05T09:00:00.000Z",
  updatedAt: "2026-10-05T09:00:00.000Z",
};

describe("the pool as shown", () => {
  test("times of day are said in Russian, the whole vocabulary", () => {
    expect(POOL_TIMES.map(timeLabel)).toEqual(["утро", "день", "золотой час", "вечер", "ночь", "студийный свет"]);
  });

  test("the shot deck as shares, in the legend's order, only the shots it holds", () => {
    expect(shotShares(POOL.shotDeck)).toEqual([
      { shot: "friend", label: "Подруга снимает", percent: 40 },
      { shot: "selfie", label: "Селфи", percent: 20 },
      { shot: "mirror", label: "Зеркало", percent: 20 },
      { shot: "candid", label: "Кэндид", percent: 20 },
    ]);
  });

  test("a category's counts, declined: «6 мест · 4 наряда», «5 мест · 3 наряда», «7 мест · 5 нарядов»", () => {
    expect(poolCounts(POOL)).toBe(nb("6 мест · 4 наряда"));
    expect(poolCounts({ ...POOL, locations: POOL.locations.slice(0, 5), outfits: POOL.outfits.slice(0, 3) })).toBe(nb("5 мест · 3 наряда"));
    expect(poolCounts({ ...POOL, locations: [...POOL.locations, place("candlelit bistro bar")], outfits: [...POOL.outfits, "little black dress"] })).toBe(nb("7 мест · 5 нарядов"));
  });

  test("the style line under the shots", () => {
    expect(styleNote("phone")).toBe("Стиль «телефон», как у Дома.");
    expect(styleNote("editorial")).toBe("Стиль «редакционный», как у Фотосессии: в наборе не меньше трёх кадров «Фотограф».");
  });
});

describe("the meta line under a category's name", () => {
  // Segments, joined with « · » on screen: none breaks inside («создана 5 окт.» stays on one line).
  test("a new category: its label for the model, its style, the day it was made and what it cost", () => {
    expect(categoryMeta(PARIS, "created")).toEqual(["для модели «Paris cafes»", "телефон", "создана 5 окт.", "потрачено $0.005"]);
  });

  test("regenerated in this window: the day of the new pool and the whole spend", () => {
    expect(categoryMeta({ ...PARIS, label: "Paris cafes and bistros", spentMicros: 11_000, updatedAt: "2026-10-06T10:00:00.000Z" }, "regenerated")).toEqual([
      "для модели «Paris cafes and bistros»",
      "телефон",
      "пересоздана 6 окт.",
      "всего потрачено $0.011",
    ]);
  });

  test("a regeneration that failed in this window keeps the old pool, but the spend is the whole of it", () => {
    expect(categoryMeta({ ...PARIS, spentMicros: 16_000 }, "retried")).toEqual(["для модели «Paris cafes»", "телефон", "создана 5 окт.", "всего потрачено $0.016"]);
  });

  test("the create dialog's line once the category is made: what this call cost", () => {
    expect(createdTime(PARIS, 5_000)).toBe("для модели «Paris cafes» · телефон · потрачено $0.005");
    expect(createdTime({ ...PARIS, style: "editorial" }, 6_000)).toBe("для модели «Paris cafes» · редакционный · потрачено $0.006");
  });
});

describe("what may be removed", () => {
  test("a place: free while more than five are left and a mirror place stays for a mirror deck", () => {
    expect(placeRemoval(POOL, 0)).toBeNull();
    expect(placeRemoval(POOL, 5)).toBe("Единственное место с зеркалом — без него не будет кадров в зеркале");
    const five = { ...POOL, locations: POOL.locations.slice(1) };
    expect(placeRemoval(five, 0)).toBe("Мест уже 5 — меньше нельзя");
    // No mirror shot in the deck: the mirror place may go like any other.
    expect(placeRemoval({ ...POOL, shotDeck: ["friend", "friend", "selfie", "candid", "candid"] }, 5)).toBeNull();
  });

  test("the note under the places says the rule, or why none can go", () => {
    expect(placesNote(POOL)).toBe("Убрать место можно, пока их не меньше 5 и есть хотя бы одно с зеркалом — для кадров в зеркале.");
    expect(placesNote({ ...POOL, shotDeck: ["friend", "friend", "selfie", "candid", "candid"] })).toBe("Убрать место можно, пока их не меньше 5.");
    expect(placesNote({ ...POOL, locations: POOL.locations.slice(1) })).toBe("Мест уже 5 — меньше нельзя. Пересоздайте категорию, если места не нравятся.");
  });

  test("outfits: nothing to say above three, the floor at three", () => {
    expect(outfitsNote(POOL)).toBeNull();
    expect(outfitsNote({ ...POOL, outfits: POOL.outfits.slice(0, 3) })).toBe("Нарядов уже 3 — меньше нельзя. Пересоздайте категорию, если наряды не нравятся.");
  });
});

describe("the fields, checked before anything is sent (free)", () => {
  test("the name: required, at most 40, unique in the library whatever its case and edge spaces", () => {
    expect(nameProblem("", [], true)).toBe("Введите название.");
    expect(nameProblem("   ", [], true)).toBe("Введите название.");
    // Not touched yet: an empty name is not called out, the button just waits.
    expect(nameProblem("", [], false)).toBeNull();
    expect(nameProblem("К".repeat(40), [], true)).toBeNull();
    expect(nameProblem("К".repeat(41), [], true)).toBe("Не больше 40 знаков — уберите 1.");
    expect(nameProblem("  кофейни ПАРИЖА ", [PARIS], true)).toBe(CATEGORY_REASONS_RU["name-taken"]);
    expect(nameProblem("Кофейни​Парижа", [], true)).toBe("Уберите невидимые и управляющие символы.");
  });

  test("the description: required, at most 500, line breaks allowed", () => {
    expect(descriptionProblem("", true)).toBe("Введите описание.");
    expect(descriptionProblem("", false)).toBeNull();
    expect(descriptionProblem("а".repeat(500), true)).toBeNull();
    expect(descriptionProblem("а".repeat(512), true)).toBe("Не больше 500 знаков — уберите 12.");
    expect(descriptionProblem("утро\nвечер", true)).toBeNull();
  });
});

describe("a failed create or regenerate", () => {
  test("POOL_REJECTED: the design's words, and both attempts counted", () => {
    expect(callFailure({ code: "POOL_REJECTED", spentMicros: 11_000 })).toEqual({
      text: "Модель дважды вернула неподходящий набор — переформулируйте описание.",
      code: "POOL_REJECTED · потрачено $0.011 — обе попытки учтены",
    });
  });

  test("MODERATION_REFUSED on the first attempt costs nothing; after a rejected first answer it costs that answer", () => {
    expect(callFailure({ code: "MODERATION_REFUSED", spentMicros: 0 })).toEqual({
      text: "Модель отказалась составлять набор по этому описанию — переформулируйте его.",
      code: "MODERATION_REFUSED · потрачено $0.000 — отказ на первой попытке не списан",
    });
    expect(callFailure({ code: "MODERATION_REFUSED", spentMicros: 6_000 }).code).toBe("MODERATION_REFUSED · потрачено $0.006 — первая попытка, отклонённая проверкой, оплачена");
  });

  test("the library's limit sends to «Мои категории»; a pool paid for but not stored sends to Settings", () => {
    expect(callFailure({ code: "VALIDATION", categoryReason: "limit" })).toEqual({ text: "В библиотеке уже 50 категорий — это предел. Удалите ненужную, потом создайте новую.", code: null, action: "sheet" });
    expect(callFailure({ code: "INTERNAL", detail: "the paid category is kept in raw/x", spentMicros: 5_000 })).toEqual({
      text: "Набор оплачен, но не сохранился: папка библиотеки недоступна для записи. Проверьте её в Настройках и создайте категорию снова.",
      code: "INTERNAL · потрачено $0.005",
      action: "settings",
    });
  });

  test("a library-unreadable refusal that comes with a spend is a pool paid for and not stored, never «nothing was spent»", () => {
    const paid = callFailure({ code: "VALIDATION", categoryReason: "library-unreadable", spentMicros: 5_000 });
    expect(paid).toEqual({
      text: "Набор оплачен, но не сохранился: папка библиотеки недоступна для записи. Проверьте её в Настройках и создайте категорию снова.",
      code: "VALIDATION · потрачено $0.005",
      action: "settings",
    });
    expect(paid.text).not.toContain("не потрачено");
    expect(hiddenFailure("Рынки", { code: "VALIDATION", categoryReason: "library-unreadable", spentMicros: 5_000 }).text).not.toContain("не потрачено");
    expect(regenFailure({ code: "VALIDATION", categoryReason: "library-unreadable", spentMicros: 5_000 }).text).toContain("оплачен");
  });

  test("a library-unreadable refusal before any spend keeps its own text: nothing was created or spent, retry", () => {
    expect(callFailure({ code: "VALIDATION", categoryReason: "library-unreadable" })).toEqual({ text: CATEGORY_REASONS_RU["library-unreadable"], code: null });
    expect(callFailure({ code: "VALIDATION", categoryReason: "library-unreadable", spentMicros: 0 }).text).toBe(CATEGORY_REASONS_RU["library-unreadable"]);
  });

  test("any other refusal is the error's own Russian text, with what it cost when the call had started", () => {
    expect(callFailure({ code: "VALIDATION", categoryReason: "name-taken", spentMicros: 6_000 })).toEqual({ text: CATEGORY_REASONS_RU["name-taken"], code: "VALIDATION · потрачено $0.006" });
    expect(callFailure({ code: "AUTH_INVALID" }).code).toBeNull();
  });

  // The amount is apart from the title: the notice sets it in mono, as the design does («· потрачено $0.011»).
  test("a regenerate keeps the old pool and says so", () => {
    expect(regenFailure({ code: "POOL_REJECTED", spentMicros: 11_000 })).toEqual({
      title: "Старый набор остался",
      spent: "$0.011",
      text: "Модель дважды вернула неподходящий набор — переформулируйте описание и пересоздайте снова.",
      code: "POOL_REJECTED · обе попытки учтены",
    });
    expect(regenFailure({ code: "MODERATION_REFUSED", spentMicros: 6_000 })).toEqual({
      title: "Старый набор остался",
      spent: "$0.006",
      text: "Модель отказалась составлять набор по этому описанию — переформулируйте его.",
      code: "MODERATION_REFUSED · отказ не списан, оплачена первая попытка",
    });
    expect(regenFailure({ code: "INTERNAL", spentMicros: 5_000 })).toEqual({
      title: "Старый набор остался",
      spent: "$0.005",
      text: "Новый набор оплачен, но не сохранился: папка библиотеки недоступна для записи. Проверьте её в Настройках и пересоздайте снова.",
      code: null,
    });
    // Refused before any spend: nothing to add up.
    expect(regenFailure({ code: "IN_FLIGHT" }).spent).toBeNull();
  });

  test("the notice under the card when the dialog was hidden names the category and what it cost (the amount apart, set in mono)", () => {
    expect(hiddenFailure("Кофейни Парижа", { code: "POOL_REJECTED", spentMicros: 11_000 })).toEqual({
      text: "Категория «Кофейни Парижа» не создана: модель дважды вернула неподходящий набор — переформулируйте описание.",
      spent: "$0.011",
    });
    expect(hiddenFailure("Рынки", { code: "PRICE_CHANGED" })).toEqual({
      text: "Категория «Рынки» не создана: цена выросла, ничего не отправлено — подтвердите новую цену в окне.",
      spent: null,
    });
  });
});

describe("a call a closed Studio left", () => {
  const left: CategoryInterrupted = {
    jobId: "job-0001",
    kind: "create",
    name: "Кофейни Парижа",
    description: "кофейни",
    categoryId: null,
    startedAt: "2026-10-05T09:00:00.000Z",
    spentMicros: 22_500,
    openReserveMicros: 22_500,
  };

  test("a create: the design's words, the worst case counted until the reconcile", () => {
    expect(interruptedText(left)).toEqual({
      title: "Создание прервано — Studio закрылась",
      text: "Модель составляла набор для «Кофейни Парижа», когда Studio закрылась. Категория не создана; описание сохранено. Запрос учтён по худшей цене — до $0.023 — до сверки расходов.",
    });
  });

  test("the worst case it is counted at is told in money, rounded up", () => {
    expect(interruptedText({ ...left, openReserveMicros: 1_000, spentMicros: 1_000 }).text).toEndWith("Запрос учтён по худшей цене — до $0.001 — до сверки расходов.");
    expect(interruptedText({ ...left, openReserveMicros: 22_501, spentMicros: 22_501 }).text).toEndWith("Запрос учтён по худшей цене — до $0.023 — до сверки расходов.");
  });

  test("a regenerate keeps its old pool", () => {
    expect(interruptedText({ ...left, kind: "regenerate", categoryId: "cat-paris-0001" })).toEqual({
      title: "Пересоздание прервано",
      text: "Studio закрылась, пока модель составляла новый набор. Старый набор остался. Запрос учтён по худшей цене — до $0.023 — до сверки расходов.",
    });
  });

  test("what it cost is said as the ledger knows it: reconciled, never sent, or unknown", () => {
    expect(interruptedText({ ...left, openReserveMicros: 0, spentMicros: 4_000 }).text).toEndWith("Запрос учтён: потрачено $0.004.");
    expect(interruptedText({ ...left, openReserveMicros: 0, spentMicros: 0 }).text).toEndWith("Запрос не успел уйти — ничего не потрачено.");
    expect(interruptedText({ ...left, openReserveMicros: null, spentMicros: null }).text).toEndWith("Сколько стоил запрос, неизвестно: журнал расходов сейчас не читается.");
  });
});

describe("the sheet's counts and notes", () => {
  test("every category file holds a place towards the 50, readable or not", () => {
    expect(libraryHeld({ categories: [PARIS], unreadable: 1, overLimit: 0 })).toBe(2);
    expect(libraryHeld({ categories: [], unreadable: 0, overLimit: 3 })).toBe(3);
  });

  test("unreadable files are counted and kept", () => {
    expect(unreadableNote(1)).toBe(nb("1 файл категории не читается — он не удалён"));
    expect(unreadableNote(3)).toBe(nb("3 файла категорий не читаются — они не удалены"));
    expect(unreadableNote(5)).toBe(nb("5 файлов категорий не читаются — они не удалены"));
  });

  test("categories past the 50th are kept on disk and come back as others are deleted", () => {
    expect(overLimitNote(1)).toBe("Ещё 1 категория сверх 50 здесь не показана — она появится, когда вы удалите ненужную.");
    expect(overLimitNote(4)).toBe("Ещё 4 категории сверх 50 здесь не показаны — они появятся, когда вы удалите ненужные.");
  });
});

describe("phase 2: with a scene set open (CS.7 M1)", () => {
  test("the delete confirm says that ⟳ goes for the category's scenes in the open set, only when the set holds them (ReviewStates E)", () => {
    const lead = "Фото этой категории останутся в галерее с её названием. Запуски, где она уже есть, не изменятся.";
    expect(deleteConfirmText(0)).toBe(`${lead} Вернуть категорию нельзя.`);
    expect(deleteConfirmText(3)).toBe(
      nb(`${lead} В открытом наборе сцен её 3 сцены останутся как есть, но «Другая сцена» для них станет недоступна — новое место из удалённой категории не взять. Вернуть категорию нельзя.`),
    );
    expect(deleteConfirmText(1)).toBe(
      nb(`${lead} В открытом наборе сцен её 1 сцена останется как есть, но «Другая сцена» для неё станет недоступна — новое место из удалённой категории не взять. Вернуть категорию нельзя.`),
    );
    expect(deleteConfirmText(21)).toContain(nb("её 21 сцена останется как есть, но «Другая сцена» для неё"));
    expect(deleteConfirmText(5)).toContain(nb("её 5 сцен останутся как есть, но «Другая сцена» для них"));
  });

  test("the «готово» line: in the run at once, or — a set already composed — in the next set (decision 17); CS.8: the angles are changed there too", () => {
    expect(createdLine(false)).toBe("Категория уже включена в запуск. Убрать место или наряд, поменять ракурсы — в «Мои категории».");
    expect(createdLine(true)).toBe("Набор сцен уже составлен — категория войдёт в следующий набор. Открытый набор не меняется.");
  });
});

describe("CS.8: a category's angles", () => {
  const BED_DECK = ["friend", "friend", "candid", "candid", "selfie"] as const;
  const PHONES = ["friend", "selfie", "mirror", "candid", "candid"] as const;
  const NO_PHONE = ["friend", "candid", "photographer", "photographer", "photographer"] as const;
  const WHAT_MANY = "Её сцены — поровну в этих ракурсах; «Ракурсы» карточки их не касаются.";
  const WHAT_ONE = "Все её сцены — в этом ракурсе; «Ракурсы» карточки их не касаются.";

  test("the description hint names the pose and the angle (CatCreate)", () => {
    expect(DESCRIPTION_HINT).toBe(
      "Где она бывает, что там делает и в какой позе, во что одета, с какого ракурса снимать («вид сзади», «в профиль»). Модель составит 5–7 мест, 3–6 нарядов и набор кадров. Наряды — только неоткровенные, как во всех категориях.",
    );
  });

  test("the first sentence: drawn evenly from the list (not the card's mix), one angle said as one", () => {
    expect(anglesNote(["front"], PHONES)).toBe(WHAT_ONE);
    expect(anglesNote(["front", "three-quarter"], PHONES)).toBe(WHAT_MANY);
  });

  test("the second sentence, only with profile or back: the phone shots that stay, and fewer of them (the design re-check's «селфи станет меньше»)", () => {
    expect(anglesNote(["back", "three-quarter"], BED_DECK)).toBe(`${WHAT_MANY} Селфи станет меньше: только три четверти; со спины — без проверки сходства.`);
    expect(anglesNote(["front", "three-quarter", "back"], PHONES)).toBe(
      `${WHAT_MANY} Селфи и кадров в зеркале станет меньше: только анфас или три четверти; со спины — без проверки сходства.`,
    );
    expect(anglesNote(["three-quarter", "profile"], ["friend", "mirror", "mirror", "candid", "candid"])).toBe(
      `${WHAT_MANY} Кадров в зеркале станет меньше: только три четверти; в профиль — без проверки сходства.`,
    );
    expect(anglesNote(["three-quarter", "profile", "back"], BED_DECK)).toBe(`${WHAT_MANY} Селфи станет меньше: только три четверти; в профиль и со спины — без проверки сходства.`);
  });

  test("no facing angle in the list: the phone shots go; no phone shot in the deck: only the likeness check is said", () => {
    expect(anglesNote(["back"], PHONES)).toBe(`${WHAT_ONE} Селфи и зеркала у неё не будет; со спины — без проверки сходства.`);
    expect(anglesNote(["back"], BED_DECK)).toBe(`${WHAT_ONE} Селфи у неё не будет; со спины — без проверки сходства.`);
    expect(anglesNote(["profile"], NO_PHONE)).toBe(`${WHAT_ONE} В профиль — без проверки сходства.`);
    expect(anglesNote(["profile", "back"], NO_PHONE)).toBe(`${WHAT_MANY} В профиль и со спины — без проверки сходства.`);
  });

  test("the sheet's hint: the same lines with own angles, what the card gives without; an open set holding the category's scenes adds that ⟳ there follows an edit", () => {
    expect(ANGLES_NONE_HINT).toBe("Как в карточке генерации: анфас и три четверти всегда, профиль и со спины — если они включены там.");
    expect(anglesHint(undefined, PHONES, 0)).toBe(ANGLES_NONE_HINT);
    expect(anglesHint(["back", "three-quarter"], BED_DECK, 0)).toBe(anglesNote(["three-quarter", "back"], BED_DECK));
    const opened = "Правка меняет и «Другую сцену» в открытом наборе; уже составленные сцены остаются как были.";
    expect(anglesHint(undefined, PHONES, 3)).toBe(`${ANGLES_NONE_HINT} ${opened}`);
    expect(anglesHint(["front"], PHONES, 1)).toBe(`${WHAT_ONE} ${opened}`);
  });

  test("the sheet's chips and buttons say what they do", () => {
    expect(impliedChipTitle("front")).toBe("Как в карточке: анфас и три четверти всегда. Нажмите — свои ракурсы без анфаса");
    expect(impliedChipTitle("three-quarter")).toBe("Как в карточке: анфас и три четверти всегда. Нажмите — свои ракурсы без трёх четвертей");
    expect(ANGLES_CLEAR_TITLE).toBe("Убрать свои ракурсы — сцены этой категории возьмут их из «Ракурсов» карточки генерации");
    expect(anglesLockedTitle("regenerate")).toBe("Пока идёт пересоздание, эту категорию не изменить");
    expect(anglesLockedTitle("delete")).toBe("Пока идёт удаление, эту категорию не изменить");
  });

  test("a save that did not go through says why after a colon, and that nothing changed", () => {
    expect(anglesSaveFailure({ code: "INTERNAL" })).toBe("Не сохранилось: внутренняя ошибка движка — ракурсы остались прежними.");
    expect(anglesSaveFailure({ code: "NOT_FOUND" })).toBe("Не сохранилось: запрошенный объект не найден — ракурсы остались прежними.");
  });

  test("the card's line: none when no category of the run has its own angles", () => {
    expect(ownAnglesLine([])).toBe(null);
  });

  test("the card's line, one category: the message first, then the name, then its angles sorted", () => {
    const line = ownAnglesLine([{ name: "Домашнее у кровати", poses: ["back", "three-quarter"] }]);
    expect(line).toEqual({
      name: "Домашнее у кровати",
      list: "три четверти, со спины",
      more: 0,
      moreLabel: "",
      visible: "Эти переключатели не касаются «Домашнее у кровати» — у неё свои ракурсы: три четверти, со спины.",
      rows: [{ name: "Домашнее у кровати", list: "три четверти, со спины" }],
      full: "Эти переключатели не касаются категорий со своими ракурсами: «Домашнее у кровати» — три четверти, со спины.",
      title: "Свои ракурсы — Домашнее у кровати: три четверти, со спины",
    });
  });

  test("the card's line, several: «и ещё N категорий» behind a button, every category with its angles in the list it opens and for a screen reader", () => {
    const line = ownAnglesLine([
      { name: "Домашнее у кровати", poses: ["three-quarter", "back"] },
      { name: "Йога дома", poses: ["profile"] },
      { name: "Ночной город", poses: ["back"] },
    ]);
    expect(line?.visible).toBe(nb("Эти переключатели не касаются «Домашнее у кровати» и ещё 2 категорий — у них свои ракурсы."));
    expect(line?.list).toBe(null);
    expect(line?.more).toBe(2);
    expect(line?.moreLabel).toBe(nb("ещё 2 категорий"));
    expect(line?.rows).toEqual([
      { name: "Домашнее у кровати", list: "три четверти, со спины" },
      { name: "Йога дома", list: "профиль" },
      { name: "Ночной город", list: "со спины" },
    ]);
    expect(line?.full).toBe("Эти переключатели не касаются категорий со своими ракурсами: «Домашнее у кровати» — три четверти, со спины; «Йога дома» — профиль; «Ночной город» — со спины.");
    expect(line?.title).toBe("Свои ракурсы — Домашнее у кровати: три четверти, со спины; Йога дома: профиль; Ночной город: со спины");
    expect(ownAnglesLine([{ name: "А", poses: ["back"] }, { name: "Б", poses: ["back"] }])?.moreLabel).toBe(nb("ещё 1 категории"));
  });
});
