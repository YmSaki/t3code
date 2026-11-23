// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 ETag computation for iCal feed responses
import * as NodeCrypto from "node:crypto";

import {
  type AgentWorklogEntry,
  EnvironmentId,
  type IcalFeedId,
  type MergedWorklogBlock,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  WorklogDayKey,
  WorklogEntryId,
  type WorklogEntryStatus,
  WorklogError,
  type WorklogFilter,
  type WorklogRangeStats,
  type WorklogStatsSummary,
  type WorklogThreadRole,
} from "@t3tools/contracts";
import { generateWorklogIcalFeed } from "@t3tools/shared/icalGenerator.core";
import {
  deduplicateWorklogEntries,
  groupWorklogEntries,
  summarizeWorklogByDay,
  type DailyWorklogDurationSummary,
  type MergedWorklogCoreBlock,
  type WorklogCoreEntry,
  type WorklogDaySlice,
} from "@t3tools/shared/worklogGrouping.core";
import { layoutWorklogDaySlices, type WorklogLayoutItem } from "@t3tools/shared/worklogLayout.core";
import { calculateWorklogRangeStats } from "@t3tools/shared/worklogStats.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import {
  matchesWorklogFilter,
  WorklogStore,
  type CreatedIcalFeedResult,
  type CreateIcalFeedInput,
  type StoredIcalFeed,
  type StoredWorklogEntryInput,
} from "./WorklogStore.ts";

export type PeerWorklogFetcher = (
  filter?: WorklogFilter,
) => Effect.Effect<ReadonlyArray<AgentWorklogEntry>, WorklogError>;

export interface BackfillOrchestrationV2Options {
  readonly environmentId?: EnvironmentId | string | undefined;
}

export interface BackfillOrchestrationV2Result {
  readonly backfilledCount: number;
  readonly entries: ReadonlyArray<AgentWorklogEntry>;
}

export interface ExternalCliSessionWorklogInput {
  readonly sessionId: string;
  readonly provider: ProviderDriverKind | string;
  readonly providerInstanceId?: ProviderInstanceId | string | undefined;
  readonly environmentId?: EnvironmentId | string | undefined;
  readonly projectId?: ProjectId | string | null | undefined;
  readonly projectTitle?: string | undefined;
  readonly threadId?: ThreadId | string | null | undefined;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly model?: string | undefined;
  readonly status?: WorklogEntryStatus | undefined;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs?: number | undefined;
  readonly turnCount?: number | undefined;
  readonly stats?: Partial<WorklogStatsSummary> | undefined;
  readonly threadUrl?: string | undefined;
}

export interface IngestExternalSessionsOptions {
  readonly defaultEnvironmentId?: EnvironmentId | string | undefined;
  readonly overlapToleranceMs?: number | undefined;
}

export interface IngestExternalSessionsResult {
  readonly ingestedCount: number;
  readonly skippedOverlappingCount: number;
  readonly entries: ReadonlyArray<AgentWorklogEntry>;
}

export interface QueryWorklogInput {
  readonly filter?: WorklogFilter | undefined;
  readonly mode?: "raw" | "merged" | undefined;
  readonly gapToleranceMinutes?: number | null | undefined;
  readonly timeZone?: string | undefined;
  readonly includePeers?: boolean | undefined;
  readonly peerFetcher?: PeerWorklogFetcher | undefined;
  readonly peerEntries?: ReadonlyArray<AgentWorklogEntry> | undefined;
  readonly overlapToleranceMs?: number | undefined;
}

export interface QueryWorklogResult {
  readonly entries: ReadonlyArray<AgentWorklogEntry>;
  readonly blocks: ReadonlyArray<MergedWorklogBlock>;
  readonly dailySummaries: ReadonlyArray<DailyWorklogDurationSummary>;
  readonly dayLayouts: Readonly<Record<string, ReadonlyArray<WorklogLayoutItem<WorklogDaySlice>>>>;
}

export interface GetWorklogStatsInput {
  readonly filter?: WorklogFilter | undefined;
  readonly timeZone?: string | undefined;
  readonly topProjectsLimit?: number | undefined;
  readonly includePeers?: boolean | undefined;
  readonly peerFetcher?: PeerWorklogFetcher | undefined;
  readonly peerEntries?: ReadonlyArray<AgentWorklogEntry> | undefined;
  readonly overlapToleranceMs?: number | undefined;
}

export interface RenderedIcalFeed {
  readonly feed: StoredIcalFeed;
  readonly icsText: string;
  readonly etag: string;
}

export class WorklogService extends Context.Service<
  WorklogService,
  {
    readonly backfillFromOrchestrationV2: (
      options?: BackfillOrchestrationV2Options,
    ) => Effect.Effect<BackfillOrchestrationV2Result, WorklogError>;
    /** Records the given runs as backfill would, for live turn completions. */
    readonly recordRuns: (
      runIds: ReadonlyArray<RunId>,
      options?: BackfillOrchestrationV2Options,
    ) => Effect.Effect<BackfillOrchestrationV2Result, WorklogError>;
    readonly ingestExternalSessions: (
      sessions: ReadonlyArray<ExternalCliSessionWorklogInput>,
      options?: IngestExternalSessionsOptions,
    ) => Effect.Effect<IngestExternalSessionsResult, WorklogError>;
    readonly queryWorklog: (
      input?: QueryWorklogInput,
    ) => Effect.Effect<QueryWorklogResult, WorklogError>;
    readonly getStats: (
      input?: GetWorklogStatsInput,
    ) => Effect.Effect<WorklogRangeStats, WorklogError>;
    readonly createIcalFeed: (
      input: CreateIcalFeedInput,
    ) => Effect.Effect<CreatedIcalFeedResult, WorklogError>;
    readonly listIcalFeeds: (options?: {
      readonly includeRevoked?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<StoredIcalFeed>, WorklogError>;
    readonly rotateIcalFeedToken: (
      feedId: IcalFeedId,
      customRawToken?: string,
    ) => Effect.Effect<CreatedIcalFeedResult, WorklogError>;
    readonly deleteIcalFeed: (feedId: IcalFeedId) => Effect.Effect<void, WorklogError>;
    readonly renderIcalFeedByToken: (
      rawToken: string,
    ) => Effect.Effect<RenderedIcalFeed, WorklogError>;
  }
>()("t3/worklog/WorklogService") {}

export interface WorklogServiceConfig {
  readonly defaultEnvironmentId?: EnvironmentId | string | undefined;
  readonly peerFetcher?: PeerWorklogFetcher | undefined;
}

function normalizeRunStatus(rawStatus: string, completedAt: string | null): WorklogEntryStatus {
  const normalized = rawStatus.trim().toLowerCase();
  switch (normalized) {
    case "running":
    case "pending":
    case "queued":
    case "in_progress":
    case "active":
      return "running";
    case "completed":
    case "succeeded":
    case "done":
      return "completed";
    case "interrupted":
    case "paused":
    case "suspended":
      return "interrupted";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "aborted":
      return "cancelled";
    default:
      return completedAt !== null ? "completed" : "running";
  }
}

function normalizeThreadRole(rawRole: unknown): WorklogThreadRole {
  if (rawRole === "pm" || rawRole === "worker" || rawRole === "standard") {
    return rawRole;
  }
  return "standard";
}

function safeParseJsonObject(rawJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function asNonNegativeInt(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
}

function asNonNegativeNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function toCoreEntry(entry: AgentWorklogEntry): WorklogCoreEntry {
  return {
    id: entry.id,
    source: entry.source,
    environmentId: entry.environmentId,
    projectId: entry.projectId,
    ...(entry.projectTitle !== undefined ? { projectTitle: entry.projectTitle } : {}),
    threadId: entry.threadId,
    runId: entry.runId,
    threadRole: entry.threadRole,
    provider: entry.provider,
    ...(entry.providerInstanceId !== undefined
      ? { providerInstanceId: entry.providerInstanceId }
      : {}),
    ...(entry.model !== undefined ? { model: entry.model } : {}),
    title: entry.title,
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    status: entry.status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: entry.durationMs,
    turnCount: entry.turnCount,
    stats: entry.stats,
    ...(entry.threadUrl !== undefined ? { threadUrl: entry.threadUrl } : {}),
  };
}

function coreEntryToContract(entry: WorklogCoreEntry): AgentWorklogEntry {
  const startOpt = DateTime.make(entry.startedAt);
  const endOpt = DateTime.make(entry.endedAt);
  const resolvedDuration =
    entry.durationMs ??
    (Option.isSome(startOpt) && Option.isSome(endOpt)
      ? Math.max(0, DateTime.toEpochMillis(endOpt.value) - DateTime.toEpochMillis(startOpt.value))
      : 0);

  return {
    id: WorklogEntryId.make(entry.id),
    source: entry.source,
    environmentId: EnvironmentId.make(entry.environmentId),
    projectId: entry.projectId !== null ? ProjectId.make(entry.projectId) : null,
    ...(entry.projectTitle !== undefined
      ? { projectTitle: TrimmedNonEmptyString.make(entry.projectTitle) }
      : {}),
    threadId: entry.threadId !== null ? ThreadId.make(entry.threadId) : null,
    runId: entry.runId !== undefined && entry.runId !== null ? RunId.make(entry.runId) : null,
    threadRole: entry.threadRole,
    provider: ProviderDriverKind.make(entry.provider),
    ...(entry.providerInstanceId !== undefined
      ? { providerInstanceId: ProviderInstanceId.make(entry.providerInstanceId) }
      : {}),
    ...(entry.model !== undefined ? { model: TrimmedNonEmptyString.make(entry.model) } : {}),
    title: TrimmedNonEmptyString.make(entry.title),
    ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
    status: entry.status,
    startedAt: entry.startedAt,
    endedAt: entry.endedAt,
    durationMs: NonNegativeInt.make(Math.max(0, Math.floor(resolvedDuration))),
    turnCount: PositiveInt.make(Math.max(1, Math.floor(entry.turnCount))),
    stats: {
      changedFilesCount: NonNegativeInt.make(entry.stats.changedFilesCount),
      commandsCount: NonNegativeInt.make(entry.stats.commandsCount),
      inputTokens: NonNegativeInt.make(entry.stats.inputTokens),
      outputTokens: NonNegativeInt.make(entry.stats.outputTokens),
      cachedTokens: NonNegativeInt.make(entry.stats.cachedTokens),
      estimatedCostUsd: entry.stats.estimatedCostUsd,
    },
    ...(entry.threadUrl !== undefined
      ? { threadUrl: TrimmedNonEmptyString.make(entry.threadUrl) }
      : {}),
  };
}

function coreBlockToContract(block: MergedWorklogCoreBlock): MergedWorklogBlock {
  return {
    id: TrimmedNonEmptyString.make(block.id),
    entryIds: block.entryIds.map((id) => WorklogEntryId.make(id)),
    source: block.source,
    environmentId: EnvironmentId.make(block.environmentId),
    projectId: block.projectId !== null ? ProjectId.make(block.projectId) : null,
    ...(block.projectTitle !== undefined
      ? { projectTitle: TrimmedNonEmptyString.make(block.projectTitle) }
      : {}),
    threadId: block.threadId !== null ? ThreadId.make(block.threadId) : null,
    threadRole: block.threadRole,
    provider: ProviderDriverKind.make(block.provider),
    ...(block.providerInstanceId !== undefined
      ? { providerInstanceId: ProviderInstanceId.make(block.providerInstanceId) }
      : {}),
    ...(block.model !== undefined ? { model: TrimmedNonEmptyString.make(block.model) } : {}),
    title: TrimmedNonEmptyString.make(block.title),
    ...(block.summary !== undefined ? { summary: block.summary } : {}),
    status: block.status,
    startedAt: block.startedAt,
    endedAt: block.endedAt,
    durationMs: NonNegativeInt.make(Math.max(0, Math.floor(block.durationMs))),
    activeDurationMs: NonNegativeInt.make(Math.max(0, Math.floor(block.activeDurationMs))),
    turnCount: PositiveInt.make(Math.max(1, Math.floor(block.turnCount))),
    gapToleranceMinutes: NonNegativeInt.make(Math.max(0, Math.floor(block.gapToleranceMinutes))),
    stats: {
      changedFilesCount: NonNegativeInt.make(block.stats.changedFilesCount),
      commandsCount: NonNegativeInt.make(block.stats.commandsCount),
      inputTokens: NonNegativeInt.make(block.stats.inputTokens),
      outputTokens: NonNegativeInt.make(block.stats.outputTokens),
      cachedTokens: NonNegativeInt.make(block.stats.cachedTokens),
      estimatedCostUsd: block.stats.estimatedCostUsd,
    },
    ...(block.threadUrl !== undefined
      ? { threadUrl: TrimmedNonEmptyString.make(block.threadUrl) }
      : {}),
  };
}

/** @public */
export const make = Effect.fn("WorklogService.make")(function* (config?: WorklogServiceConfig) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* WorklogStore;
  const defaultEnvId = EnvironmentId.make(
    config?.defaultEnvironmentId !== undefined && config.defaultEnvironmentId.trim().length > 0
      ? config.defaultEnvironmentId.trim()
      : "env-local",
  );

  const queryFailed = (detail: string) => (cause: unknown) =>
    new WorklogError({
      reason: "queryFailed",
      message: detail,
      cause,
    });

  const resolveEnvId = (environmentId: EnvironmentId | string | undefined) =>
    environmentId !== undefined && environmentId.trim().length > 0
      ? EnvironmentId.make(environmentId.trim())
      : defaultEnvId;

  // Both backfill and live recording map runs here, so their entries share ids and upsert in place.
  const syncRuns = Effect.fn("WorklogService.syncRuns")(function* (
    envId: EnvironmentId,
    runIds: ReadonlyArray<RunId> | null,
  ) {
    if (runIds !== null && runIds.length === 0) return { backfilledCount: 0, entries: [] };
    const runFilter = (column: "r.run_id" | "run_id") =>
      runIds === null
        ? sql`1 = 1`
        : column === "run_id"
          ? sql`run_id IN ${sql.in(runIds)}`
          : sql`r.run_id IN ${sql.in(runIds)}`;

    const existingTables = yield* sql<{ readonly name: string }>`
          SELECT name FROM sqlite_master
          WHERE type = 'table'
            AND name IN (
              'orchestration_v2_projection_runs',
              'orchestration_v2_projection_threads',
              'orchestration_v2_projection_turn_items'
            )
        `.pipe(Effect.mapError(queryFailed("Could not inspect orchestration_v2 tables.")));

    const tableSet = new Set(existingTables.map((row) => row.name));
    if (
      !tableSet.has("orchestration_v2_projection_runs") ||
      !tableSet.has("orchestration_v2_projection_threads")
    ) {
      return { backfilledCount: 0, entries: [] };
    }

    const nowIso = DateTime.formatIso(yield* DateTime.now);

    interface ProjectionBackfillRow {
      readonly run_id: string;
      readonly thread_id: string;
      readonly ordinal: number;
      readonly provider: string;
      readonly provider_thread_id: string | null;
      readonly status: string;
      readonly requested_at: string;
      readonly completed_at: string | null;
      readonly run_payload_json: string;
      readonly project_id: string;
      readonly thread_title: string;
      readonly default_provider: string;
      readonly thread_updated_at: string;
      readonly thread_payload_json: string;
    }

    const rows = yield* sql<ProjectionBackfillRow>`
          SELECT
            r.run_id,
            r.thread_id,
            r.ordinal,
            r.provider,
            r.provider_thread_id,
            r.status,
            r.requested_at,
            r.completed_at,
            r.payload_json AS run_payload_json,
            t.project_id,
            t.title AS thread_title,
            t.default_provider,
            t.updated_at AS thread_updated_at,
            t.payload_json AS thread_payload_json
          FROM orchestration_v2_projection_runs r
          INNER JOIN orchestration_v2_projection_threads t
            ON t.thread_id = r.thread_id
          WHERE t.deleted_at IS NULL
            AND ${runFilter("r.run_id")}
          ORDER BY r.requested_at ASC, r.ordinal ASC, r.run_id ASC
        `.pipe(Effect.mapError(queryFailed("Could not query orchestration_v2 runs for backfill.")));

    const turnItemCountsByRunId = new Map<
      string,
      { readonly commandsCount: number; readonly changedFilesCount: number }
    >();

    if (tableSet.has("orchestration_v2_projection_turn_items")) {
      const itemRows = yield* sql<{
        readonly run_id: string;
        readonly type: string;
        readonly item_count: number;
      }>`
            SELECT
              run_id,
              type,
              COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
              AND ${runFilter("run_id")}
            GROUP BY run_id, type
          `.pipe(Effect.mapError(queryFailed("Could not aggregate turn items for backfill.")));

      for (const itemRow of itemRows) {
        const current = turnItemCountsByRunId.get(itemRow.run_id) ?? {
          commandsCount: 0,
          changedFilesCount: 0,
        };
        const lowerType = itemRow.type.toLowerCase();
        const isCommand = lowerType.includes("command") || lowerType.includes("exec");
        const isFileChange =
          lowerType.includes("file") || lowerType.includes("edit") || lowerType.includes("patch");
        turnItemCountsByRunId.set(itemRow.run_id, {
          commandsCount: current.commandsCount + (isCommand ? Number(itemRow.item_count) : 0),
          changedFilesCount:
            current.changedFilesCount + (isFileChange ? Number(itemRow.item_count) : 0),
        });
      }
    }

    const upsertInputs: Array<StoredWorklogEntryInput> = rows.map((row) => {
      const runPayload = safeParseJsonObject(row.run_payload_json);
      const threadPayload = safeParseJsonObject(row.thread_payload_json);
      const payloadStats =
        typeof runPayload.stats === "object" && runPayload.stats !== null
          ? (runPayload.stats as Record<string, unknown>)
          : {};
      const itemCounts = turnItemCountsByRunId.get(row.run_id);

      const providerStr =
        asNonEmptyString(runPayload.driver) ??
        asNonEmptyString(row.provider) ??
        asNonEmptyString(row.default_provider) ??
        "codex";
      const providerInstanceStr =
        asNonEmptyString(runPayload.providerInstanceId) ??
        asNonEmptyString(threadPayload.providerInstanceId);
      const modelStr = asNonEmptyString(runPayload.model) ?? asNonEmptyString(threadPayload.model);
      const projectTitleStr = asNonEmptyString(threadPayload.projectTitle);
      const summaryStr =
        asNonEmptyString(runPayload.summary) ?? asNonEmptyString(threadPayload.summary);
      const threadUrlStr = asNonEmptyString(threadPayload.threadUrl);
      const role = normalizeThreadRole(
        runPayload.threadRole ?? threadPayload.threadRole ?? threadPayload.role,
      );
      const startedAt = row.requested_at;
      const endedAt =
        row.completed_at ??
        asNonEmptyString(runPayload.updatedAt) ??
        (row.thread_updated_at >= startedAt ? row.thread_updated_at : nowIso);
      const status = normalizeRunStatus(row.status, row.completed_at);
      const turnCount = Math.max(
        1,
        asNonNegativeInt(runPayload.turnCount ?? runPayload.turnsCount, 1),
      );

      return {
        id: `wl-run-${row.run_id}`,
        // Keyed by run alone like `id`: live recording and a backfill naming another env must meet.
        sourceKey: `t3_run:${row.run_id}`,
        source: "t3_run",
        environmentId: envId,
        provider: ProviderDriverKind.make(providerStr),
        ...(providerInstanceStr !== undefined
          ? { providerInstanceId: ProviderInstanceId.make(providerInstanceStr) }
          : {}),
        ...(modelStr !== undefined ? { model: modelStr } : {}),
        projectId: ProjectId.make(row.project_id),
        ...(projectTitleStr !== undefined ? { projectTitle: projectTitleStr } : {}),
        threadId: ThreadId.make(row.thread_id),
        runId: RunId.make(row.run_id),
        title: row.thread_title,
        threadRole: role,
        ...(summaryStr !== undefined ? { summary: summaryStr } : {}),
        status,
        startedAt,
        endedAt,
        turnCount,
        stats: {
          changedFilesCount: NonNegativeInt.make(
            asNonNegativeInt(
              payloadStats.changedFilesCount ?? runPayload.changedFilesCount,
              itemCounts?.changedFilesCount ?? 0,
            ),
          ),
          commandsCount: NonNegativeInt.make(
            asNonNegativeInt(
              payloadStats.commandsCount ?? runPayload.commandsCount,
              itemCounts?.commandsCount ?? 0,
            ),
          ),
          inputTokens: NonNegativeInt.make(
            asNonNegativeInt(payloadStats.inputTokens ?? runPayload.inputTokens, 0),
          ),
          outputTokens: NonNegativeInt.make(
            asNonNegativeInt(payloadStats.outputTokens ?? runPayload.outputTokens, 0),
          ),
          cachedTokens: NonNegativeInt.make(
            asNonNegativeInt(
              payloadStats.cachedTokens ??
                payloadStats.cachedInputTokens ??
                runPayload.cachedTokens,
              0,
            ),
          ),
          estimatedCostUsd: asNonNegativeNumber(
            payloadStats.estimatedCostUsd ??
              payloadStats.costUsd ??
              runPayload.estimatedCostUsd ??
              runPayload.costUsd,
            0,
          ),
        },
        ...(threadUrlStr !== undefined ? { threadUrl: threadUrlStr } : {}),
      };
    });

    const entries = yield* store.upsertEntries(upsertInputs);
    return {
      backfilledCount: entries.length,
      entries,
    };
  });

  const backfillFromOrchestrationV2: WorklogService["Service"]["backfillFromOrchestrationV2"] =
    Effect.fn("WorklogService.backfillFromOrchestrationV2")(function* (options) {
      return yield* syncRuns(resolveEnvId(options?.environmentId), null);
    });

  const recordRuns: WorklogService["Service"]["recordRuns"] = Effect.fn(
    "WorklogService.recordRuns",
  )(function* (runIds, options) {
    return yield* syncRuns(resolveEnvId(options?.environmentId), runIds);
  });

  const ingestExternalSessions: WorklogService["Service"]["ingestExternalSessions"] = Effect.fn(
    "WorklogService.ingestExternalSessions",
  )(function* (sessions, options) {
    if (sessions.length === 0) {
      return { ingestedCount: 0, skippedOverlappingCount: 0, entries: [] };
    }

    const fallbackEnvId =
      options?.defaultEnvironmentId !== undefined && options.defaultEnvironmentId.trim().length > 0
        ? EnvironmentId.make(options.defaultEnvironmentId.trim())
        : defaultEnvId;

    const existingT3Entries = yield* store.queryEntries({ sources: ["t3_run"] });
    const candidateInputsByEntryId = new Map<string, StoredWorklogEntryInput>();
    const candidateCoreEntries: Array<WorklogCoreEntry> = [];

    for (const session of sessions) {
      const envId =
        session.environmentId !== undefined && session.environmentId.trim().length > 0
          ? EnvironmentId.make(session.environmentId.trim())
          : fallbackEnvId;
      const provider = ProviderDriverKind.make(session.provider.trim());
      const sourceKey = `imported_cli:${envId}:${provider}:${session.sessionId.trim()}`;
      const entryId = `wl-cli-${NodeCrypto.createHash("sha256").update(sourceKey).digest("hex").slice(0, 16)}`;
      const stats: WorklogStatsSummary = {
        changedFilesCount: NonNegativeInt.make(
          asNonNegativeInt(session.stats?.changedFilesCount, 0),
        ),
        commandsCount: NonNegativeInt.make(asNonNegativeInt(session.stats?.commandsCount, 0)),
        inputTokens: NonNegativeInt.make(asNonNegativeInt(session.stats?.inputTokens, 0)),
        outputTokens: NonNegativeInt.make(asNonNegativeInt(session.stats?.outputTokens, 0)),
        cachedTokens: NonNegativeInt.make(asNonNegativeInt(session.stats?.cachedTokens, 0)),
        estimatedCostUsd: asNonNegativeNumber(session.stats?.estimatedCostUsd, 0),
      };

      const storeInput: StoredWorklogEntryInput = {
        id: entryId,
        sourceKey,
        source: "imported_cli",
        environmentId: envId,
        provider,
        ...(session.providerInstanceId !== undefined
          ? { providerInstanceId: ProviderInstanceId.make(session.providerInstanceId.trim()) }
          : {}),
        ...(session.model !== undefined && session.model.trim().length > 0
          ? { model: session.model.trim() }
          : {}),
        projectId:
          session.projectId !== undefined && session.projectId !== null
            ? ProjectId.make(session.projectId)
            : null,
        ...(session.projectTitle !== undefined && session.projectTitle.trim().length > 0
          ? { projectTitle: session.projectTitle.trim() }
          : {}),
        threadId:
          session.threadId !== undefined && session.threadId !== null
            ? ThreadId.make(session.threadId)
            : null,
        runId: null,
        title: session.title.trim().length > 0 ? session.title.trim() : "External CLI Session",
        threadRole: "standard",
        ...(session.summary !== undefined ? { summary: session.summary } : {}),
        status: session.status ?? "completed",
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        ...(session.durationMs !== undefined ? { durationMs: session.durationMs } : {}),
        turnCount: Math.max(1, Math.floor(session.turnCount ?? 1)),
        stats,
        ...(session.threadUrl !== undefined ? { threadUrl: session.threadUrl } : {}),
      };

      candidateInputsByEntryId.set(entryId, storeInput);
      candidateCoreEntries.push({
        id: entryId,
        source: "imported_cli",
        environmentId: envId,
        projectId: storeInput.projectId,
        ...(storeInput.projectTitle !== undefined ? { projectTitle: storeInput.projectTitle } : {}),
        threadId: storeInput.threadId,
        runId: null,
        threadRole: "standard",
        provider,
        title: storeInput.title,
        status: storeInput.status,
        startedAt: storeInput.startedAt,
        endedAt: storeInput.endedAt,
        turnCount: storeInput.turnCount ?? 1,
        stats,
      });
    }

    const deduped = deduplicateWorklogEntries(
      [...existingT3Entries.map(toCoreEntry), ...candidateCoreEntries],
      { overlapToleranceMs: options?.overlapToleranceMs },
    );

    const keptImportedIds = new Set(
      deduped.entries.filter((e) => e.source === "imported_cli").map((e) => e.id),
    );

    const inputsToUpsert: Array<StoredWorklogEntryInput> = [];
    let skippedOverlappingCount = 0;

    for (const [entryId, storeInput] of candidateInputsByEntryId.entries()) {
      if (keptImportedIds.has(entryId)) {
        inputsToUpsert.push(storeInput);
      } else {
        skippedOverlappingCount += 1;
      }
    }

    const entries = yield* store.upsertEntries(inputsToUpsert);
    return {
      ingestedCount: entries.length,
      skippedOverlappingCount,
      entries,
    };
  });

  const collectCombinedEntries = Effect.fn("WorklogService.collectCombinedEntries")(
    function* (params: {
      readonly filter?: WorklogFilter | undefined;
      readonly includePeers?: boolean | undefined;
      readonly peerFetcher?: PeerWorklogFetcher | undefined;
      readonly peerEntries?: ReadonlyArray<AgentWorklogEntry> | undefined;
      readonly overlapToleranceMs?: number | undefined;
    }) {
      const localEntries = yield* store.queryEntries(params.filter);
      const includePeers = params.includePeers ?? true;
      const activeFetcher = params.peerFetcher ?? config?.peerFetcher;

      let fetchedPeerEntries: ReadonlyArray<AgentWorklogEntry> = [];
      if (includePeers && activeFetcher !== undefined) {
        fetchedPeerEntries = yield* activeFetcher(params.filter);
      }

      const extraPeerEntries = includePeers ? (params.peerEntries ?? []) : [];
      const allRaw = [...localEntries, ...fetchedPeerEntries, ...extraPeerEntries].filter((entry) =>
        matchesWorklogFilter(entry, params.filter),
      );

      const byCompositeId = new Map<string, AgentWorklogEntry>();
      for (const entry of allRaw) {
        const key = `${entry.environmentId}:${entry.source}:${entry.runId ?? entry.id}`;
        const existing = byCompositeId.get(key);
        if (!existing || entry.endedAt >= existing.endedAt) {
          byCompositeId.set(key, entry);
        }
      }

      const dedupedCore = deduplicateWorklogEntries([...byCompositeId.values()].map(toCoreEntry), {
        overlapToleranceMs: params.overlapToleranceMs,
      });

      return dedupedCore.entries.map(coreEntryToContract);
    },
  );

  const queryWorklog: WorklogService["Service"]["queryWorklog"] = Effect.fn(
    "WorklogService.queryWorklog",
  )(function* (input) {
    const timeZone =
      input?.timeZone !== undefined && input.timeZone.trim().length > 0
        ? input.timeZone.trim()
        : "UTC";
    const entries = yield* collectCombinedEntries({
      filter: input?.filter,
      includePeers: input?.includePeers,
      peerFetcher: input?.peerFetcher,
      peerEntries: input?.peerEntries,
      overlapToleranceMs: input?.overlapToleranceMs,
    });

    const coreEntries = entries.map(toCoreEntry);
    const coreBlocks = groupWorklogEntries(coreEntries, {
      mode: input?.mode,
      gapToleranceMinutes: input?.gapToleranceMinutes,
      deduplicateImported: false,
    });

    const blocks = coreBlocks.map(coreBlockToContract);
    const dailySummaries = summarizeWorklogByDay(coreBlocks, timeZone);
    const dayLayouts: Record<string, ReadonlyArray<WorklogLayoutItem<WorklogDaySlice>>> = {};

    for (const summary of dailySummaries) {
      dayLayouts[summary.dayKey] = layoutWorklogDaySlices(summary.slices);
    }

    return {
      entries,
      blocks,
      dailySummaries,
      dayLayouts,
    };
  });

  const getStats: WorklogService["Service"]["getStats"] = Effect.fn("WorklogService.getStats")(
    function* (input) {
      const timeZone =
        input?.timeZone !== undefined && input.timeZone.trim().length > 0
          ? input.timeZone.trim()
          : "UTC";
      const entries = yield* collectCombinedEntries({
        filter: input?.filter,
        includePeers: input?.includePeers,
        peerFetcher: input?.peerFetcher,
        peerEntries: input?.peerEntries,
        overlapToleranceMs: input?.overlapToleranceMs,
      });

      const rawStats = calculateWorklogRangeStats(entries.map(toCoreEntry), {
        since: input?.filter?.since,
        until: input?.filter?.until,
        timeZone,
        topProjectsLimit: input?.topProjectsLimit,
        deduplicateImported: false,
      });

      return {
        since: rawStats.since,
        until: rawStats.until,
        timeZone: TrimmedNonEmptyString.make(rawStats.timeZone),
        totalDurationMs: NonNegativeInt.make(rawStats.totalDurationMs),
        totalUnionDurationMs: NonNegativeInt.make(rawStats.totalUnionDurationMs),
        totalEntriesCount: NonNegativeInt.make(rawStats.totalEntriesCount),
        totalTurnsCount: NonNegativeInt.make(rawStats.totalTurnsCount),
        maxConcurrency: NonNegativeInt.make(rawStats.maxConcurrency),
        totals: {
          changedFilesCount: NonNegativeInt.make(rawStats.totals.changedFilesCount),
          commandsCount: NonNegativeInt.make(rawStats.totals.commandsCount),
          inputTokens: NonNegativeInt.make(rawStats.totals.inputTokens),
          outputTokens: NonNegativeInt.make(rawStats.totals.outputTokens),
          cachedTokens: NonNegativeInt.make(rawStats.totals.cachedTokens),
          estimatedCostUsd: rawStats.totals.estimatedCostUsd,
        },
        daily: rawStats.daily.map((d) => ({
          day: WorklogDayKey.make(d.day),
          totalDurationMs: NonNegativeInt.make(d.totalDurationMs),
          unionDurationMs: NonNegativeInt.make(d.unionDurationMs),
          entriesCount: NonNegativeInt.make(d.entriesCount),
          turnsCount: NonNegativeInt.make(d.turnsCount),
          maxConcurrency: NonNegativeInt.make(d.maxConcurrency),
          estimatedCostUsd: d.estimatedCostUsd,
        })),
        byProvider: rawStats.byProvider.map((p) => ({
          provider: ProviderDriverKind.make(p.provider),
          totalDurationMs: NonNegativeInt.make(p.totalDurationMs),
          unionDurationMs: NonNegativeInt.make(p.unionDurationMs),
          durationRatio: p.durationRatio,
          entriesCount: NonNegativeInt.make(p.entriesCount),
          turnsCount: NonNegativeInt.make(p.turnsCount),
          stats: {
            changedFilesCount: NonNegativeInt.make(p.stats.changedFilesCount),
            commandsCount: NonNegativeInt.make(p.stats.commandsCount),
            inputTokens: NonNegativeInt.make(p.stats.inputTokens),
            outputTokens: NonNegativeInt.make(p.stats.outputTokens),
            cachedTokens: NonNegativeInt.make(p.stats.cachedTokens),
            estimatedCostUsd: p.stats.estimatedCostUsd,
          },
          costRatio: p.costRatio,
        })),
        topProjects: rawStats.topProjects.map((proj) => ({
          projectId: proj.projectId !== null ? ProjectId.make(proj.projectId) : null,
          projectTitle: TrimmedNonEmptyString.make(proj.projectTitle),
          totalDurationMs: NonNegativeInt.make(proj.totalDurationMs),
          unionDurationMs: NonNegativeInt.make(proj.unionDurationMs),
          durationRatio: proj.durationRatio,
          entriesCount: NonNegativeInt.make(proj.entriesCount),
          turnsCount: NonNegativeInt.make(proj.turnsCount),
          stats: {
            changedFilesCount: NonNegativeInt.make(proj.stats.changedFilesCount),
            commandsCount: NonNegativeInt.make(proj.stats.commandsCount),
            inputTokens: NonNegativeInt.make(proj.stats.inputTokens),
            outputTokens: NonNegativeInt.make(proj.stats.outputTokens),
            cachedTokens: NonNegativeInt.make(proj.stats.cachedTokens),
            estimatedCostUsd: proj.stats.estimatedCostUsd,
          },
        })),
      };
    },
  );

  const renderIcalFeedByToken: WorklogService["Service"]["renderIcalFeedByToken"] = Effect.fn(
    "WorklogService.renderIcalFeedByToken",
  )(function* (rawToken) {
    const normalizedToken = rawToken.trim().replace(/\.ics$/i, "");
    const feed = yield* store.verifyFeedToken(normalizedToken);
    if (feed === null || !feed.enabled) {
      return yield* new WorklogError({
        reason: "unauthorizedFeed",
        message: "Invalid, revoked, or deleted iCal feed token.",
      });
    }

    const entries = yield* collectCombinedEntries({
      filter: feed.filter,
    });

    const coreBlocks = groupWorklogEntries(entries.map(toCoreEntry), {
      mode: feed.gapToleranceMinutes === 0 ? "raw" : "merged",
      gapToleranceMinutes: feed.gapToleranceMinutes,
      deduplicateImported: false,
    });

    let latestTimestampIso = feed.updatedAt;
    for (const block of coreBlocks) {
      if (block.endedAt > latestTimestampIso) {
        latestTimestampIso = block.endedAt;
      }
    }

    const icsText = generateWorklogIcalFeed(
      coreBlocks.map((block) => ({
        id: block.id,
        provider: block.provider,
        title: block.title,
        startedAt: block.startedAt,
        endedAt: block.endedAt,
        durationMs: block.durationMs,
        turnCount: block.turnCount,
        status: block.status,
        source: block.source,
        threadRole: block.threadRole,
        ...(block.projectTitle !== undefined ? { projectTitle: block.projectTitle } : {}),
        ...(block.summary !== undefined ? { summary: block.summary } : {}),
        stats: block.stats,
        ...(block.threadUrl !== undefined ? { threadUrl: block.threadUrl } : {}),
      })),
      {
        calendarName: feed.name,
        timeZone: feed.timeZone,
        generatedAt: latestTimestampIso,
        includeStatsInDescription: feed.includeStatsInDescription,
        includeThreadUrl: feed.includeThreadUrl,
      },
    );

    const digest = NodeCrypto.createHash("sha256").update(icsText).digest("hex").slice(0, 32);
    const etag = `"${digest}"`;

    return {
      feed,
      icsText,
      etag,
    };
  });

  return WorklogService.of({
    backfillFromOrchestrationV2,
    recordRuns,
    ingestExternalSessions,
    queryWorklog,
    getStats,
    createIcalFeed: store.createFeed,
    listIcalFeeds: store.listFeeds,
    rotateIcalFeedToken: store.rotateFeedToken,
    deleteIcalFeed: store.deleteFeed,
    renderIcalFeedByToken,
  });
});

export const layer = Layer.effect(WorklogService, make());
