import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, describeElement, flush, inAct, runAll, tick } from "../testing";
import { PARIS, MIA } from "./photos/categoryScreenKit";
import { card, column, fieldValue, goButton, isDisabled, nb, openReview, sceneCard } from "./photos/sceneScreenKit";

// CS.6: every paid button of the review is shut — and sends nothing — while the account's paid calls are stopped (`paidBlockedReason`: a reconcile is
// due) or another paid action of the avatar is in flight, not only looks shut. One test per button and per reason: «Отрисовать N фото», «Написать N сцен»,
// «Другие сцены для N», «Повторить» in the ⟳ popover and compose.

const SET = "set-seed-0001";
/** A paid send held on the mock's clock: the avatar's paid lock is up until `tick`. */
const HELD_MS = 50;

function ready(count = 6) {
  return openReview({ categories: [PARIS], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count, written: count, categories: ["home", "travel"] }] });
}

async function readyWithPrice(count = 6) {
  const harness = await ready(count);
  await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
  return harness;
}

/** Another paid action, held in flight: ⟳ «Заменить» of scene 2. */
async function holdReplace(engine: Awaited<ReturnType<typeof ready>>["engine"]): Promise<void> {
  fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" }));
  await flush();
  const send = await within(sceneCard(2)).findByRole("button", { name: "Заменить · до $0.075" });
  engine.delayNext("scenes.write", HELD_MS);
  fireEvent.click(send);
  await flush();
  expect(callsOf(engine, "scenes.write")).toHaveLength(1);
}

describe("«Отрисовать N фото»", () => {
  test("stays shut and sends nothing while paid calls are stopped until a reconcile", async () => {
    const { engine } = await readyWithPrice();
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    expect(isDisabled(goButton())).toBe(true);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "runs.startFromScenes")).toHaveLength(0);
  });

  test("stays shut and sends nothing while another paid action of the avatar is in flight", async () => {
    const { engine, scheduler } = await readyWithPrice();
    await holdReplace(engine);
    expect(isDisabled(goButton())).toBe(true);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "runs.startFromScenes")).toHaveLength(0);
    tick(scheduler, 1);
    await flush();
  });
});

describe("«Написать N сцен» (the idea form)", () => {
  async function openIdeaForm(engine: Awaited<ReturnType<typeof ready>>["engine"]) {
    fireEvent.click(within(column()).getByRole("button", { name: "Своя сцена" }));
    await flush();
    const form = within(column()).getByRole("region", { name: "Своя сцена · по описанию" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Утренний кофе на балконе" } });
    await flush();
    expect(fieldValue(within(form).getByRole("textbox"))).toBe("Утренний кофе на балконе");
    expect(callsOf(engine, "scenes.estimateWrite").length).toBeGreaterThan(0);
    return form;
  }

  test("stays shut and sends nothing while paid calls are stopped until a reconcile", async () => {
    const { engine } = await readyWithPrice();
    const form = await openIdeaForm(engine);
    const send = await within(form).findByRole("button", { name: /^Написать/ });
    expect(isDisabled(send)).toBe(false);
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    const shut = within(form).getByRole("button", { name: /^Написать/ });
    expect(isDisabled(shut)).toBe(true);
    fireEvent.click(shut);
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(0);
  });

  test("stays shut and sends nothing while another paid action of the avatar is in flight", async () => {
    const { engine, scheduler } = await readyWithPrice();
    const form = await openIdeaForm(engine);
    expect(isDisabled(await within(form).findByRole("button", { name: /^Написать/ }))).toBe(false);
    await holdReplace(engine);
    const shut = within(form).getByRole("button", { name: /^Написать/ });
    expect(isDisabled(shut)).toBe(true);
    fireEvent.click(shut);
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(1);
    tick(scheduler, 1);
    await flush();
  });
});

describe("«Другие сцены для N»", () => {
  /** Mia with 60 planned scenes, 35 written, the second request given up on by the writer (the notice offers «Другие сцены для 5»). */
  async function gaveUp() {
    const harness = await openReview();
    const more = within(card()).getByRole("button", { name: "Больше" });
    for (let i = 0; i < 8; i++) {
      fireEvent.click(more);
      await flush();
    }
    harness.engine.failNextSceneAttempt("ok");
    harness.engine.failNextSceneAttempt("rejected");
    harness.engine.failNextSceneAttempt("rejected");
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 60 сцен · до $0.23") }));
    await flush();
    runAll(harness.scheduler);
    await flush();
    const notice = within(column()).getByRole("status");
    const others = await within(notice).findByRole("button", { name: "Другие сцены для 5 · до $0.075" });
    expect(isDisabled(others)).toBe(false);
    return { ...harness, notice, others };
  }

  test("stays shut and sends nothing while paid calls are stopped until a reconcile", async () => {
    const { engine, notice } = await gaveUp();
    const writes = callsOf(engine, "scenes.write").length;
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    const shut = within(notice).getByRole("button", { name: /^Другие сцены для/ });
    expect(isDisabled(shut)).toBe(true);
    fireEvent.click(shut);
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(writes);
  });

  test("stays shut and sends nothing while another paid action of the avatar is in flight", async () => {
    const { engine, scheduler, notice } = await gaveUp();
    const writes = callsOf(engine, "scenes.write").length;
    fireEvent.click(within(sceneCard(1)).getByRole("button", { name: "Другая сцена вместо 01" }));
    await flush();
    const send = await within(sceneCard(1)).findByRole("button", { name: "Заменить · до $0.075" });
    engine.delayNext("scenes.write", HELD_MS);
    fireEvent.click(send);
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(writes + 1);
    const shut = within(notice).getByRole("button", { name: /^Другие сцены для/ });
    expect(isDisabled(shut)).toBe(true);
    fireEvent.click(shut);
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(writes + 1);
    tick(scheduler, 1);
    await flush();
  });
});

describe("«Повторить» in the ⟳ popover", () => {
  function rewriteCut() {
    return openReview({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-rw-0001", count: 6, written: 6, writes: 1, reviewWrites: [{ kind: "rewrite", k: 2, sceneIds: [2], redraw: true, cutOff: true }] }],
    });
  }

  async function openPopover() {
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" }));
    await flush();
    return within(sceneCard(2)).getByRole("dialog", { name: "Другая сцена" });
  }

  test("stays shut and sends nothing while paid calls are stopped until a reconcile", async () => {
    const { engine } = await rewriteCut();
    await within(column()).findByRole("alert");
    const pop = await openPopover();
    const resume = await within(pop).findByRole("button", { name: "Повторить · до $0.038" });
    expect(isDisabled(resume)).toBe(true);
    fireEvent.click(resume);
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(0);
  });

  test("stays shut and sends nothing while its own sibling «Заменить» is in flight", async () => {
    const { engine, client, scheduler } = await rewriteCut();
    await within(column()).findByRole("alert");
    await act(async () => {
      const reply = await client.request("money.reconcile", {});
      if (!reply.ok) throw new Error(reply.error.code);
    });
    await flush();
    const pop = await openPopover();
    const resume = await within(pop).findByRole("button", { name: "Повторить · до $0.038" });
    expect(isDisabled(resume)).toBe(false);
    engine.delayNext("scenes.write", HELD_MS);
    fireEvent.click(await within(pop).findByRole("button", { name: "Заменить · до $0.075" }));
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(1);
    expect(isDisabled(within(pop).getByRole("button", { name: /^Повторить/ }))).toBe(true);
    fireEvent.click(within(pop).getByRole("button", { name: /^Повторить/ }));
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(1);
    tick(scheduler, 1);
    await flush();
  });
});

describe("compose", () => {
  test("stays shut and sends nothing while a resume of the avatar is in flight", async () => {
    const { engine, scheduler } = await openReview();
    engine.seedRun({ avatarId: MIA.avatarId, count: 12, categories: ["home"], poses: { profile: false, back: false } }, 8);
    // The run is read when the screen opens: come back to it.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
    });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Фото" }));
    });
    const resume = await screen.findByRole("button", { name: /^Продолжить/ });
    await waitFor(() => expect(goButton().textContent).toContain("Составить"));
    expect(isDisabled(goButton())).toBe(false);
    engine.delayNext("runs.resume", HELD_MS);
    fireEvent.click(resume);
    await flush();
    expect(callsOf(engine, "runs.resume")).toHaveLength(1);
    expect(isDisabled(goButton())).toBe(true);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(0);
    tick(scheduler, 1);
    await flush();
  });
});
