// The two ways an own-sticker encode fails that the importer tells apart (3f.5). They live in a module of their own so that the engine's bundle can
// know them without bringing the APNG writer (and its hand-written deflate) in: the writer belongs to the encode worker thread alone
// (bundleChecks.ts's `stickerEncodeWorkerProblems` and runtime.test.ts hold it there).

/** The finished file would pass the byte limit. */
export class EncodeTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`the encoded sticker passes ${maxBytes} bytes`);
    this.name = "EncodeTooLargeError";
  }
}

/** The worker (or the engine's stand-in for one) failed, was ended, ran out of time, or the job could not be encoded: the owner's file is not to blame. */
export class EncodeWorkerError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "EncodeWorkerError";
  }
}
