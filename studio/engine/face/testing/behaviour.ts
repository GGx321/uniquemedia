// What the FIRST BYTE of a request scripts in scriptedFaceWorker.ts (a separate file: the worker file itself runs on import).
export const Behaviour = {
  /** Answers at once. */
  ok: 0,
  /** Never answers, like a computation that does not finish. */
  hang: 1,
  /** Throws an uncaught exception: the worker dies. */
  crash: 2,
  /** Answers with something that is not in the protocol. */
  garbage: 3,
  /** Reports an ordinary failure (the worker stays healthy). */
  fail: 4,
  /** Reports "the reference has no face". */
  noFace: 5,
  /** Answers after ~80 ms of asynchronous waiting. */
  slow: 6,
  /** Answers, then sends an unsolicited message ~20 ms later (while the worker is idle). */
  chatty: 7,
} as const;
