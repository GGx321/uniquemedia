import type { ImportPrepare, MediaKind, MediaPickKind, MediaUnsupportedReason, PickedFileIdentity } from "../../shared/engine";
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

/**
 * How an importer tells the job how far its own work has got (3f.6), so the window shows a percent while a video is being normalised and not a
 * bar stuck at the end of the copy. The units are the importer's: output frames for a video, output milliseconds for a track, coarse steps for a
 * photo and a sticker. The job owns what it makes of it: the stage's own total, a percent at a time, never a full bar before the record is stored,
 * nothing from an importer that is early (before `begin`) or late (after the job ended), and a `total` that is no positive count is no stage.
 * An importer that never calls it leaves the job as it was before the stage existed.
 */
export interface PrepareReporter {
  /** The importer's work begins: `total` units of it (at least one), and, for a video, what the probe judged. Once per job; a second call is ignored. */
  begin(total: number, judged?: ImportPrepare): void;
  /** `done` units are finished. Monotonic by the job's own clamp; the importer need not throttle, the job announces a percent at a time. */
  report(done: number): void;
}

const NO_PREPARE: PrepareReporter = { begin: () => undefined, report: () => undefined };

/**
 * A reporter an importer may call without a thought (3f.6): a throw of the job's reporter is absorbed here, once, for every importer (a reporter is an observer: its
 * failure is never the import's, and in an ffmpeg's `onFrames` it would kill the encode), and no reporter at all is one that does nothing.
 */
export function observer(prepare: PrepareReporter | undefined): PrepareReporter {
  if (prepare === undefined) return NO_PREPARE;
  return {
    begin: (total, judged) => {
      try {
        prepare.begin(total, judged);
      } catch {
        // Ignored: see above.
      }
    },
    report: (done) => {
      try {
        prepare.report(done);
      } catch {
        // Ignored: see above.
      }
    },
  };
}

export interface MediaImportRequest {
  readonly staged: StagedMedia;
  /** The picked file's base name, for display; the library stores it as the record's name. */
  readonly name: string;
  /** Fires on `media.cancelImport` and when the engine stops. */
  readonly signal: AbortSignal;
  /** A fresh, held name inside the staging folder for a file the importer makes; hand the same `WorkFile` back in `output`. */
  readonly workFile: () => Promise<WorkFile>;
  /** The job's progress reporter. Absent in a test that does not watch progress (and for a caller that has none); an importer calls it as `request.prepare?.begin(...)`. */
  readonly prepare?: PrepareReporter | undefined;
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
