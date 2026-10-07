import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, flush, tick } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { column, goButton, isDisabled, nb, openGated } from "./photos/sceneScreenKit";

// CS.6: «Дописать» and compose are shut from the moment their write is answered, not only once the set says it writes (`scenes.changed`, or the read
// compose asks for): the tracked scenes job holds the button in that window, where it would carry the same price twice.

const HELD_MS = 50;

describe("between the write's answer and `scenes.changed`", () => {
  const SET_CUT = "set-cut-0001";

  async function reconciled() {
    const harness = await openGated({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET_CUT, count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: ["home", "travel", "shoot", "glam", "fit"] }],
    });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 35 сцен · до $0.12")));
    await act(async () => {
      const reply = await harness.client.request("money.reconcile", {});
      if (!reply.ok) throw new Error(reply.error.code);
    });
    await flush();
    await waitFor(() => expect(isDisabled(goButton())).toBe(false));
    return harness;
  }

  test("«Дописать» is shut and sends nothing again once its write is answered, before the set says it writes", async () => {
    const { engine } = await reconciled();
    engine.holdEvents();
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(1);
    expect(isDisabled(goButton())).toBe(true);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "scenes.write")).toHaveLength(1);
    engine.releaseEvents();
    await flush();
    expect(within(column()).getByText("Составляем сцены: 0 из 35")).toBeDefined();
  });

  test("compose is shut and sends nothing again once it is answered, before the set is read", async () => {
    const { engine, scheduler } = await openGated();
    const compose = await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") });
    // The set reaches the screen by the read compose asks for as soon as it is answered (and by the event): hold both.
    engine.holdEvents();
    engine.delayNext("scenes.get", HELD_MS);
    fireEvent.click(compose);
    await flush();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(1);
    expect(isDisabled(goButton())).toBe(true);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(1);
    engine.releaseEvents();
    tick(scheduler, 1);
    await flush();
  });
});
