import { EngineNotice, type NoticeCode } from "../shared/engine";

/** A notice's `detail` travels as T0 `SafeText`, which allows at most 500 chars. */
const MAX_DETAIL = 500;

export interface HostNoticesDeps {
  newId: () => string;
  /** Wall clock, epoch ms: when the notice was raised. */
  clock: () => number;
}

/**
 * What main has to tell the windows: the engine restarted after a crash,
 * settings.json was reset. Main never emits events itself — an event with a
 * bootId other than the engine's means "the engine restarted" to the
 * renderer. Main keeps the notices of this app session instead, and every
 * engine (re)start gets all of them in `init`: the engine keeps them pending
 * in its snapshot (so a window opened later still shows them) and emits each
 * as an `engine.notice` in its own seq/bootId stream (so open windows of a
 * restarted engine resync and see it). Nothing waits for a snapshot.
 *
 * The list is bounded: a notice that happens again replaces the earlier one
 * of its kind (a crash more than five minutes after the last one is restarted
 * again, without end), so there is at most one entry per notice code.
 */
export class HostNotices {
  readonly #deps: HostNoticesDeps;
  readonly #notices: EngineNotice[] = [];

  constructor(deps: HostNoticesDeps) {
    this.#deps = deps;
  }

  /**
   * Records a notice for the next engine start, replacing an earlier one of
   * the same code (counted); parsed with the contract, so a bad one fails
   * here, not in the engine.
   */
  add(code: NoticeCode, detail?: string): EngineNotice {
    const earlier = this.#notices.findIndex((n) => n.code === code);
    const notice = EngineNotice.parse({
      noticeId: this.#deps.newId(),
      code,
      ...(detail === undefined ? {} : { detail: detail.length <= MAX_DETAIL ? detail : `${detail.slice(0, MAX_DETAIL - 1)}…` }),
      at: new Date(this.#deps.clock()).toISOString(),
      count: earlier === -1 ? 1 : (this.#notices[earlier]?.count ?? 0) + 1,
    });
    if (earlier === -1) this.#notices.push(notice);
    else this.#notices[earlier] = notice;
    return notice;
  }

  /** Every notice of this app session, oldest first: what `init` carries. */
  get all(): readonly EngineNotice[] {
    return this.#notices;
  }
}
