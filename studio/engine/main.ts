// Entry of Studio's engine utilityProcess (built to out-studio/engine/main.js).
// Like everything reachable from here it uses only node:* APIs and reads no
// environment variables (invariant 1, pinned by runtime.test.ts). Its
// environment is the minimal one main passes to utilityProcess.fork, without
// any OPENROUTER_* (invariant 10).
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EngineInit } from "./control";
import { deliver, Engine, exitIfStartFails } from "./engine";
import { createAgeGate } from "./runs/ageGate";
import { createPdqGate } from "./runs/pdqGate";

const parentPort = process.parentPort;
if (!parentPort) throw new Error("the studio engine must run as an Electron utilityProcess");

// Main sends one init message with the MessagePort that carries everything else.
parentPort.once("message", (event) => {
  const [port] = event.ports;
  const init = EngineInit.safeParse(event.data);
  if (port === undefined || !init.success) {
    console.error("studio engine: invalid init message");
    process.exit(1);
  }

  // T7a: the production QA gates, in order — pdq first (free), an obvious
  // place for T7b's face gate, age last (paid, so money is spent only on
  // images that already passed every free gate). Both need something only
  // the engine has once it exists (the live library, for pdq's known
  // hashes; a client bound to the current key, for the age gate's own
  // request) — neither of which exists yet at this point, and the key can
  // rotate over the engine's whole life besides. `engine` below is filled in
  // the moment `Engine.start` resolves; nothing calls into a gate before
  // then, since a command (and with it, a run) can only reach the engine
  // once `ready` has resolved (see `deliver`, below).
  let engine: Pick<Engine, "library" | "gateChat"> | undefined;
  const pdqGate = createPdqGate({
    knownHashesFor: (avatarId) => engine?.library?.photosByAvatar(avatarId).flatMap((photo) => (photo.qa.pdq === undefined ? [] : [photo.qa.pdq])) ?? [],
  });
  const ageGate = createAgeGate({
    chat: (params) => {
      if (engine === undefined) throw new Error("the age gate was asked to run before the engine had started");
      return engine.gateChat(params);
    },
  });

  const ready = Engine.start(init.data, {
    bootId: randomUUID(),
    clock: Date.now,
    monotonic: () => performance.now(),
    newId: randomUUID,
    post: (message) => port.postMessage(message),
    // The runtime's own fetch (Electron's Node); only the OpenRouter client uses it.
    fetch: (url, init) => fetch(url, init),
    qaGates: [pdqGate, ageGate],
  });
  ready.then((started) => {
    engine = started;
  }, () => undefined);

  // A failed start ends the process, so main restarts it and tells the windows.
  exitIfStartFails(ready, (code) => process.exit(code));

  // Registered in arrival order, so control messages and commands are applied
  // in the order main sent them once the engine is ready.
  port.on("message", ({ data }) => {
    void deliver(ready, data);
  });
  port.start();
});
