import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import { Readable } from "node:stream";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useNativeHttp } from "../../testing/nativeHttp";
import { CdnBlockedError, checkedLookup, createHttpsTransport, createLoopbackCdnTransport, type Resolver } from "./cdnTransport";
useNativeGlobals();
useNativeHttp();

// Invariant 31, the connection: the address that is CONNECTED to is the one that was checked (the lookup callback is the
// connect-time resolution, so there is no gap for a rebinding answer), no agent keeps a socket, TLS is never relaxed,
// and the loopback transport of the E2E build cannot reach anything but a mock on this machine.

const CDN_URL = new URL("https://scontent-fra3-1.cdninstagram.com/v/t/track.m4a?oh=SIGNATURE&oe=6ABF5FF1");

const resolving = (...addresses: string[]): Resolver => () => Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

type LookupResult = { error: Error | null; address: unknown; family: unknown };

/** Runs a node `lookup` function to its callback. */
function lookupOf(lookup: ReturnType<typeof checkedLookup>, options: { all?: boolean } = {}): Promise<LookupResult> {
  return new Promise((resolve) => {
    lookup("scontent-fra3-1.cdninstagram.com", options, (error: Error | null, address: unknown, family: unknown) => resolve({ error, address, family }));
  });
}

describe("the connect-time lookup", () => {
  test("hands over a public address as node's connect asks for it: a list when `all` is set", async () => {
    const got = await lookupOf(checkedLookup(resolving("157.240.22.35", "2a03:2880:f12f:83:face:b00c:0:25de")), { all: true });
    expect(got.error).toBeNull();
    expect(got.address).toEqual([
      { address: "157.240.22.35", family: 4 },
      { address: "2a03:2880:f12f:83:face:b00c:0:25de", family: 6 },
    ]);
  });

  test("hands over the first address and its family when `all` is not set", async () => {
    const got = await lookupOf(checkedLookup(resolving("157.240.22.35")));
    expect(got).toEqual({ error: null, address: "157.240.22.35", family: 4 });
  });

  test.each([
    ["loopback", "127.0.0.1"],
    ["a private address", "10.1.2.3"],
    ["the metadata address", "169.254.169.254"],
    ["a link-local IPv6 address", "fe80::1"],
    ["an IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["multicast", "224.0.0.251"],
  ])("refuses a name that resolves to %s, so nothing is connected to", async (_label, address) => {
    const got = await lookupOf(checkedLookup(resolving(address)), { all: true });
    expect(got.error).toBeInstanceOf(CdnBlockedError);
  });

  test("refuses the WHOLE answer when one of its addresses is private: a mixed answer is a rebinding attempt", async () => {
    const got = await lookupOf(checkedLookup(resolving("157.240.22.35", "10.0.0.5")), { all: true });
    expect(got.error).toBeInstanceOf(CdnBlockedError);
  });

  test("refuses an answer with no address", async () => {
    expect((await lookupOf(checkedLookup(resolving()), { all: true })).error).toBeInstanceOf(CdnBlockedError);
  });

  test("a resolver that fails is a failure of the lookup, not an allowance", async () => {
    const got = await lookupOf(checkedLookup(() => Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }))), { all: true });
    expect(got.error).toBeInstanceOf(Error);
  });

  test("never leaks the address it refused into the error text", async () => {
    const got = await lookupOf(checkedLookup(resolving("10.9.8.7")), { all: true });
    expect(got.error?.message).not.toContain("10.9.8.7");
  });
});

interface Sent {
  options: RequestOptions;
  destroyed: boolean;
  ended: boolean;
}

/** A stand-in for `https.request` that answers with `reply` once the request is ended, and records how it was asked. */
function fakeRequest(reply: { status: number; headers: Record<string, string | string[]>; chunks: Uint8Array[] } | { error: Error }): { request: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest; sent: Sent[] } {
  const sent: Sent[] = [];
  const request = (options: RequestOptions, callback: (res: IncomingMessage) => void): ClientRequest => {
    const record: Sent = { options, destroyed: false, ended: false };
    sent.push(record);
    const req = new EventEmitter() as unknown as ClientRequest;
    Object.assign(req, {
      end: () => {
        record.ended = true;
        queueMicrotask(() => {
          if ("error" in reply) return void req.emit("error", reply.error);
          const res = Object.assign(Readable.from(reply.chunks), { statusCode: reply.status, headers: reply.headers }) as unknown as IncomingMessage;
          callback(res);
        });
        return req;
      },
      destroy: () => {
        record.destroyed = true;
        return req;
      },
    });
    return req;
  };
  return { request, sent };
}

const signal = () => new AbortController().signal;

describe("the HTTPS transport", () => {
  test("connects to the host on port 443 with that name for TLS, a path and query taken from the URL", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    await createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() });
    const options = sent[0]?.options;
    expect(options?.host ?? options?.hostname).toBe("scontent-fra3-1.cdninstagram.com");
    expect(options?.port).toBe(443);
    expect(options?.servername).toBe("scontent-fra3-1.cdninstagram.com");
    expect(options?.path).toBe("/v/t/track.m4a?oh=SIGNATURE&oe=6ABF5FF1");
    expect(options?.method).toBe("GET");
    expect(sent[0]?.ended).toBe(true);
  });

  test("uses a lookup that refuses a private address: the check runs at the connection, on the address used", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    await createHttpsTransport({ request, resolve: resolving("10.0.0.5") })({ url: CDN_URL, signal: signal() });
    const lookup = sent[0]?.options.lookup;
    expect(typeof lookup).toBe("function");
    if (typeof lookup !== "function") return;
    const got = await new Promise<LookupResult>((resolve) => lookup("scontent-fra3-1.cdninstagram.com", { all: true }, ((error: Error | null, address: unknown, family: unknown) => resolve({ error, address, family })) as never));
    expect(got.error).toBeInstanceOf(CdnBlockedError);
  });

  test("keeps no socket: no agent, no keep-alive, so every download is its own connection", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    await createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() });
    expect(sent[0]?.options.agent).toBe(false);
  });

  test("never relaxes TLS: certificates are verified and no option turns that off", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    await createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() });
    const options = sent[0]?.options ?? {};
    expect(options.rejectUnauthorized).not.toBe(false);
    expect(options.checkServerIdentity).toBeUndefined();
    expect(options.ca).toBeUndefined();
    expect(options.insecureHTTPParser).not.toBe(true);
    expect(options.secureProtocol).toBeUndefined();
  });

  test("sends no cookie, no authorization and no other credential, and asks for an uncompressed body", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    await createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() });
    const names = Object.keys(sent[0]?.options.headers ?? {}).map((name) => name.toLowerCase());
    expect(names).not.toContain("cookie");
    expect(names).not.toContain("authorization");
    expect(names).not.toContain("x-rapidapi-key");
    expect((sent[0]?.options.headers as Record<string, string>)["accept-encoding"]).toBe("identity");
  });

  test("hands back the status, the headers by lowercase name (the first of a repeated one) and the body's bytes", async () => {
    const { request } = fakeRequest({ status: 200, headers: { "Content-Length": "5", "set-cookie": ["a=1", "b=2"] }, chunks: [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5])] });
    const response = await createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() });
    expect(response.status).toBe(200);
    expect(response.headers["content-length"]).toBe("5");
    expect(response.headers["set-cookie"]).toBe("a=1");
    const got: number[] = [];
    for await (const part of response.body) got.push(...part);
    expect(got).toEqual([1, 2, 3, 4, 5]);
  });

  test("an abort destroys the request", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    const controller = new AbortController();
    const transport = createHttpsTransport({ request, resolve: resolving("157.240.22.35") });
    await transport({ url: CDN_URL, signal: controller.signal });
    controller.abort();
    expect(sent[0]?.destroyed).toBe(true);
  });

  test("destroy() on the response destroys the request", async () => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    const response = await createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() });
    response.destroy();
    expect(sent[0]?.destroyed).toBe(true);
  });

  test("a request error rejects with that error", async () => {
    const { request } = fakeRequest({ error: Object.assign(new Error("boom"), { code: "ECONNRESET" }) });
    await expect(createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: CDN_URL, signal: signal() })).rejects.toMatchObject({ code: "ECONNRESET" });
  });

  test.each([
    ["http", "http://scontent-fra3-1.cdninstagram.com/x"],
    ["a foreign host", "https://evil.example/x"],
    ["another port", "https://scontent-fra3-1.cdninstagram.com:8443/x"],
    ["credentials", "https://u:p@scontent-fra3-1.cdninstagram.com/x"],
  ])("a URL that breaks the source rule (%s) never reaches the socket, even when a caller forgot the check", async (_label, raw) => {
    const { request, sent } = fakeRequest({ status: 200, headers: {}, chunks: [] });
    await expect(createHttpsTransport({ request, resolve: resolving("157.240.22.35") })({ url: new URL(raw), signal: signal() })).rejects.toBeInstanceOf(CdnBlockedError);
    expect(sent).toHaveLength(0);
  });
});

describe("the loopback transport of the E2E build", () => {
  let server: ReturnType<typeof Bun.serve> | null = null;
  afterEach(async () => {
    await server?.stop(true);
    server = null;
  });

  test.each([
    ["a public host", "http://example.com"],
    ["a private address", "http://10.0.0.5:8080"],
    ["https", "https://127.0.0.1"],
    ["credentials", "http://u:p@127.0.0.1:1"],
    ["a query", "http://127.0.0.1:1/?x=1"],
    ["not a URL", "nope"],
  ])("refuses to be built for %s: only a plain-http loopback mock is reachable", (_label, base) => {
    expect(() => createLoopbackCdnTransport(base)).toThrow();
  });

  test.each(["http://127.0.0.1:8080", "http://localhost:8080", "http://[::1]:8080"])("is built for %s", (base) => {
    expect(() => createLoopbackCdnTransport(base)).not.toThrow();
  });

  test("sends the path and query of the allowed URL to the mock, and returns its bytes", async () => {
    const seen: string[] = [];
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        seen.push(`${url.pathname}${url.search}`);
        return new Response(Uint8Array.from([9, 8, 7]), { headers: { "content-type": "audio/mp4" } });
      },
    });
    const transport = createLoopbackCdnTransport(`http://127.0.0.1:${server.port}`);
    const response = await transport({ url: CDN_URL, signal: signal() });
    const got: number[] = [];
    for await (const part of response.body) got.push(...part);
    expect(seen).toEqual(["/v/t/track.m4a?oh=SIGNATURE&oe=6ABF5FF1"]);
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/mp4");
    expect(got).toEqual([9, 8, 7]);
  });

  test("still refuses a URL the source rule refuses, so the E2E run exercises the allowlist too", async () => {
    const transport = createLoopbackCdnTransport("http://127.0.0.1:1");
    await expect(transport({ url: new URL("https://evil.example/x"), signal: signal() })).rejects.toBeInstanceOf(CdnBlockedError);
  });
});
