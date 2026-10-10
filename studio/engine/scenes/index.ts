// Public surface of the scene planner (T5a). T6 (the job queue) is the
// intended consumer: it calls `plan()`, persists the result as the run's
// plan.json (Library.createRun) and turns each slot's `attemptIdBase` into
// real ledger attempt ids.
export { CATEGORIES, SHOTS, type Category, type PlannerCategory, type Shot } from "./types";
export { BUILT_IN_LABEL, categoryLabelOf, categoryRefOf, categoryStyleOf, photoCategoryOf, plannerCategoryOf, type CategoryLabelOf } from "./categories";
export { allowedActivities, BuiltInPoolSchema, isPhoneActivity, POOLS, PoolSchema, validatePools, type Activity, type Place, type Pool } from "./pools";
export { roomPlaceOf, type RoomSlotKey } from "./roomPlace";
export {
  AttemptIdBaseSchema,
  CategorySchema,
  isOwnSlot,
  isPhoneInHandShot,
  OwnPlanSlotSchema,
  PlanSlotSchema,
  PlannerCategorySchema,
  PoseSchema,
  ScenePlanSchema,
  ShotSchema,
  type OwnPlanSlot,
  type PlanSlot,
  type Pose,
  type RunSlot,
  type ScenePlan,
} from "./schema";
export { explicitSplit, plan, placeMirrorShots, planWithPools, type ExcludedPair, type PlanInput } from "./planner";
export { drawPose, NO_EXTRA_POSES, POSE_WEIGHTS, type PoseAllowance } from "./poses";
export {
  contradictsPose,
  emptyAnswerRefusal,
  isTwoHanded,
  readWriterAnswer,
  revealingWordsIn,
  type ReadableSlot,
  writerMessages,
  writerRefusalText,
  writerRunPrice,
  WRITER_JSON_SCHEMA,
  WriterOutputSchema,
  WriterSceneSchema,
  type WriterAnswer,
  type WriterOutput,
  type WriterProblem,
  type WriterRefusal,
  type WriterScene,
} from "./writer";
export { assembleRun, assembleSlot, AssemblerRefusalError, sentenceProblems, type AssembledScene, type AssembleOptions, type SentenceProblem } from "./assembler";
