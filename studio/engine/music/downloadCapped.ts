import { CdnBlockedError, type CdnTransport } from "./cdnTransport";
import { checkCdnUrl, hostForLog } from "./cdnPolicy";

// One download under invariant 31: the URL is checked BEFORE anything is requested, a redirect is a failure (never
// followed, not even to another allowed host), only a plain 200 with an uncompressed body counts, the size is capped by
// the declared length and again by what actually arrives, and a body that stalls or trickles is ended. The bytes are read
// into memory (at most the cap: 25 MB for a track, 2 MB for a cover) and handed back; nothing here touches a file.
// A failure names the KIND and the HOST only: the URL is signed and never appears in an error, a log line or a message.

export type DownloadFailureKind =
  | "refused"
  | "blocked-address"
  | "no-mock"
  | "redirect"
  | "status"
  | "encoding"
  | "too-large"
  | "length-mismatch"
  | "empty"
  | "timeout"
  | "aborted"
  | "network";

export class DownloadError extends Error {
  readonly kind: DownloadFailureKind;
  readonly host: string;
  readonly status: number | null;

  constructor(kind: DownloadFailureKind, host: string, detail: string, status: number | null = null) {
    super(`${kind} (host ${host})${detail === "" ? "" : `: ${detail}`}`);
    this.name = "DownloadError";
    this.kind = kind;
    this.host = host;
    this.status = status;
  }
}

export interface DownloadOptions {
  transport: CdnTransport;
  /** The signed URL from the list. Checked here; never logged. */
  url: string;
  maxBytes: number;
  signal: AbortSignal;
  /** The whole download, from the request to the last byte. */
  timeoutMs?: number;
  /** The longest the body may go without a byte. */
  idleMs?: number;
}

export interface Downloaded {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

/** 25 MB at a poor 1 MB/s is 25 s; two minutes is room for a bad link and still a bound. */
export const DOWNLOAD_TIMEOUT_MS = 120_000;
export const DOWNLOAD_IDLE_MS = 20_000;

const REDIRECTS: ReadonlySet<number> = new Set([300, 301, 302, 303, 305, 307, 308]);

const declaredLength = (value: string | undefined): number | null => (value !== undefined && /^\d{1,12}$/.test(value.trim()) ? Number(value.trim()) : null);

/** A runtime's own error code (`ECONNRESET`), and nothing else of the error: its text may carry the URL. */
function codeOf(error: unknown): string {
  const code: unknown = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code) ? code : "";
}

export async function downloadCapped(options: DownloadOptions): Promise<Downloaded> {
  const checked = checkCdnUrl(options.url);
  if (!checked.ok) throw new DownloadError("refused", checked.host, checked.reason);
  const host = hostForLog(options.url);
  if (options.signal.aborted) throw new DownloadError("aborted", host, "");

  const timeoutMs = options.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const idleMs = options.idleMs ?? DOWNLOAD_IDLE_MS;
  const controller = new AbortController();
  let ended: DownloadError | null = null;
  // `end` records why the transfer stopped (the first reason wins) and aborts everything tied to it.
  const end = (error: DownloadError): void => {
    ended ??= error;
    controller.abort();
  };
  const onCallerAbort = (): void => end(new DownloadError("aborted", host, ""));
  options.signal.addEventListener("abort", onCallerAbort, { once: true });
  const total = setTimeout(() => end(new DownloadError("timeout", host, `no answer within ${timeoutMs} ms`)), timeoutMs);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = (): void => {
    clearTimeout(idle);
    idle = setTimeout(() => end(new DownloadError("timeout", host, `no data for ${idleMs} ms`)), idleMs);
  };
  // Settles when the transfer is ended, so a body that ignores the abort cannot hold this call open.
  const stopped = new Promise<never>((_resolve, reject) => {
    controller.signal.addEventListener("abort", () => reject(ended ?? new DownloadError("aborted", host, "")), { once: true });
  });
  stopped.catch(() => undefined);

  let response: Awaited<ReturnType<CdnTransport>> | null = null;
  try {
    armIdle();
    try {
      response = await Promise.race([options.transport({ url: checked.url, signal: controller.signal }), stopped]);
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      // The transport's own reason, not one label for all: only an address refusal is a blocked address.
      if (error instanceof CdnBlockedError) throw new DownloadError(error.reason === "address" ? "blocked-address" : error.reason === "no-mock" ? "no-mock" : "refused", host, error.reason);
      const code = codeOf(error);
      throw new DownloadError("network", host, code === "" ? "the request failed" : `the request failed (${code})`);
    }

    if (REDIRECTS.has(response.status)) throw new DownloadError("redirect", host, `answered ${response.status}`, response.status);
    if (response.status !== 200) throw new DownloadError("status", host, `answered ${response.status}`, response.status);
    const encoding = response.headers["content-encoding"]?.trim().toLowerCase();
    if (encoding !== undefined && encoding !== "" && encoding !== "identity") throw new DownloadError("encoding", host, "the body is compressed");
    const declared = declaredLength(response.headers["content-length"]);
    if (declared !== null && declared > options.maxBytes) throw new DownloadError("too-large", host, `declares ${declared} bytes, over the cap of ${options.maxBytes}`);

    const chunks: Uint8Array[] = [];
    let received = 0;
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await Promise.race([iterator.next(), stopped]);
        if (next.done === true) break;
        armIdle();
        received += next.value.byteLength;
        // The cap holds on what ARRIVES, whatever the headers said: the rest of an oversize body is never read.
        if (received > options.maxBytes) throw new DownloadError("too-large", host, `sent more than the cap of ${options.maxBytes} bytes`);
        if (declared !== null && received > declared) throw new DownloadError("length-mismatch", host, "sent more than it declared");
        chunks.push(next.value);
      }
    } catch (error) {
      if (error instanceof DownloadError) throw error;
      const code = codeOf(error);
      throw new DownloadError("network", host, code === "" ? "the body failed" : `the body failed (${code})`);
    } finally {
      // A body that never ends or ignores destroy() must not be waited on.
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
    if (received === 0) throw new DownloadError("empty", host, "");
    if (declared !== null && received !== declared) throw new DownloadError("length-mismatch", host, `declared ${declared} bytes, got ${received}`);

    const bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return { bytes, contentType: response.headers["content-type"] ?? null };
  } catch (error) {
    // The first reason recorded wins: a timeout that fired must not be reported as the network error it caused.
    throw ended ?? error;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
    options.signal.removeEventListener("abort", onCallerAbort);
    // Always stopped, success included: no socket outlives its download.
    response?.destroy();
    controller.abort();
  }
}
