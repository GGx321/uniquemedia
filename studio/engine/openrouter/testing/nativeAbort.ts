// Run with `bun run` (not `bun test`): the test preload swaps the global
// fetch and AbortController for happy-dom's, whose signal the native fetch
// ignores. Here both are native, as in Electron's Node. Prints one JSON line.
import { createServer, type AddressInfo } from "node:net";
import { createOpenRouterClient } from "../client";
import { imageParams, setupMoney, TEST_KEY } from "./fakes";

const money = await setupMoney();
let markRequested = (): void => {};
const requested = new Promise<void>((resolve) => (markRequested = resolve));
let markClosed = (): void => {};
const closed = new Promise<void>((resolve) => (markClosed = resolve));
let socketClosed = false;

// A raw TCP server that reads the request and never answers: only a real abort
// of the client's fetch closes the socket. (Bun's node:http server does not
// report a client disconnect, so it cannot be the probe.)
const server = createServer((socket) => {
  socket.once("data", () => markRequested());
  socket.on("close", () => {
    socketClosed = true;
    markClosed();
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;

const controller = new AbortController();
const client = createOpenRouterClient({ apiKey: TEST_KEY, baseUrl: base, allowBaseUrlOverride: true, fetch, saveRaw: async () => {} });
const pending = client.generateImage(imageParams(money, { signal: controller.signal }));
await requested;
controller.abort();
const result = await pending;
await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 2_000))]);

const isNative = (fn: unknown): boolean => typeof fn === "function" && /\[native code\]/.test(Function.prototype.toString.call(fn));
console.log(JSON.stringify({ nativeGlobals: isNative(fetch) && isNative(AbortController), result, socketClosed }));
server.close();
await money.cleanup();
// A socket left open by a lost abort would keep the process alive: exit so the test fails on the report, not on a hang.
process.exit(0);
