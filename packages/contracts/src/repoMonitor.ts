import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const RepoMonitorRuleId = TrimmedNonEmptyString.pipe(Schema.brand("RepoMonitorRuleId"));
export type RepoMonitorRuleId = typeof RepoMonitorRuleId.Type;

export const RepoMonitorEventId = TrimmedNonEmptyString.pipe(Schema.brand("RepoMonitorEventId"));
export type RepoMonitorEventId = typeof RepoMonitorEventId.Type;

export const RepoMonitorEventKind = Schema.Literals([
  "branch_push",
  "pr_opened",
  "pr_merged",
  "pr_comment",
  "issue_opened",
  "issue_comment",
]);
export type RepoMonitorEventKind = typeof RepoMonitorEventKind.Type;

export const RepoMonitorActionKind = Schema.Literals([
  "notify_pm",
  "launch_thread",
  "send_to_thread",
]);
export type RepoMonitorActionKind = typeof RepoMonitorActionKind.Type;

export const RepoMonitorFilter = Schema.Struct({
  branchGlobs: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  requiredLabels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  excludedLabels: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  allowedAuthors: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  excludedAuthors: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  excludeBots: Schema.optional(Schema.Boolean),
  keywords: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});
export type RepoMonitorFilter = typeof RepoMonitorFilter.Type;

export const RepoMonitorRule = Schema.Struct({
  id: RepoMonitorRuleId,
  projectId: ProjectId,
  environmentId: Schema.optional(EnvironmentId),
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  eventKinds: Schema.Array(RepoMonitorEventKind).check(Schema.isMinLength(1)),
  filter: RepoMonitorFilter,
  actionKind: RepoMonitorActionKind,
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  runtimeMode: Schema.optional(RuntimeMode),
  promptTemplate: TrimmedNonEmptyString,
  cooldownSec: NonNegativeInt,
  maxTriggersPerHour: PositiveInt,
  presetId: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type RepoMonitorRule = typeof RepoMonitorRule.Type;

export const RepoMonitorCursor = Schema.Struct({
  projectId: ProjectId,
  branchHeads: Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
  knownPullRequestNumbers: Schema.Array(PositiveInt),
  mergedPullRequestNumbers: Schema.Array(PositiveInt),
  knownPullRequestCommentIds: Schema.Array(TrimmedNonEmptyString),
  knownIssueKeys: Schema.Array(TrimmedNonEmptyString),
  knownIssueCommentIds: Schema.Array(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type RepoMonitorCursor = typeof RepoMonitorCursor.Type;

export const RepoMonitorEventOutcome = Schema.Literals([
  "triggered",
  "skipped_disabled",
  "skipped_kill_switch",
  "skipped_loop_guard",
  "skipped_dedupe",
  "skipped_cooldown",
  "skipped_rate_limit",
  "dry_run",
]);
export type RepoMonitorEventOutcome = typeof RepoMonitorEventOutcome.Type;

export const RepoMonitorEventRecord = Schema.Struct({
  id: RepoMonitorEventId,
  ruleId: RepoMonitorRuleId,
  projectId: ProjectId,
  eventKind: RepoMonitorEventKind,
  dedupeKey: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  authorLogin: Schema.NullOr(TrimmedNonEmptyString),
  isBot: Schema.Boolean,
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  commitSha: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pullRequestNumber: Schema.optional(Schema.NullOr(PositiveInt)),
  issueKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  commentId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  outcome: RepoMonitorEventOutcome,
  dispatchedThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  renderedPrompt: Schema.optional(Schema.NullOr(Schema.String)),
  occurredAt: IsoDateTime,
});
export type RepoMonitorEventRecord = typeof RepoMonitorEventRecord.Type;

export const RepoMonitorDryRunResult = Schema.Struct({
  ruleId: RepoMonitorRuleId,
  projectId: ProjectId,
  evaluatedAt: IsoDateTime,
  matchedEvents: Schema.Array(RepoMonitorEventRecord),
  nextCursor: RepoMonitorCursor,
  renderedPrompts: Schema.Array(Schema.String),
  skippedCount: NonNegativeInt,
});
export type RepoMonitorDryRunResult = typeof RepoMonitorDryRunResult.Type;

export const RepoMonitorRuleListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type RepoMonitorRuleListInput = typeof RepoMonitorRuleListInput.Type;

export const RepoMonitorRuleListResult = Schema.Struct({
  globalKillSwitch: Schema.Boolean,
  rules: ForwardCompatibleArray(RepoMonitorRule),
});
export type RepoMonitorRuleListResult = typeof RepoMonitorRuleListResult.Type;

export const RepoMonitorRuleUpsertInput = Schema.Struct({
  id: Schema.optional(RepoMonitorRuleId),
  projectId: ProjectId,
  environmentId: Schema.optional(EnvironmentId),
  name: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  eventKinds: Schema.Array(RepoMonitorEventKind).check(Schema.isMinLength(1)),
  filter: RepoMonitorFilter,
  actionKind: RepoMonitorActionKind,
  targetThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  runtimeMode: Schema.optional(RuntimeMode),
  promptTemplate: TrimmedNonEmptyString,
  cooldownSec: Schema.optional(NonNegativeInt),
  maxTriggersPerHour: Schema.optional(PositiveInt),
  presetId: Schema.optional(TrimmedNonEmptyString),
});
export type RepoMonitorRuleUpsertInput = typeof RepoMonitorRuleUpsertInput.Type;

export const RepoMonitorRuleDeleteInput = Schema.Struct({
  id: RepoMonitorRuleId,
});
export type RepoMonitorRuleDeleteInput = typeof RepoMonitorRuleDeleteInput.Type;

export const RepoMonitorDryRunInput = Schema.Struct({
  ruleId: RepoMonitorRuleId,
});
export type RepoMonitorDryRunInput = typeof RepoMonitorDryRunInput.Type;

export class RepoMonitorError extends Schema.TaggedError<RepoMonitorError>()("RepoMonitorError", {
  message: Schema.String,
  ruleId: Schema.optional(RepoMonitorRuleId),
  cause: Schema.optional(Schema.Defect()),
}) {}
