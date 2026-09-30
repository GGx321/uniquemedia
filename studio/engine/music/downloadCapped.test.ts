import { describe, expect, test } from "bun:test";
import { CdnBlockedError, type CdnResponse, type CdnTransport } from "./cdnTransport";
import { downloadCapped, DownloadError } from "./downloadCapped";

// Invariant 31, downloads: the URL is checked before anything is requested, no redirect is followed, the size is capped
// by the declared length AND by what actually arrives, a stalled or trickling body ends, and a failure names the host
// and the kind, never the URL (it is signed).

const URL_OK = "https://scontent-fra3-1.cdninstagram.com/v/t/track.m4a?oh=SIGNATURE&oe=6ABF5FF1";
const CAP = 1000;

interface Spy {
  transport: CdnTransport;
  requested: URL[];
  destroyed: () => boolean;
  pulls: () => number;
}

interface Reply {
  status?: number;
  headers?: Record<string, string>;
  /** Chunks delivered at once, in order. */
  chunks?: Uint8Array[];
  /** Or a body of your own. */
  body?: AsyncIterable<Uint8Array>;
}

function chunk(length: number, fill = 7): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

function spy(reply: Reply): Spy {
  const requested: URL[] = [];
  let destroyed = false;
  let pulls = 0;
  const transport: CdnTransport = (request) => {
    requested.push(request.url);
    const chunks = reply.chunks ?? [];
    const body: AsyncIterable<Uint8Array> =
      reply.body ??
      (async function* () {
        for (const part of chunks) {
          pulls++;
          yield part;
        }
      })();
    const response: CdnResponse = { status: reply.status ?? 200, headers: reply.headers ?? {}, body, destroy: () => void (destroyed = true) };
    return Promise.resolve(response);
  };
  return { transport, requested, destroyed: () => destroyed, pulls: () => pulls };
}

async function failureOf(run: Promise<unknown>): Promise<DownloadError> {
  try {
    await run;
  } catch (error) {
    if (error instanceof DownloadError) return error;
    throw error;
  }
  throw new Error("expected the download to fail");
}

const download = (transport: CdnTransport, options: Partial<Parameters<typeof downloadCapped>[0]> = {}) =>
  downloadCapped({ transport, url: URL_OK, maxBytes: CAP, signal: new AbortController().signal, ...options });

describe("a good download", () => {
  test("returns every byte, in order, and the declared content type", async () => {
    const { transport, requested } = spy({ headers: { "content-type": "audio/mp4", "content-length": "6" }, chunks: [Uint8Array.from([1, 2, 3]), Uint8Array.from([4, 5, 6])] });
    const got = await download(transport);
    expect([...got.bytes]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(got.contentType).toBe("audio/mp4");
    expect(requested).toHaveLength(1);
    expect(requested[0]?.hostname).toBe("scontent-fra3-1.cdninstagram.com");
  });

  test("works without a Content-Length", async () => {
    const got = await download(spy({ chunks: [chunk(10), chunk(20)] }).transport);
    expect(got.bytes.byteLength).toBe(30);
  });

  test("a body of exactly the cap is accepted", async () => {
    expect((await download(spy({ headers: { "content-length": String(CAP) }, chunks: [chunk(CAP)] }).transport)).bytes.byteLength).toBe(CAP);
  });

  test("Content-Encoding: identity is fine", async () => {
    expect((await download(spy({ headers: { "content-encoding": "identity" }, chunks: [chunk(5)] }).transport)).bytes.byteLength).toBe(5);
  });
});

describe("the URL is checked before anything is requested", () => {
  test.each([
    ["http", "http://scontent-fra3-1.cdninstagram.com/x"],
    ["a foreign host", "https://evil.example/x?oh=SIGNATURE"],
    ["a suffix host", "https://evilcdninstagram.com/x"],
    ["another port", "https://scontent-fra3-1.cdninstagram.com:8443/x"],
    ["an IP literal", "https://127.0.0.1/x"],
    ["credentials", "https://u:p@scontent-fra3-1.cdninstagram.com/x"],
  ])("%s is refused and the transport is never called", async (_label, url) => {
    const { transport, requested } = spy({ chunks: [chunk(1)] });
    const error = await failureOf(download(transport, { url }));
    expect(error.kind).toBe("refused");
    expect(requested).toHaveLength(0);
  });

  test("a refusal names the host and never the path or the signature", async () => {
    const error = await failureOf(download(spy({}).transport, { url: "https://evil.example/secret/track.m4a?oh=SIGNATURE" }));
    expect(error.message).toContain("evil.example");
    expect(error.message).not.toContain("SIGNATURE");
    expect(error.message).not.toContain("secret");
    expect(error.host).toBe("evil.example");
  });
});

describe("redirects are never followed", () => {
  test.each([301, 302, 303, 307, 308])("a %i is a failure, and its Location is never requested", async (status) => {
    const { transport, requested, destroyed } = spy({ status, headers: { location: "https://scontent-fra3-2.cdninstagram.com/other?oh=SIGNATURE" }, chunks: [] });
    const error = await failureOf(download(transport));
    expect(error.kind).toBe("redirect");
    expect(error.status).toBe(status);
    expect(requested).toHaveLength(1);
    expect(destroyed()).toBe(true);
    expect(error.message).not.toContain("SIGNATURE");
  });

  test("not even to another allowed host", async () => {
    const { transport, requested } = spy({ status: 302, headers: { location: "https://scontent-fra3-2.cdninstagram.com/x" } });
    await failureOf(download(transport));
    expect(requested).toHaveLength(1);
  });
});

describe("an answer that is not a 200", () => {
  test.each([204, 206, 304, 400, 401, 403, 404, 429, 500, 503])("%i is a failure carrying its status", async (status) => {
    const { transport, destroyed } = spy({ status, chunks: [chunk(3)] });
    const error = await failureOf(download(transport));
    expect(error.kind).toBe("status");
    expect(error.status).toBe(status);
    expect(destroyed()).toBe(true);
  });
});

describe("the size is capped twice", () => {
  test("a Content-Length over the cap is refused before one chunk is pulled, and the transfer is stopped", async () => {
    const { transport, pulls, destroyed } = spy({ headers: { "content-length": String(CAP + 1) }, chunks: [chunk(10)] });
    expect((await failureOf(download(transport))).kind).toBe("too-large");
    expect(pulls()).toBe(0);
    expect(destroyed()).toBe(true);
  });

  test("a body that lies about being small is cut at the cap: the rest is never read", async () => {
    const { transport, pulls, destroyed } = spy({ headers: { "content-length": "10" }, chunks: [chunk(600), chunk(600), chunk(600), chunk(600)] });
    const error = await failureOf(download(transport));
    expect(["too-large", "length-mismatch"]).toContain(error.kind);
    expect(pulls()).toBeLessThanOrEqual(2);
    expect(destroyed()).toBe(true);
  });

  test("a streamed body with no Content-Length is cut as soon as it passes the cap", async () => {
    const { transport, pulls, destroyed } = spy({ chunks: [chunk(600), chunk(600), chunk(600), chunk(600)] });
    expect((await failureOf(download(transport))).kind).toBe("too-large");
    expect(pulls()).toBe(2);
    expect(destroyed()).toBe(true);
  });

  test("one byte over the cap is refused when streamed", async () => {
    expect((await failureOf(download(spy({ chunks: [chunk(CAP), chunk(1)] }).transport))).kind).toBe("too-large");
  });

  test("a Content-Length that is not a number is ignored and the stream is still capped", async () => {
    expect((await failureOf(download(spy({ headers: { "content-length": "lots" }, chunks: [chunk(CAP + 5)] }).transport))).kind).toBe("too-large");
  });
});

describe("what arrives must match what was declared", () => {
  test("fewer bytes than the Content-Length is a truncated transfer", async () => {
    const { transport } = spy({ headers: { "content-length": "100" }, chunks: [chunk(60)] });
    expect((await failureOf(download(transport))).kind).toBe("length-mismatch");
  });

  test("an empty body is refused", async () => {
    expect((await failureOf(download(spy({ chunks: [] }).transport))).kind).toBe("empty");
  });

  test("a compressed body is refused: nothing here decompresses", async () => {
    expect((await failureOf(download(spy({ headers: { "content-encoding": "gzip" }, chunks: [chunk(5)] }).transport))).kind).toBe("encoding");
  });
});

describe("a body that stalls or trickles ends", () => {
  /** One chunk, then nothing, until the transfer is destroyed. */
  function stalling(): Reply {
    return {
      body: (async function* () {
        yield chunk(5);
        await new Promise<void>(() => undefined);
      })(),
    };
  }

  test("a stall past the idle limit is a timeout, and the transfer is stopped", async () => {
    const { transport, destroyed } = spy(stalling());
    const error = await failureOf(download(transport, { idleMs: 40, timeoutMs: 5000 }));
    expect(error.kind).toBe("timeout");
    expect(destroyed()).toBe(true);
  });

  test("a body that never sends a byte is a timeout too", async () => {
    const { transport } = spy({ body: (async function* () { await new Promise<void>(() => undefined); yield chunk(1); })() });
    expect((await failureOf(download(transport, { idleMs: 40, timeoutMs: 5000 }))).kind).toBe("timeout");
  });

  test("a body that trickles a byte at a time forever hits the total limit even though it never idles", async () => {
    const { transport, destroyed } = spy({
      body: (async function* () {
        for (;;) {
          await Bun.sleep(5);
          yield chunk(1);
        }
      })(),
    });
    const error = await failureOf(download(transport, { idleMs: 1000, timeoutMs: 120 }));
    expect(error.kind).toBe("timeout");
    expect(destroyed()).toBe(true);
  });

  test("a caller's abort ends it as aborted, and the transfer is stopped", async () => {
    const controller = new AbortController();
    const { transport, destroyed } = spy(stalling());
    const run = download(transport, { signal: controller.signal, idleMs: 5000, timeoutMs: 5000 });
    setTimeout(() => controller.abort(), 20);
    expect((await failureOf(run)).kind).toBe("aborted");
    expect(destroyed()).toBe(true);
  });

  test("an already aborted signal requests nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { transport, requested } = spy({ chunks: [chunk(1)] });
    expect((await failureOf(download(transport, { signal: controller.signal }))).kind).toBe("aborted");
    expect(requested).toHaveLength(0);
  });
});

describe("a failure of the transport", () => {
  const failing = (error: unknown): CdnTransport => () => Promise.reject(error);

  test("a refused address is `blocked-address`", async () => {
    expect((await failureOf(download(failing(new CdnBlockedError("address"))))).kind).toBe("blocked-address");
  });

  test("any other error is `network`, and its text (which may carry the signed URL) is not kept", async () => {
    const error = await failureOf(download(failing(new TypeError(`connect failed for ${URL_OK}`))));
    expect(error.kind).toBe("network");
    expect(error.message).not.toContain("SIGNATURE");
    expect(JSON.stringify(error)).not.toContain("SIGNATURE");
  });

  test("a runtime error code is kept, since it says why and names nothing", async () => {
    const error = await failureOf(download(failing(Object.assign(new Error("x"), { code: "ECONNRESET" }))));
    expect(error.message).toContain("ECONNRESET");
  });

  test("a body that errors mid-stream is `network`", async () => {
    const { transport, destroyed } = spy({
      body: (async function* () {
        yield chunk(3);
        throw new Error("socket hang up");
      })(),
    });
    expect((await failureOf(download(transport))).kind).toBe("network");
    expect(destroyed()).toBe(true);
  });
});
