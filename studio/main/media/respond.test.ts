import { describe, expect, test } from "bun:test";
import { useNativeGlobals, useNativeWebClasses } from "../../testing/nativeGlobals";
import type { ByteSource } from "./diskSource";
import { CHUNK_BYTES, MAX_RANGE_BYTES, respond } from "./respond";
useNativeGlobals();
useNativeWebClasses();

const MP4 = "video/mp4";

/** Bytes in memory whose content is a function of the position, so a wrong slice is visible; every read is recorded. */
function memory(size: number): ByteSource & { reads: { offset: number; length: number }[]; data(): Uint8Array } {
  const reads: { offset: number; length: number }[] = [];
  const byteAt = (i: number): number => (i * 7 + 3) & 0xff;
  return {
    size,
    reads,
    data: () => Uint8Array.from({ length: size }, (_, i) => byteAt(i)),
    async read(offset, length) {
      reads.push({ offset, length });
      return Uint8Array.from({ length }, (_, i) => byteAt(offset + i));
    },
  };
}

/** A source of any size that never allocates it: a read hands back zeros of the length asked for. */
function huge(size: number): ByteSource & { reads: { offset: number; length: number }[] } {
  const reads: { offset: number; length: number }[] = [];
  return {
    size,
    reads,
    async read(offset, length) {
      reads.push({ offset, length });
      return new Uint8Array(length);
    },
  };
}

const bytesOf = async (response: Response): Promise<Uint8Array> => new Uint8Array(await response.arrayBuffer());
const send = (source: ByteSource, range: string | null = null, signal?: AbortSignal) => respond(source, { contentType: MP4, range, signal });

describe("the test really runs on the product's Response", () => {
  test("Response is not happy-dom's", () => {
    expect(String(Response)).not.toContain("Implementation");
  });
});

describe("respond: whole file", () => {
  test("200 with the bytes, the type, the exact length, ranges advertised and nosniff", async () => {
    const source = memory(1000);
    const response = send(source);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(MP4);
    expect(response.headers.get("Content-Length")).toBe("1000");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Range")).toBeNull();
    expect(await bytesOf(response)).toEqual(source.data());
  });

  test("a body that spans several chunks arrives whole and in order", async () => {
    const source = memory(CHUNK_BYTES * 2 + 5);
    expect(await bytesOf(send(source))).toEqual(source.data());
    expect(source.reads.map((r) => r.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 5]);
  });

  test("nothing is read until the body is", async () => {
    const source = memory(1000);
    send(source);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(source.reads).toEqual([]);
  });
});

describe("respond: a range", () => {
  const cases: [string, number, number][] = [
    ["bytes=0-0", 0, 0],
    ["bytes=999-999", 999, 999],
    ["bytes=-1", 999, 999],
    ["bytes=-10", 990, 999],
    ["bytes=990-", 990, 999],
    ["bytes=10-19", 10, 19],
    ["bytes=990-99999", 990, 999],
    ["bytes=-99999", 0, 999],
  ];
  for (const [header, start, end] of cases) {
    test(`${header} is 206 with bytes ${start}-${end}, its Content-Range and its exact length`, async () => {
      const source = memory(1000);
      const response = send(source, header);
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(`bytes ${start}-${end}/1000`);
      expect(response.headers.get("Content-Length")).toBe(String(end - start + 1));
      expect(response.headers.get("Content-Type")).toBe(MP4);
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(await bytesOf(response)).toEqual(source.data().slice(start, end + 1));
    });
  }

  test("a range across a chunk seam has the right bytes", async () => {
    const source = memory(CHUNK_BYTES * 3);
    const response = send(source, `bytes=${CHUNK_BYTES - 3}-${CHUNK_BYTES + 2}`);
    expect(await bytesOf(response)).toEqual(source.data().slice(CHUNK_BYTES - 3, CHUNK_BYTES + 3));
  });

  test("a range is never longer than the cap: the answer stops there and says so in Content-Range", async () => {
    const source = huge(5 * 1024 * 1024 * 1024);
    const response = send(source, "bytes=0-");
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes 0-${MAX_RANGE_BYTES - 1}/${source.size}`);
    expect(response.headers.get("Content-Length")).toBe(String(MAX_RANGE_BYTES));
    expect((await bytesOf(response)).length).toBe(MAX_RANGE_BYTES);
  });

  test("a range exactly at the cap is not shortened", () => {
    const source = huge(5 * 1024 * 1024 * 1024);
    const response = send(source, `bytes=10-${MAX_RANGE_BYTES + 9}`);
    expect(response.headers.get("Content-Range")).toBe(`bytes 10-${MAX_RANGE_BYTES + 9}/${source.size}`);
  });
});

describe("respond: 416", () => {
  const refused = ["bytes=1000-", "bytes=5000-6000", "bytes=-0", "bytes=9-3", "bytes=0-1,4-5", "bytes=", "items=0-1", "garbage", "bytes=0-1-2"];
  for (const header of refused) {
    test(`${JSON.stringify(header)} is 416 with the size in Content-Range, no body and nothing read`, async () => {
      const source = memory(1000);
      const response = send(source, header);
      expect(response.status).toBe(416);
      expect(response.headers.get("Content-Range")).toBe("bytes */1000");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect((await bytesOf(response)).length).toBe(0);
      expect(source.reads).toEqual([]);
    });
  }
});

describe("respond: streaming and memory", () => {
  test("an 8 GiB file is answered without reading it: two chunks read, two chunks asked for, then the renderer goes away", async () => {
    const source = huge(8 * 1024 * 1024 * 1024);
    const response = send(source);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(source.size));
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(CHUNK_BYTES);
    expect((await reader?.read())?.value?.length).toBe(CHUNK_BYTES);
    await reader?.cancel();
    expect(source.reads).toEqual([
      { offset: 0, length: CHUNK_BYTES },
      { offset: CHUNK_BYTES, length: CHUNK_BYTES },
    ]);
  });

  test("no read asks for more than one chunk, however big the range", async () => {
    const source = huge(5 * 1024 * 1024 * 1024);
    await bytesOf(send(source, "bytes=0-"));
    expect(Math.max(...source.reads.map((r) => r.length))).toBe(CHUNK_BYTES);
    expect(source.reads.length).toBe(MAX_RANGE_BYTES / CHUNK_BYTES);
  });

  test("only one read is in flight at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const source: ByteSource = {
      size: CHUNK_BYTES * 8,
      async read(_offset, length) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return new Uint8Array(length);
      },
    };
    await bytesOf(send(source));
    expect(peak).toBe(1);
  });
});

describe("respond: the renderer goes away", () => {
  test("cancelling the body stops reading: no further read, even for a chunk that was in flight", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads: number[] = [];
    const source: ByteSource = {
      size: CHUNK_BYTES * 4,
      async read(offset, length) {
        reads.push(offset);
        if (offset > 0) await gate;
        return new Uint8Array(length);
      },
    };
    const reader = send(source).body?.getReader();
    await reader?.read();
    const second = reader?.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await reader?.cancel();
    release();
    await second?.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reads).toEqual([0, CHUNK_BYTES]);
  });

  test("an abort signal mid-stream ends the body with an error and reads nothing more", async () => {
    const source = memory(CHUNK_BYTES * 4);
    const controller = new AbortController();
    const reader = send(source, null, controller.signal).body?.getReader();
    await reader?.read();
    controller.abort();
    await expect(reader?.read()).rejects.toBeDefined();
    expect(source.reads.length).toBe(1);
  });

  test("a signal that is already aborted reads nothing at all", async () => {
    const source = memory(CHUNK_BYTES * 4);
    const controller = new AbortController();
    controller.abort();
    const reader = send(source, null, controller.signal).body?.getReader();
    await expect(reader?.read()).rejects.toBeDefined();
    expect(source.reads).toEqual([]);
  });

  test("a finished body leaves no listener on the signal to keep it alive", async () => {
    const controller = new AbortController();
    let added = 0;
    let removed = 0;
    const add = controller.signal.addEventListener.bind(controller.signal);
    const remove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = ((...args: Parameters<typeof add>) => {
      added++;
      return add(...args);
    }) as typeof add;
    controller.signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      removed++;
      return remove(...args);
    }) as typeof remove;
    await bytesOf(send(memory(100), null, controller.signal));
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

describe("respond: a source that fails", () => {
  test("a read that rejects errors the body after the chunks already sent, and never hangs", async () => {
    let calls = 0;
    const source: ByteSource = {
      size: CHUNK_BYTES * 3,
      async read(_offset, length) {
        if (++calls === 2) throw new Error("the file changed after it was checked");
        return new Uint8Array(length);
      },
    };
    const reader = send(source).body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(CHUNK_BYTES);
    await expect(reader?.read()).rejects.toThrow();
    expect(calls).toBe(2);
  });
});
