import { describe, expect, test } from "bun:test";
import { LaunchView, type EventMessage } from "../../shared/engine";
import { runWorld, startRun, unwrap, type Mock } from "./mockLaunchRun.testkit";

// Stage 4, S4.8 (the engine's H1, S4.6w, and S4.6g L6): the mock tells the window about the unfinished launch whenever the money or the settings change, as the engine's `#emitMoney` and
// `#emitSettings` call `Orchestrator.refresh()`; it announces once per pass, not once per cent; and its marks and deleted videos are per avatar, as the engine's logs are.

const announced = (mock: Mock): LaunchView[] => mock.events.flatMap((e: EventMessage) => (e.type === "autopilot.changed" ? [e.payload.launch] : []));

describe("the engine's H1 re-announce", () => {

  test("the view it tells carries what the money change moved: a key cleared closes «Продолжить» as «key», and a new one opens it", async () => {
    const mock = runWorld();
    const started = await startRun(mock);
    await unwrap(mock.client.request("autopilot.pause", { launchId: started.launchId }));
    await unwrap(mock.client.request("settings.clearApiKey", {}));
    expect(announced(mock).at(-1)).toMatchObject({ resumeBlockedBy: "key" });
    await unwrap(mock.client.request("settings.setApiKey", { key: "sk-or-v1-abcdef0123456789-test" }));
    expect(announced(mock).at(-1)).toMatchObject({ resumeBlockedBy: null });
  });

});

