import type { MediaKind, MediaPickKind, MediaUnsupportedReason, PickedFileIdentity } from "../../shared/engine";
import type { MediaFacts } from "../library/mediaRecords";
import type { MediaFormat } from "./sniff";
import type { StagedMedia, WorkFile } from "./staging";

// The hand-off from the import job to the per-kind importers (3f.2 photos, 3f.3a video, 3f.4 music, 3f.5 stickers).
//
// The job (`service.ts`) opens the picked file, copies it into the library's staging folder with progress, and calls the kind's importer
// with that STAGED copy (`request.staged`: a file inside the staging folder, its size, its sha256, its first bytes, the container its
// bytes are). The importer never gets the picked path and reads the staged copy only. It answers what it learned of the file (`facts`)
// and, when it made a new file (a normalised video, a re-encoded photo), that file; with no `output` the staged copy itself is stored
// as it is. The JOB stores the file and writes the record, and removes the staged copy and every work file whatever happens: the
// importer owns nothing and removes nothing of its own beyond what it made for itself outside the staging folder.
//
// The importer runs INSIDE the job, so it may take as long as a 3 minute video takes. What it owes the job is the SIGNAL: when
// `request.signal` fires (the owner's cancel, the engine stopping) it stops within seconds and stops writing. An answer it gives
// after the signal is thrown away, and its work files are released.

export interface MediaImportRequest {
  readonly staged: StagedMedia;
  /** The picked file's base name, for display; the library stores it as the record's name. */
  readonly name: string;
  /** Fires on `media.cancelImport` and when the engine stops. */
  readonly signal: AbortSignal;
  /** A fresh, held name inside the staging folder for a file the importer makes; hand the same `WorkFile` back in `output`. */
  readonly workFile: () => Promise<WorkFile>;
}

export type MediaImportOutcome =
  | {
      ok: true;
      /** What the importer learned of the file it answers with; which fields a kind has is the contract's (`MediaSummary`). */
      facts: MediaFacts;
      /** The file the importer made, from `workFile()`. Absent: the staged copy is stored as it is. */
      output?: { file: WorkFile; format: MediaFormat; sha256?: string };
      /**
       * A track's waveform (3f.4): one value per 50 ms, each an integer 0 to 1000 (the track store's envelope), kept in the record for
       * `music.peaks`. Only an audio importer gives one.
       */
      waveform?: readonly number[];
    }
  | { ok: false; reason: MediaUnsupportedReason };
export type MediaImporter = (request: MediaImportRequest) => Promise<MediaImportOutcome>;
export type MediaImporters = Partial<Record<MediaKind, MediaImporter>>;

/** One picked file, as main's check and the control channel describe it. */
export interface MediaImportCall {
  readonly pick: MediaPickKind;
  readonly path: string;
  readonly name: string;
  /** The identity main saw when the dialog answered. */
  readonly expected: PickedFileIdentity;
}

/** The answer to `media.import`: a job that has started (its copy has not been made yet), or the file's refusal. */
export type MediaImportResult = { ok: true; jobId: string } | { ok: false; reason: MediaUnsupportedReason; detail: string };
