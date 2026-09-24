// Entry of Studio's engine utilityProcess (built to out-studio/engine/main.js).
// Like everything reachable from here it uses only node:* APIs and reads no
// environment variables (invariant 1, pinned by runtime.test.ts). Its
// environment is the minimal one main passes to utilityProcess.fork, without
// any OPENROUTER_* (invariant 10).
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { EngineInit } from "./control";
import { Engine } from "./engine";

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

  const ready = Engine.start(init.data, {
    bootId: randomUUID(),
    clock: Date.now,
    monotonic: () => performance.now(),
    newId: randomUUID,
    post: (message) => port.postMessage(message),
  });

  // Registered in arrival order, so control messages and commands are applied
  // in the order main sent them once the engine is ready.
  port.on("message", ({ data }) => {
    void ready.then((engine) => engine.receive(data));
  });
  port.start();
});
