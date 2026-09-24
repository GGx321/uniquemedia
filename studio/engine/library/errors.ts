export type LibraryErrorCode =
  | "not-a-library"
  | "invalid-library-file"
  | "library-too-new"
  | "invalid-id"
  | "invalid-record"
  | "avatar-not-found"
  | "photo-not-found"
  | "media-type-mismatch"
  | "run-exists"
  | "run-not-found"
  | "invalid-run-plan"
  | "corrupt-log"
  | "log-needs-repair";

export class LibraryError extends Error {
  readonly code: LibraryErrorCode;

  constructor(code: LibraryErrorCode, message: string) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
  }
}
