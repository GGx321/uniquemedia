import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { LookupFunction } from "node:net";
import { isPublicAddress } from "./addressPolicy";
import { checkCdnUrl } from "./cdnPolicy";

// The transports of the track store (invariant 31). A transport takes a URL that has ALREADY passed `checkCdnUrl` and
// returns the answer's status, headers and a body to read; it follows no redirect and keeps no connection. Two exist:
//
// - the HTTPS transport is the only one a production build has. It connects with `node:https` (never `fetch`, whose
//   resolver cannot be interposed): the `lookup` it gives the socket refuses any address that is not public unicast, and
//   because that callback IS the resolution the connection uses, the address checked is the address connected to, so a
//   DNS answer that changes between a check and a connect (rebinding) has no gap to use. TLS is never relaxed: no
//   `rejectUnauthorized`, no custom CA, no custom identity check.
// - the loopback transport is the E2E build's mock CDN. It sends the allowed URL's path and query to a plain-http mock on
//   this machine, so the run still passes the host allowlist; only where the bytes come from changes. It is built only
//   behind `STUDIO_E2E` and is compiled out of a production bundle (bundleChecks.ts), and it refuses any base that is not
//   a loopback one.
//
// Both re-check the URL themselves, so a caller that forgot `checkCdnUrl` still cannot reach another host.

export interface CdnResponse {
  readonly status: number;
  /** Lowercase names; the first value of a repeated header. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: AsyncIterable<Uint8Array>;
  /** Stops the transfer and releases the socket. Safe to call twice. */
  destroy(): void;
}

export interface CdnRequest {
  /** A URL that passed `checkCdnUrl`. */
  readonly url: URL;
  readonly signal: AbortSignal;
}

export type CdnTransport = (request: CdnRequest) => Promise<CdnResponse>;

/** The transport refused to connect: the URL breaks the source rule, or the name resolves to an address that is not public. Never carries a URL or an address. */
export class CdnBlockedError extends Error {
  readonly reason: "url" | "address";
  constructor(reason: CdnBlockedError["reason"]) {
    super(reason === "url" ? "the URL is not one a download may use" : "the host resolves to an address that is not public");
    this.name = "CdnBlockedError";
    this.reason = reason;
  }
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/** Every address a name resolves to. `dns.lookup` by default (the OS resolver, as a connection would use). */
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

const systemResolver: Resolver = async (hostname) => {
  const answers = await dnsLookup(hostname, { all: true, verbatim: true });
  return answers.flatMap((answer) => (answer.family === 4 || answer.family === 6 ? [{ address: answer.address, family: answer.family }] : []));
};

/**
 * A `lookup` for a socket: resolves the name and hands over its addresses only when EVERY one of them is public unicast.
 * A mixed answer is refused whole, since a name that answers both a public and a private address is how rebinding is
 * dressed up. Node calls it with `all: true` when it tries several addresses and without when it takes one.
 */
export function checkedLookup(resolve: Resolver = systemResolver): LookupFunction {
  return (hostname, options, callback) => {
    const all = typeof options === "object" && options !== null && options.all === true;
    resolve(hostname).then(
      (addresses) => {
        const first = addresses[0];
        if (first === undefined || addresses.some((entry) => !isPublicAddress(entry.address))) return callback(new CdnBlockedError("address"), "", 0);
        if (all) return callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
        return callback(null, first.address, first.family);
      },
      (error: unknown) => callback(error instanceof Error ? error : new Error("the name could not be resolved"), "", 0),
    );
  };
}

function firstHeaders(res: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(res.headers)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) headers[name.toLowerCase()] = first;
  }
  return headers;
}

/** Runs one GET through `send`, tied to `signal`, and wraps the answer. */
function get(send: (callback: (res: IncomingMessage) => void) => ClientRequest, signal: AbortSignal): Promise<CdnResponse> {
  return new Promise<CdnResponse>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason instanceof Error ? signal.reason : new Error("the request was cancelled"));
    let req: ClientRequest | null = null;
    const onAbort = (): void => void req?.destroy(signal.reason instanceof Error ? signal.reason : new Error("the request was cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (): void => signal.removeEventListener("abort", onAbort);
    req = send((res) => {
      res.once("close", finish);
      resolve({
        status: res.statusCode ?? 0,
        headers: firstHeaders(res),
        body: res,
        destroy: () => {
          res.destroy();
          req?.destroy();
        },
      });
    });
    req.once("error", (error) => {
      finish();
      reject(error);
    });
    req.end();
  });
}

export interface HttpsTransportOptions {
  /** Every address of a name; the OS resolver by default. A test passes its own. */
  resolve?: Resolver;
  /** `https.request`; a test passes a stand-in. */
  request?: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest;
}

/**
 * The one User-Agent every download sends. Node's `https.request` sends none, where the fetch the SP0 spike used sent its
 * runtime's; a CDN that wants one would answer 403 to every track (review F4). This is a plain product token with a
 * compatibility mark, the form a media client commonly uses: it says what asks (Studio, fetching media) and nothing about
 * the machine, the OS or a runtime version. Never per-user, never built from the environment.
 */
export const CDN_USER_AGENT = "Mozilla/5.0 (compatible; Studio media fetch)";

const REQUEST_HEADERS = { accept: "*/*", "accept-encoding": "identity", "user-agent": CDN_USER_AGENT } as const;

/** The transport a production build uses. See the header for what it guarantees. */
export function createHttpsTransport(options: HttpsTransportOptions = {}): CdnTransport {
  const request = options.request ?? httpsRequest;
  const lookup = checkedLookup(options.resolve);
  return ({ url, signal }) => {
    // The URL is re-checked here: the socket must never depend on a caller having remembered to.
    if (!checkCdnUrl(url.href).ok) return Promise.reject(new CdnBlockedError("url"));
    return get(
      (callback) =>
        request(
          {
            protocol: "https:",
            host: url.hostname,
            port: 443,
            servername: url.hostname,
            path: `${url.pathname}${url.search}`,
            method: "GET",
            // A fresh agent that keeps nothing: no pooled socket outlives its download.
            agent: false,
            lookup,
            headers: { ...REQUEST_HEADERS },
          },
          callback,
        ),
      signal,
    );
  };
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * The E2E build's transport: sends the allowed URL's path and query to a plain-http mock on this machine. `base` must be
 * `http://` and loopback, with no credentials, query or path of its own; anything else throws.
 */
export function createLoopbackCdnTransport(base: string, request: (options: RequestOptions, callback: (res: IncomingMessage) => void) => ClientRequest = httpRequest): CdnTransport {
  let target: URL;
  try {
    target = new URL(base);
  } catch {
    throw new TypeError("the mock CDN base is not a URL");
  }
  if (target.protocol !== "http:") throw new TypeError("the mock CDN base must be plain http");
  if (target.username !== "" || target.password !== "" || target.search !== "" || target.hash !== "" || (target.pathname !== "/" && target.pathname !== "")) {
    throw new TypeError("the mock CDN base must be a bare host and port");
  }
  if (!LOOPBACK_HOSTS.has(target.hostname)) throw new TypeError("the mock CDN may only be a loopback host");
  const host = target.hostname.replace(/^\[|\]$/g, "");
  const port = target.port === "" ? 80 : Number(target.port);
  return ({ url, signal }) => {
    // The allowlist still runs, so an E2E run proves it; only where the bytes come from differs.
    if (!checkCdnUrl(url.href).ok) return Promise.reject(new CdnBlockedError("url"));
    return get((callback) => request({ host, port, path: `${url.pathname}${url.search}`, method: "GET", agent: false, headers: { ...REQUEST_HEADERS } }, callback), signal);
  };
}
