import type { FetchedList, MusicListSink } from "../service";

/**
 * Test-only: a sink that stands in for 3c.4's persisting one. It keeps the list in memory but says `persistent: true`,
 * so the service lets a refresh through. Production code never imports this file.
 */
export class PersistingTestSink implements MusicListSink {
  readonly persistent = true;
  readonly accepted: FetchedList[] = [];

  accept(list: FetchedList, progress: (done: number, total: number) => void, _signal?: AbortSignal): Promise<void> {
    this.accepted.push(list);
    progress(1, 1);
    return Promise.resolve();
  }

  summary(): { listFetchedAt: number | null; trackCount: number; bytesOnDisk: number } {
    const last = this.accepted.at(-1);
    return { listFetchedAt: last?.fetchedAt ?? null, trackCount: last?.tracks.length ?? 0, bytesOnDisk: 0 };
  }
}
