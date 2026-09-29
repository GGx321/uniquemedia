// The video commit pipeline and its crash recovery (Stage 3 plan, 3a.8b.1).
// What `videos.render`, `videos.list` and `videos.delete` (3a.8b.2) wire:
//   - `createRenderExecute` -> `RenderQueue.submit({ execute })`, with a `CommitTracker`;
//   - `recoverVideos` when a library opens (and `sweepRenderTmp` beside it);
//   - `FileStateChecker` for `videos.list`, `deleteVideo` for `videos.delete`.
export { commitVideo, VerifyRefusedError, type CommitDeps, type CommitInput, type CommittedVideo, type CommitStep, type CommitTarget } from "./commit";
export { NODE_COMMIT_FS, type CommitFs } from "./commitFs";
export { deleteVideo, VideoNotFoundError, VideoRecordUnreadableError, type DeleteOutcome, type DeleteVideoDeps } from "./delete";
export { createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
export { DEFAULT_HASH_BUDGET_BYTES, FileStateChecker, newHashBudget, recordFilePath, type HashBudget, type Verification } from "./fileState";
export { buildForbiddenStrings, collectForbiddenStrings, ENGINE_SIGNATURE_STRINGS, FORBIDDEN_STRING_MIN_LENGTH, photoMetadataStrings } from "./forbiddenStrings";
export { CommitTracker, type LiveCommits } from "./live";
export { indexCommittedRecord, type IndexOutcome, type IndexPort } from "./indexRecord";
export { partNameOf, PENDING_DIR, scenePhotoIds, videoPaths, VideoFileRef, VideoRecordSchema, type VideoPaths, type VideoRecord } from "./record";
export { recoverVideos, type DropReason, type ExportRootRef, type RecoverDeps, type RecoverInput, type RecoveryReport } from "./recovery";
