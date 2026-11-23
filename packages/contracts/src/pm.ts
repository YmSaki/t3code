import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const ThreadRole = Schema.Literals(["standard", "pm", "worker"]);
export type ThreadRole = typeof ThreadRole.Type;

export const PM_MAX_DISPATCH_BATCH_ITEMS = 16;

export const PmTarget = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type PmTarget = typeof PmTarget.Type;

export const PmWorkerPolicy = Schema.Struct({
  maxConcurrentWorkers: PositiveInt,
  requireWorktreeIsolation: Schema.Boolean,
  allowNestedDelegation: Schema.Boolean,
  allowedTargets: Schema.Array(PmTarget).annotate({
    description: "Empty means any member of the PM's MetaProject.",
  }),
  maxDelegatedTurns: PositiveInt,
  directEditSuppressedProviders: Schema.Array(ProviderDriverKind).annotate({
    description: "Providers whose PM thread must delegate edits instead of editing directly.",
  }),
});
export type PmWorkerPolicy = typeof PmWorkerPolicy.Type;

export const WorkerLineRange = Schema.Struct({
  start: PositiveInt,
  end: PositiveInt,
}).check(
  Schema.makeFilter((range) => range.end >= range.start || "Expected end to be at least start."),
);
export type WorkerLineRange = typeof WorkerLineRange.Type;

export const WorkerRelatedFile = Schema.Struct({
  path: TrimmedNonEmptyString,
  reason: Schema.optional(TrimmedNonEmptyString),
  lineRange: Schema.optional(WorkerLineRange),
});
export type WorkerRelatedFile = typeof WorkerRelatedFile.Type;

export const WorkerContextBrief = Schema.Struct({
  objective: TrimmedNonEmptyString,
  background: Schema.String,
  constraints: Schema.Array(TrimmedNonEmptyString),
  relatedFiles: Schema.Array(WorkerRelatedFile),
  completionCriteria: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  verificationCommands: Schema.Array(TrimmedNonEmptyString),
});
export type WorkerContextBrief = typeof WorkerContextBrief.Type;

export const PmWorkerStatus = Schema.Literals([
  "queued",
  "running",
  "waiting_approval",
  "waiting_input",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
export type PmWorkerStatus = typeof PmWorkerStatus.Type;

export const PmBoardWorkerSummary = Schema.Struct({
  threadId: ThreadId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  status: PmWorkerStatus,
  targetRepoRole: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  turnCount: NonNegativeInt,
  lastMessagePreview: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type PmBoardWorkerSummary = typeof PmBoardWorkerSummary.Type;

export const PmBoardSnapshot = Schema.Struct({
  pmThreadId: ThreadId,
  metaProjectId: Schema.NullOr(TrimmedNonEmptyString),
  policy: PmWorkerPolicy,
  killSwitchActive: Schema.Boolean,
  delegatedTurnCount: NonNegativeInt,
  workers: Schema.Array(PmBoardWorkerSummary),
  generatedAt: IsoDateTime,
});
export type PmBoardSnapshot = typeof PmBoardSnapshot.Type;

export const PmDispatchBatchItem = Schema.Struct({
  clientKey: TrimmedNonEmptyString.annotate({
    description: "Caller-chosen key, unique within the batch, echoed back in the result.",
  }),
  title: TrimmedNonEmptyString,
  targetRepoRole: Schema.optional(TrimmedNonEmptyString),
  targetRepoName: Schema.optional(TrimmedNonEmptyString),
  target: Schema.optional(PmTarget),
  brief: WorkerContextBrief,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  runtimeMode: Schema.optional(RuntimeMode),
  useWorktree: Schema.optional(Schema.Boolean),
});
export type PmDispatchBatchItem = typeof PmDispatchBatchItem.Type;

export const PmDispatchBatchInput = Schema.Struct({
  pmThreadId: ThreadId,
  items: Schema.Array(PmDispatchBatchItem).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(PM_MAX_DISPATCH_BATCH_ITEMS),
  ),
});
export type PmDispatchBatchInput = typeof PmDispatchBatchInput.Type;

export const PmDispatchRejectionReason = Schema.Literals([
  "requester_not_pm",
  "kill_switch_active",
  "nested_delegation_forbidden",
  "delegation_depth_exceeded",
  "concurrency_limit",
  "delegated_turn_limit",
  "duplicate_client_key",
  "target_unresolved",
  "target_ambiguous",
  "target_not_allowed",
  "worktree_required",
]);
export type PmDispatchRejectionReason = typeof PmDispatchRejectionReason.Type;

export const PmDispatchAccepted = Schema.Struct({
  clientKey: TrimmedNonEmptyString,
  threadId: ThreadId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  useWorktree: Schema.Boolean,
});
export type PmDispatchAccepted = typeof PmDispatchAccepted.Type;

export const PmDispatchRejected = Schema.Struct({
  clientKey: TrimmedNonEmptyString,
  reason: PmDispatchRejectionReason,
  detail: Schema.String,
});
export type PmDispatchRejected = typeof PmDispatchRejected.Type;

export const PmDispatchBatchResult = Schema.Struct({
  pmThreadId: ThreadId,
  dispatched: Schema.Array(PmDispatchAccepted),
  rejected: Schema.Array(PmDispatchRejected),
});
export type PmDispatchBatchResult = typeof PmDispatchBatchResult.Type;

export class PmThreadNotFoundError extends Schema.TaggedError<PmThreadNotFoundError>()(
  "PmThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return `Thread '${this.threadId}' does not exist.`;
  }
}

export class PmRoleRequiredError extends Schema.TaggedError<PmRoleRequiredError>()(
  "PmRoleRequiredError",
  { threadId: ThreadId, actualRole: ThreadRole },
) {
  override get message(): string {
    return `Thread '${this.threadId}' has role '${this.actualRole}', but this action requires a PM thread.`;
  }
}

export class PmKillSwitchActiveError extends Schema.TaggedError<PmKillSwitchActiveError>()(
  "PmKillSwitchActiveError",
  {
    scope: Schema.Literals(["global", "thread"]),
    threadId: Schema.optional(ThreadId),
  },
) {
  override get message(): string {
    return this.scope === "global"
      ? "PM delegation is stopped by the global kill switch."
      : `PM delegation is stopped for thread '${this.threadId ?? "unknown"}'.`;
  }
}

export class PmDispatchRejectedError extends Schema.TaggedError<PmDispatchRejectedError>()(
  "PmDispatchRejectedError",
  {
    reason: PmDispatchRejectionReason,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `PM dispatch rejected (${this.reason}): ${this.detail}`;
  }
}

export class PmDispatchError extends Schema.TaggedError<PmDispatchError>()("PmDispatchError", {
  clientKey: Schema.optional(TrimmedNonEmptyString),
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return this.clientKey === undefined
      ? "PM dispatch failed."
      : `PM dispatch failed for '${this.clientKey}'.`;
  }
}
