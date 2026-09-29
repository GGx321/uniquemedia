import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { EMBEDDING_LENGTH, FaceWorkerRequestSchema, type FaceWorkerResponse } from "../worker/protocol";
import { Behaviour } from "./behaviour";

// Test double for faceWorker.ts: speaks the real wire protocol
// (worker/protocol.ts) but does no inference, so workerGate.ts's lifecycle —
// termination, respawn, the lane, crash and protocol-violation handling — is
// testable without models, in milliseconds. The FIRST BYTE of each request's
// `bytes` scripts what happens to that request (see Behaviour).


const Init = z.object({
  startup: z.enum(["ok", "load-failed", "never-ready", "crash"]),
  /** Int32Array over a SharedArrayBuffer: [0] computations in flight right now, [1] the most that were ever in flight at once. */
  probe: z.instanceof(SharedArrayBuffer),
});
const init = Init.parse(workerData);
const probe = new Int32Array(init.probe);
if (parentPort === null) throw new Error("must run as a worker_thread");
const port = parentPort;

function send(message: FaceWorkerResponse | { type: "garbage" }): void {
  port.postMessage(message);
}

function enter(): void {
  const now = Atomics.add(probe, 0, 1) + 1;
  let max = Atomics.load(probe, 1);
  while (now > max && Atomics.compareExchange(probe, 1, max, now) !== max) max = Atomics.load(probe, 1);
}

function leave(): void {
  Atomics.sub(probe, 0, 1);
}

if (init.startup === "crash") {
  throw new Error("scripted crash at startup");
} else if (init.startup === "load-failed") {
  send({ type: "load-failed", message: "scripted load failure" });
} else if (init.startup === "ok") {
  send({ type: "ready" });
}

const embedding = new Float32Array(EMBEDDING_LENGTH);
embedding[0] = 1;

port.on("message", (raw: unknown) => {
  const request = FaceWorkerRequestSchema.parse(raw);
  const behaviour = new Uint8Array(request.bytes)[0] ?? Behaviour.ok;
  enter();
  const finish = (): void => {
    if (behaviour === Behaviour.garbage) {
      send({ type: "garbage" });
    } else if (behaviour === Behaviour.fail) {
      send({ type: "failed", id: request.id, code: "error", message: "scripted failure" });
    } else if (behaviour === Behaviour.noFace) {
      send({ type: "failed", id: request.id, code: "no-face-in-reference", message: "scripted: no face" });
    } else if (request.type === "detect") {
      if (behaviour === Behaviour.wrongKind) {
        send({ type: "checked", id: request.id, verdict: { kind: "no-face", faces: 0 } });
      } else {
        const face = behaviour === Behaviour.noDetection ? null : { x: 10, y: 20, width: 30, height: 40 };
        send({ type: "detected", id: request.id, width: 100, height: 200, face });
      }
    } else if (request.type === "check") {
      send({ type: "checked", id: request.id, verdict: { kind: "match", similarity: 0.9, faces: 1, headRatio: 0.3 } });
    } else {
      send({ type: "embedded", id: request.id, embedding });
    }
    leave();
    if (behaviour === Behaviour.chatty) setTimeout(() => send({ type: "ready" }), 20);
  };
  if (behaviour === Behaviour.hang) {
    // Never answers. The thread stays idle: Bun's worker.terminate() cannot interrupt a synchronous busy loop (Node's, Electron's, can — smoke-engine.ts proves that on the real Electron runtime, with the dev Electron binary as plain Node, in every mode including CI's packaged one).
  } else if (behaviour === Behaviour.crash) {
    throw new Error("scripted crash mid-request");
  } else if (behaviour === Behaviour.slow) {
    setTimeout(finish, 80);
  } else {
    finish();
  }
});
