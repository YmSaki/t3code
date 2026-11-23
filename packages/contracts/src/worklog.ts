import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const WorklogEntryId = TrimmedNonEmptyString.pipe(Schema.brand("WorklogEntryId"));
export type WorklogEntryId = typeof WorklogEntryId.Type;

export const WorklogSource = Schema.Literals(["t3_run", "imported_cli"]);
export type WorklogSource = typeof WorklogSource.Type;

export const WorklogThreadRole = Schema.Literals(["pm", "worker", "standard"]);
export type WorklogThreadRole = typeof WorklogThreadRole.Type;

export const WorklogEntryStatus = Schema.Literals([
  "running",
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);
export type WorklogEntryStatus = typeof WorklogEntryStatus.Type;

export const NonNegativeNumber = Schema.Number.check(Schema.isGreaterThanOrEqualTo(0));
export type NonNegativeNumber = typeof NonNegativeNumber.Type;

export const UnitRatio = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
export type UnitRatio = typeof UnitRatio.Type;

export const WorklogDayKey = TrimmedNonEmptyString.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/),
).pipe(Schema.brand("WorklogDayKey"));
export type WorklogDayKey = typeof WorklogDayKey.Type;

export const WorklogStatsSummary = Schema.Struct({
  changedFilesCount: NonNegativeInt,
  commandsCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedTokens: NonNegativeInt,
  estimatedCostUsd: NonNegativeNumber,
});
export type WorklogStatsSummary = typeof WorklogStatsSummary.Type;

export const AgentWorklogEntry = Schema.Struct({
  id: WorklogEntryId,
  source: WorklogSource,
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  threadRole: WorklogThreadRole,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  summary: Schema.optional(Schema.String),
  status: WorklogEntryStatus,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  turnCount: PositiveInt,
  stats: WorklogStatsSummary,
  threadUrl: Schema.optional(TrimmedNonEmptyString),
});
export type AgentWorklogEntry = typeof AgentWorklogEntry.Type;

export const MergedWorklogBlock = Schema.Struct({
  id: TrimmedNonEmptyString,
  entryIds: Schema.Array(WorklogEntryId).check(Schema.isMinLength(1)),
  source: WorklogSource,
  environmentId: EnvironmentId,
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.optional(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  threadRole: WorklogThreadRole,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.optional(ProviderInstanceId),
  model: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  summary: Schema.optional(Schema.String),
  status: WorklogEntryStatus,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  activeDurationMs: Schema.optional(NonNegativeInt),
  turnCount: PositiveInt,
  gapToleranceMinutes: NonNegativeInt,
  stats: WorklogStatsSummary,
  threadUrl: Schema.optional(TrimmedNonEmptyString),
});
export type MergedWorklogBlock = typeof MergedWorklogBlock.Type;

export const WorklogFilter = Schema.Struct({
  since: Schema.optional(IsoDateTime),
  until: Schema.optional(IsoDateTime),
  environmentIds: Schema.optional(Schema.Array(EnvironmentId)),
  projectIds: Schema.optional(Schema.Array(ProjectId)),
  threadIds: Schema.optional(Schema.Array(ThreadId)),
  providers: Schema.optional(Schema.Array(ProviderDriverKind)),
  sources: Schema.optional(Schema.Array(WorklogSource)),
  threadRoles: Schema.optional(Schema.Array(WorklogThreadRole)),
  statuses: Schema.optional(Schema.Array(WorklogEntryStatus)),
  minDurationMs: Schema.optional(NonNegativeInt),
  searchQuery: Schema.optional(TrimmedNonEmptyString),
});
export type WorklogFilter = typeof WorklogFilter.Type;

export const IcalFeedId = TrimmedNonEmptyString.pipe(Schema.brand("IcalFeedId"));
export type IcalFeedId = typeof IcalFeedId.Type;

export const IcalFeedConfig = Schema.Struct({
  id: IcalFeedId,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  token: TrimmedNonEmptyString,
  timeZone: TrimmedNonEmptyString,
  gapToleranceMinutes: NonNegativeInt,
  filter: Schema.optional(WorklogFilter),
  includeStatsInDescription: Schema.Boolean,
  includeThreadUrl: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IcalFeedConfig = typeof IcalFeedConfig.Type;

export const WorklogDailyStat = Schema.Struct({
  day: WorklogDayKey,
  totalDurationMs: NonNegativeInt,
  unionDurationMs: NonNegativeInt,
  entriesCount: NonNegativeInt,
  turnsCount: NonNegativeInt,
  maxConcurrency: NonNegativeInt,
  estimatedCostUsd: NonNegativeNumber,
});
export type WorklogDailyStat = typeof WorklogDailyStat.Type;

export const WorklogProviderStat = Schema.Struct({
  provider: ProviderDriverKind,
  totalDurationMs: NonNegativeInt,
  unionDurationMs: NonNegativeInt,
  durationRatio: UnitRatio,
  entriesCount: NonNegativeInt,
  turnsCount: NonNegativeInt,
  stats: WorklogStatsSummary,
  costRatio: UnitRatio,
});
export type WorklogProviderStat = typeof WorklogProviderStat.Type;

export const WorklogProjectStat = Schema.Struct({
  projectId: Schema.NullOr(ProjectId),
  projectTitle: TrimmedNonEmptyString,
  totalDurationMs: NonNegativeInt,
  unionDurationMs: NonNegativeInt,
  durationRatio: UnitRatio,
  entriesCount: NonNegativeInt,
  turnsCount: NonNegativeInt,
  stats: WorklogStatsSummary,
});
export type WorklogProjectStat = typeof WorklogProjectStat.Type;

export const WorklogRangeStats = Schema.Struct({
  since: IsoDateTime,
  until: IsoDateTime,
  timeZone: TrimmedNonEmptyString,
  totalDurationMs: NonNegativeInt,
  totalUnionDurationMs: NonNegativeInt,
  totalEntriesCount: NonNegativeInt,
  totalTurnsCount: NonNegativeInt,
  maxConcurrency: NonNegativeInt,
  totals: WorklogStatsSummary,
  daily: ForwardCompatibleArray(WorklogDailyStat),
  byProvider: ForwardCompatibleArray(WorklogProviderStat),
  topProjects: ForwardCompatibleArray(WorklogProjectStat),
});
export type WorklogRangeStats = typeof WorklogRangeStats.Type;

export class WorklogError extends Schema.TaggedError<WorklogError>()("WorklogError", {
  reason: Schema.Literals(["invalidRange", "feedNotFound", "unauthorizedFeed", "queryFailed"]),
  message: Schema.String,
  feedId: Schema.optional(IcalFeedId),
  cause: Schema.optional(Schema.Defect()),
}) {}
