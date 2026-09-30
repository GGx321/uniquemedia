import { parentPort, workerData } from "node:worker_threads";

// A scripted stand-in for the text worker (worker/textWorker.ts): it speaks the real wire protocol without any
// resvg, so the gate's lifecycle (deadline, terminate, respawn, the FIFO lane, crash and protocol-violation
// handling) is pinned in milliseconds. What a request does is chosen by its SVG text:
//   "hang"      never answers            "crash"   ends the thread
//   "garbage"   answers off-protocol     "fail"    a clean, non-fatal failure
//   "fatal"     a failure that says the instance is broken
//   "slow:N"    answers after N ms       "invalid"  a CAPTION_INVALID (rule "charset") for a caption request
//   anything else: a PNG of `id + 1` bytes
// A `caption` request is chosen by its `value` the same way; its answer's layout is one line saying the value.
// `workerData.startup` picks how it starts: "ok", "load-failed", "never-ready" or "crash".
// `workerData.probe` is a SharedArrayBuffer of two Int32: [0] calls in flight now, [1] the most ever at once.

if (parentPort === null) throw new Error("scriptedTextWorker.ts must run as a worker_thread");
const port = parentPort;
const data = workerData as { startup: string; probe: SharedArrayBuffer };
const probe = new Int32Array(data.probe);

interface Message {
  type: string;
  id: number;
  svg?: string;
  value?: string;
}

if (data.startup === "crash") process.exit(3);
else if (data.startup === "load-failed") port.postMessage({ type: "load-failed", message: "no wasm here" });
else if (data.startup === "never-ready") {
  // stay silent, but alive: a worker with nothing to wait for would simply exit
  setInterval(() => {}, 1_000);
} else {
  port.on("message", (message: Message) => {
    const now = Atomics.add(probe, 0, 1) + 1;
    if (now > Atomics.load(probe, 1)) Atomics.store(probe, 1, now);
    const done = (): void => {
      Atomics.sub(probe, 0, 1);
    };
    const { id } = message;
    const svg = message.type === "caption" ? (message.value ?? "") : (message.svg ?? "");
    if (svg === "hang") return;
    if (svg === "crash") throw new Error("scripted crash");
    if (svg === "garbage") {
      port.postMessage({ type: "nonsense" });
      done();
      return;
    }
    const respond = (): void => {
      done();
      if (svg === "fail") port.postMessage({ type: "failed", id, code: "RENDER_FAILED", message: "resvg refused it", fatal: false });
      else if (svg === "fatal") port.postMessage({ type: "failed", id, code: "RENDER_FAILED", message: "trapped", fatal: true });
      else if (svg === "invalid" && message.type === "caption") port.postMessage({ type: "failed", id, code: "CAPTION_INVALID", message: "the caption breaks the rule", fatal: false, captionIssue: "charset" });
      else if (message.type === "measure") port.postMessage({ type: "measured", id, box: { x: 0, y: 0, width: id + 1, height: 1 }, workerMs: 0.1 });
      else if (message.type === "caption") {
        const png = new Uint8Array(id + 1).fill(9).buffer;
        port.postMessage({ type: "captioned", id, width: 10, height: 5, png, layout: { fontSize: 56, lines: [svg], width: 10, height: 5 }, workerMs: 0.2 }, [png]);
      } else {
        const png = new Uint8Array(id + 1).fill(7).buffer;
        port.postMessage({ type: "rendered", id, width: 10, height: 5, png, workerMs: 0.1 }, [png]);
      }
    };
    const slow = /^slow:(\d+)$/.exec(svg);
    if (slow !== null) setTimeout(respond, Number(slow[1]));
    else respond();
  });
  port.postMessage({ type: "ready" });
}
