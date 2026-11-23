// @effect-diagnostics-next-line nodeBuiltinImport:off -- SHA-256 feed token hashing
import * as NodeCrypto from "node:crypto";

import {
  type AgentWorklogEntry,
  EnvironmentId,
  type IcalFeedConfig,
  IcalFeedId,
  NonNegativeInt,
  NonNegativeNumber,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  WorklogEntryId,
  WorklogEntryStatus,
  WorklogError,
  WorklogFilter,
  WorklogSource,
  type WorklogStatsSummary,
  WorklogThreadRole,
} from "@t3tools/contracts";
import { getAgentShortCode } from "@t3tools/shared/worklogLayout.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export interface StoredWorklogEntryInput {
  readonly id?: WorklogEntryId | string | undefined;
  readonly sourceKey: string;
  readonly source: WorklogSource;
  readonly environmentId: EnvironmentId;
  readonly provider: ProviderDriverKind;
  readonly providerInstanceId?: ProviderInstanceId | undefined;
  readonly agentKey?: string | undefined;
  readonly model?: string | undefined;
  readonly projectId: ProjectId | null;
  readonly projectTitle?: string | undefined;
  readonly threadId: ThreadId | null;
  readonly runId: RunId | null;
  readonly title: string;
  readonly threadRole: WorklogThreadRole;
  readonly summary?: string | undefined;
  readonly status: WorklogEntryStatus;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs?: number | undefined;
  readonly turnCount?: number | undefined;
  readonly stats: WorklogStatsSummary;
  readonly threadUrl?: string | undefined;
}

export interface CreateIcalFeedInput {
  readonly id?: IcalFeedId | string | undefined;
  readonly name: string;
  readonly rawToken?: string | undefined;
  readonly timeZone?: string | undefined;
  readonly gapToleranceMinutes?: number | undefined;
  readonly filter?: WorklogFilter | undefined;
  readonly includeStatsInDescription?: boolean | undefined;
  readonly includeThreadUrl?: boolean | undefined;
}

export interface StoredIcalFeed {
  readonly id: IcalFeedId;
  readonly name: string;
  readonly enabled: boolean;
  readonly timeZone: string;
  readonly gapToleranceMinutes: number;
  readonly filter: WorklogFilter;
  readonly includeStatsInDescription: boolean;
  readonly includeThreadUrl: boolean;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatedIcalFeedResult {
  readonly feed: StoredIcalFeed;
  readonly rawToken: string;
  readonly config: IcalFeedConfig;
}

export class WorklogStore extends Context.Service<
  WorklogStore,
  {
    readonly upsertEntry: (
      input: StoredWorklogEntryInput,
    ) => Effect.Effect<AgentWorklogEntry, WorklogError>;
    readonly upsertEntries: (
      inputs: ReadonlyArray<StoredWorklogEntryInput>,
    ) => Effect.Effect<ReadonlyArray<AgentWorklogEntry>, WorklogError>;
    readonly findBySourceKey: (
      sourceKey: string,
    ) => Effect.Effect<AgentWorklogEntry | null, WorklogError>;
    readonly queryEntries: (
      filter?: WorklogFilter,
    ) => Effect.Effect<ReadonlyArray<AgentWorklogEntry>, WorklogError>;
    readonly createFeed: (
      input: CreateIcalFeedInput,
    ) => Effect.Effect<CreatedIcalFeedResult, WorklogError>;
    readonly listFeeds: (options?: {
      readonly includeRevoked?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<StoredIcalFeed>, WorklogError>;
    readonly getFeedById: (
      feedId: IcalFeedId,
    ) => Effect.Effect<StoredIcalFeed | null, WorklogError>;
    readonly verifyFeedToken: (
      rawToken: string,
    ) => Effect.Effect<StoredIcalFeed | null, WorklogError>;
    readonly rotateFeedToken: (
      feedId: IcalFeedId,
      customRawToken?: string,
    ) => Effect.Effect<CreatedIcalFeedResult, WorklogError>;
    readonly revokeFeed: (feedId: IcalFeedId) => Effect.Effect<void, WorklogError>;
    readonly deleteFeed: (feedId: IcalFeedId) => Effect.Effect<void, WorklogError>;
  }
>()("t3/worklog/WorklogStore") {}

export function hashIcalFeedToken(rawToken: string): string {
  return NodeCrypto.createHash("sha256").update(rawToken.trim()).digest("hex");
}

function generateRawIcalFeedToken(): string {
  return NodeCrypto.randomBytes(24).toString("base64url");
}

const WorklogEntryRow = Schema.Struct({
  id: WorklogEntryId,
  source: WorklogSource,
  sourceKey: Schema.String,
  environmentId: EnvironmentId,
  provider: ProviderDriverKind,
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  agentKey: Schema.String,
  model: Schema.NullOr(TrimmedNonEmptyString),
  projectId: Schema.NullOr(ProjectId),
  projectTitle: Schema.NullOr(TrimmedNonEmptyString),
  threadId: Schema.NullOr(ThreadId),
  runId: Schema.NullOr(RunId),
  threadTitle: TrimmedNonEmptyString,
  threadRole: WorklogThreadRole,
  summary: Schema.NullOr(Schema.String),
  status: WorklogEntryStatus,
  startedAt: Schema.String,
  endedAt: Schema.String,
  durationMs: NonNegativeInt,
  turnCount: PositiveInt,
  changedFilesCount: NonNegativeInt,
  commandsCount: NonNegativeInt,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cachedTokens: NonNegativeInt,
  costUsd: NonNegativeNumber,
  threadUrl: Schema.NullOr(TrimmedNonEmptyString),
});
type WorklogEntryRow = typeof WorklogEntryRow.Type;

const IcalFeedRow = Schema.Struct({
  id: IcalFeedId,
  name: TrimmedNonEmptyString,
  tokenHash: Schema.String,
  timeZone: TrimmedNonEmptyString,
  gapToleranceMinutes: NonNegativeInt,
  filterJson: Schema.String,
  includeStatsInDescription: Schema.BooleanFromBit,
  includeThreadUrl: Schema.BooleanFromBit,
  revokedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type IcalFeedRow = typeof IcalFeedRow.Type;

const WorklogFilterFromJson = Schema.fromJsonString(WorklogFilter);
const encodeFilterJson = Schema.encodeEffect(WorklogFilterFromJson);
const decodeFilterJson = Schema.decodeUnknownOption(WorklogFilterFromJson);

const RangeQueryRequest = Schema.Struct({
  since: Schema.NullOr(Schema.String),
  until: Schema.NullOr(Schema.String),
});

function rowToAgentWorklogEntry(row: WorklogEntryRow): AgentWorklogEntry {
  return {
    id: row.id,
    source: row.source,
    environmentId: row.environmentId,
    projectId: row.projectId,
    ...(row.projectTitle !== null ? { projectTitle: row.projectTitle } : {}),
    threadId: row.threadId,
    runId: row.runId,
    threadRole: row.threadRole,
    provider: row.provider,
    ...(row.providerInstanceId !== null ? { providerInstanceId: row.providerInstanceId } : {}),
    ...(row.model !== null ? { model: row.model } : {}),
    title: row.threadTitle,
    ...(row.summary !== null ? { summary: row.summary } : {}),
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    durationMs: row.durationMs,
    turnCount: row.turnCount,
    stats: {
      changedFilesCount: row.changedFilesCount,
      commandsCount: row.commandsCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cachedTokens: row.cachedTokens,
      estimatedCostUsd: row.costUsd,
    },
    ...(row.threadUrl !== null ? { threadUrl: row.threadUrl } : {}),
  };
}

function rowToStoredIcalFeed(row: IcalFeedRow): StoredIcalFeed {
  const decodedFilter = decodeFilterJson(row.filterJson);
  const filter: WorklogFilter = Option.isSome(decodedFilter) ? decodedFilter.value : {};
  return {
    id: row.id,
    name: row.name,
    enabled: row.revokedAt === null,
    timeZone: row.timeZone,
    gapToleranceMinutes: row.gapToleranceMinutes,
    filter,
    includeStatsInDescription: row.includeStatsInDescription,
    includeThreadUrl: row.includeThreadUrl,
    revokedAt: row.revokedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIcalFeedConfig(feed: StoredIcalFeed, rawToken: string): IcalFeedConfig {
  return {
    id: feed.id,
    name: feed.name,
    enabled: feed.enabled,
    token: rawToken,
    timeZone: feed.timeZone,
    gapToleranceMinutes: feed.gapToleranceMinutes,
    filter: feed.filter,
    includeStatsInDescription: feed.includeStatsInDescription,
    includeThreadUrl: feed.includeThreadUrl,
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt,
  };
}

function computeDurationMs(startedAt: string, endedAt: string, explicit?: number): number {
  if (explicit !== undefined && Number.isFinite(explicit) && explicit >= 0) {
    return Math.floor(explicit);
  }
  const startDt = DateTime.make(startedAt);
  const endDt = DateTime.make(endedAt);
  if (Option.isSome(startDt) && Option.isSome(endDt)) {
    return Math.max(0, DateTime.toEpochMillis(endDt.value) - DateTime.toEpochMillis(startDt.value));
  }
  return 0;
}

export function matchesWorklogFilter(entry: AgentWorklogEntry, filter?: WorklogFilter): boolean {
  if (!filter) return true;

  if (filter.since !== undefined && entry.endedAt < filter.since) {
    return false;
  }
  if (filter.until !== undefined && entry.startedAt > filter.until) {
    return false;
  }
  if (
    filter.environmentIds !== undefined &&
    filter.environmentIds.length > 0 &&
    !filter.environmentIds.includes(entry.environmentId)
  ) {
    return false;
  }
  if (
    filter.projectIds !== undefined &&
    filter.projectIds.length > 0 &&
    (entry.projectId === null || !filter.projectIds.includes(entry.projectId))
  ) {
    return false;
  }
  if (
    filter.threadIds !== undefined &&
    filter.threadIds.length > 0 &&
    (entry.threadId === null || !filter.threadIds.includes(entry.threadId))
  ) {
    return false;
  }
  if (
    filter.providers !== undefined &&
    filter.providers.length > 0 &&
    !filter.providers.includes(entry.provider)
  ) {
    return false;
  }
  if (
    filter.sources !== undefined &&
    filter.sources.length > 0 &&
    !filter.sources.includes(entry.source)
  ) {
    return false;
  }
  if (
    filter.threadRoles !== undefined &&
    filter.threadRoles.length > 0 &&
    !filter.threadRoles.includes(entry.threadRole)
  ) {
    return false;
  }
  if (
    filter.statuses !== undefined &&
    filter.statuses.length > 0 &&
    !filter.statuses.includes(entry.status)
  ) {
    return false;
  }
  if (filter.minDurationMs !== undefined && entry.durationMs < filter.minDurationMs) {
    return false;
  }
  if (filter.searchQuery !== undefined && filter.searchQuery.trim().length > 0) {
    const needle = filter.searchQuery.trim().toLowerCase();
    const haystacks = [
      entry.title,
      entry.summary ?? "",
      entry.projectTitle ?? "",
      entry.provider,
      entry.model ?? "",
    ];
    if (!haystacks.some((h) => h.toLowerCase().includes(needle))) {
      return false;
    }
  }
  return true;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const queryFailed = (detail: string) => (cause: unknown) =>
    new WorklogError({
      reason: "queryFailed",
      message: detail,
      cause,
    });

  const entryColumns = sql`
    id,
    source,
    source_key AS "sourceKey",
    environment_id AS "environmentId",
    provider,
    provider_instance_id AS "providerInstanceId",
    agent_key AS "agentKey",
    model,
    project_id AS "projectId",
    project_title AS "projectTitle",
    thread_id AS "threadId",
    run_id AS "runId",
    thread_title AS "threadTitle",
    thread_role AS "threadRole",
    summary,
    status,
    started_at AS "startedAt",
    ended_at AS "endedAt",
    duration_ms AS "durationMs",
    turn_count AS "turnCount",
    changed_files_count AS "changedFilesCount",
    commands_count AS "commandsCount",
    input_tokens AS "inputTokens",
    output_tokens AS "outputTokens",
    cached_tokens AS "cachedTokens",
    cost_usd AS "costUsd",
    thread_url AS "threadUrl"
  `;

  const feedColumns = sql`
    id,
    name,
    token_hash AS "tokenHash",
    time_zone AS "timeZone",
    gap_tolerance_minutes AS "gapToleranceMinutes",
    filter_json AS "filterJson",
    include_stats_in_description AS "includeStatsInDescription",
    include_thread_url AS "includeThreadUrl",
    revoked_at AS "revokedAt",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const findEntryBySourceKeySql = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: WorklogEntryRow,
    execute: (sourceKey) => sql`
      SELECT ${entryColumns}
      FROM agent_worklog_entries
      WHERE source_key = ${sourceKey}
      LIMIT 1
    `,
  });

  const findEntriesInRangeSql = SqlSchema.findAll({
    Request: RangeQueryRequest,
    Result: WorklogEntryRow,
    execute: ({ since, until }) => sql`
      SELECT ${entryColumns}
      FROM agent_worklog_entries
      WHERE (${since} IS NULL OR ended_at >= ${since})
        AND (${until} IS NULL OR started_at <= ${until})
      ORDER BY started_at ASC, ended_at ASC, id ASC
    `,
  });

  const findFeedByIdSql = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IcalFeedRow,
    execute: (id) => sql`
      SELECT ${feedColumns}
      FROM ical_feeds
      WHERE id = ${id}
      LIMIT 1
    `,
  });

  const findFeedByTokenHashSql = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: IcalFeedRow,
    execute: (tokenHash) => sql`
      SELECT ${feedColumns}
      FROM ical_feeds
      WHERE token_hash = ${tokenHash}
        AND revoked_at IS NULL
      LIMIT 1
    `,
  });

  const listAllFeedsSql = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IcalFeedRow,
    execute: () => sql`
      SELECT ${feedColumns}
      FROM ical_feeds
      ORDER BY created_at DESC, id ASC
    `,
  });

  const upsertEntry: WorklogStore["Service"]["upsertEntry"] = Effect.fn("WorklogStore.upsertEntry")(
    function* (input) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const defaultId =
        input.id !== undefined && input.id.trim().length > 0
          ? WorklogEntryId.make(input.id.trim())
          : WorklogEntryId.make(
              `wl-${NodeCrypto.createHash("sha256").update(input.sourceKey).digest("hex").slice(0, 20)}`,
            );
      const agentKey =
        input.agentKey !== undefined && input.agentKey.trim().length > 0
          ? input.agentKey.trim()
          : getAgentShortCode(input.provider);
      const durationMs = computeDurationMs(input.startedAt, input.endedAt, input.durationMs);
      const turnCount = Math.max(1, Math.floor(input.turnCount ?? 1));
      const title = input.title.trim().length > 0 ? input.title.trim() : "Untitled Agent Work";

      yield* sql`
      INSERT INTO agent_worklog_entries (
        id,
        source,
        source_key,
        environment_id,
        provider,
        provider_instance_id,
        agent_key,
        model,
        project_id,
        project_title,
        thread_id,
        run_id,
        thread_title,
        thread_role,
        summary,
        status,
        started_at,
        ended_at,
        duration_ms,
        turn_count,
        changed_files_count,
        commands_count,
        input_tokens,
        output_tokens,
        cached_tokens,
        cost_usd,
        thread_url,
        created_at,
        updated_at
      ) VALUES (
        ${defaultId},
        ${input.source},
        ${input.sourceKey},
        ${input.environmentId},
        ${input.provider},
        ${input.providerInstanceId ?? null},
        ${agentKey},
        ${input.model ?? null},
        ${input.projectId},
        ${input.projectTitle ?? null},
        ${input.threadId},
        ${input.runId},
        ${title},
        ${input.threadRole},
        ${input.summary ?? null},
        ${input.status},
        ${input.startedAt},
        ${input.endedAt},
        ${durationMs},
        ${turnCount},
        ${input.stats.changedFilesCount},
        ${input.stats.commandsCount},
        ${input.stats.inputTokens},
        ${input.stats.outputTokens},
        ${input.stats.cachedTokens},
        ${input.stats.estimatedCostUsd},
        ${input.threadUrl ?? null},
        ${nowIso},
        ${nowIso}
      )
      ON CONFLICT (source_key) DO UPDATE SET
        source = excluded.source,
        environment_id = excluded.environment_id,
        provider = excluded.provider,
        provider_instance_id = excluded.provider_instance_id,
        agent_key = excluded.agent_key,
        model = excluded.model,
        project_id = excluded.project_id,
        project_title = COALESCE(excluded.project_title, agent_worklog_entries.project_title),
        thread_id = excluded.thread_id,
        run_id = excluded.run_id,
        thread_title = excluded.thread_title,
        thread_role = excluded.thread_role,
        summary = COALESCE(excluded.summary, agent_worklog_entries.summary),
        status = excluded.status,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        duration_ms = excluded.duration_ms,
        turn_count = excluded.turn_count,
        changed_files_count = excluded.changed_files_count,
        commands_count = excluded.commands_count,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        cached_tokens = excluded.cached_tokens,
        cost_usd = excluded.cost_usd,
        thread_url = COALESCE(excluded.thread_url, agent_worklog_entries.thread_url),
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(queryFailed("Could not upsert worklog entry.")));

      const stored = yield* findEntryBySourceKeySql(input.sourceKey).pipe(
        Effect.mapError(queryFailed("Could not read upserted worklog entry.")),
      );
      if (Option.isNone(stored)) {
        return yield* new WorklogError({
          reason: "queryFailed",
          message: `Worklog entry for source_key '${input.sourceKey}' was not found after upsert.`,
        });
      }
      return rowToAgentWorklogEntry(stored.value);
    },
  );

  const upsertEntries: WorklogStore["Service"]["upsertEntries"] = Effect.fn(
    "WorklogStore.upsertEntries",
  )(function* (inputs) {
    const results: Array<AgentWorklogEntry> = [];
    for (const input of inputs) {
      results.push(yield* upsertEntry(input));
    }
    return results;
  });

  const findBySourceKey: WorklogStore["Service"]["findBySourceKey"] = Effect.fn(
    "WorklogStore.findBySourceKey",
  )(function* (sourceKey) {
    const row = yield* findEntryBySourceKeySql(sourceKey).pipe(
      Effect.mapError(queryFailed("Could not find worklog entry by source_key.")),
    );
    return Option.isSome(row) ? rowToAgentWorklogEntry(row.value) : null;
  });

  const queryEntries: WorklogStore["Service"]["queryEntries"] = Effect.fn(
    "WorklogStore.queryEntries",
  )(function* (filter) {
    if (filter?.since !== undefined && filter?.until !== undefined && filter.since > filter.until) {
      return yield* new WorklogError({
        reason: "invalidRange",
        message: `Invalid worklog range: since (${filter.since}) is after until (${filter.until}).`,
      });
    }

    const rows = yield* findEntriesInRangeSql({
      since: filter?.since ?? null,
      until: filter?.until ?? null,
    }).pipe(Effect.mapError(queryFailed("Could not query worklog entries.")));

    return rows.map(rowToAgentWorklogEntry).filter((entry) => matchesWorklogFilter(entry, filter));
  });

  const createFeed: WorklogStore["Service"]["createFeed"] = Effect.fn("WorklogStore.createFeed")(
    function* (input) {
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const rawToken =
        input.rawToken !== undefined && input.rawToken.trim().length > 0
          ? input.rawToken.trim()
          : generateRawIcalFeedToken();
      const tokenHash = hashIcalFeedToken(rawToken);
      const feedId =
        input.id !== undefined && input.id.trim().length > 0
          ? IcalFeedId.make(input.id.trim())
          : IcalFeedId.make(`feed-${NodeCrypto.randomBytes(8).toString("hex")}`);
      const name = input.name.trim().length > 0 ? input.name.trim() : "Agent Worklog Feed";
      const timeZone =
        input.timeZone !== undefined && input.timeZone.trim().length > 0
          ? input.timeZone.trim()
          : "UTC";
      const gapToleranceMinutes = Math.max(0, Math.floor(input.gapToleranceMinutes ?? 5));
      const filterJson = yield* encodeFilterJson(input.filter ?? {}).pipe(
        Effect.mapError(queryFailed("Could not encode iCal feed filter.")),
      );
      const includeStatsBit = (input.includeStatsInDescription ?? true) ? 1 : 0;
      const includeThreadUrlBit = (input.includeThreadUrl ?? true) ? 1 : 0;

      yield* sql`
        INSERT INTO ical_feeds (
          id,
          name,
          token_hash,
          time_zone,
          gap_tolerance_minutes,
          filter_json,
          include_stats_in_description,
          include_thread_url,
          revoked_at,
          created_at,
          updated_at
        ) VALUES (
          ${feedId},
          ${name},
          ${tokenHash},
          ${timeZone},
          ${gapToleranceMinutes},
          ${filterJson},
          ${includeStatsBit},
          ${includeThreadUrlBit},
          NULL,
          ${nowIso},
          ${nowIso}
        )
      `.pipe(Effect.mapError(queryFailed("Could not create iCal feed.")));

      const row = yield* findFeedByIdSql(feedId).pipe(
        Effect.mapError(queryFailed("Could not read created iCal feed.")),
      );
      if (Option.isNone(row)) {
        return yield* new WorklogError({
          reason: "feedNotFound",
          message: `Created iCal feed '${feedId}' was not found.`,
          feedId,
        });
      }

      const feed = rowToStoredIcalFeed(row.value);
      return {
        feed,
        rawToken,
        config: toIcalFeedConfig(feed, rawToken),
      };
    },
  );

  const listFeeds: WorklogStore["Service"]["listFeeds"] = Effect.fn("WorklogStore.listFeeds")(
    function* (options) {
      const includeRevoked = options?.includeRevoked ?? false;
      const rows = yield* listAllFeedsSql(undefined).pipe(
        Effect.mapError(queryFailed("Could not list iCal feeds.")),
      );
      return rows
        .map(rowToStoredIcalFeed)
        .filter((feed) => includeRevoked || feed.revokedAt === null);
    },
  );

  const getFeedById: WorklogStore["Service"]["getFeedById"] = Effect.fn("WorklogStore.getFeedById")(
    function* (feedId) {
      const row = yield* findFeedByIdSql(feedId).pipe(
        Effect.mapError(queryFailed("Could not read iCal feed by id.")),
      );
      return Option.isSome(row) ? rowToStoredIcalFeed(row.value) : null;
    },
  );

  const verifyFeedToken: WorklogStore["Service"]["verifyFeedToken"] = Effect.fn(
    "WorklogStore.verifyFeedToken",
  )(function* (rawToken) {
    const trimmed = rawToken.trim();
    if (trimmed.length === 0) return null;
    const tokenHash = hashIcalFeedToken(trimmed);
    const row = yield* findFeedByTokenHashSql(tokenHash).pipe(
      Effect.mapError(queryFailed("Could not verify iCal feed token.")),
    );
    return Option.isSome(row) ? rowToStoredIcalFeed(row.value) : null;
  });

  const rotateFeedToken: WorklogStore["Service"]["rotateFeedToken"] = Effect.fn(
    "WorklogStore.rotateFeedToken",
  )(function* (feedId, customRawToken) {
    const existing = yield* findFeedByIdSql(feedId).pipe(
      Effect.mapError(queryFailed("Could not find iCal feed to rotate.")),
    );
    if (Option.isNone(existing)) {
      return yield* new WorklogError({
        reason: "feedNotFound",
        message: `iCal feed '${feedId}' does not exist.`,
        feedId,
      });
    }

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const rawToken =
      customRawToken !== undefined && customRawToken.trim().length > 0
        ? customRawToken.trim()
        : generateRawIcalFeedToken();
    const tokenHash = hashIcalFeedToken(rawToken);

    yield* sql`
      UPDATE ical_feeds
      SET
        token_hash = ${tokenHash},
        revoked_at = NULL,
        updated_at = ${nowIso}
      WHERE id = ${feedId}
    `.pipe(Effect.mapError(queryFailed("Could not rotate iCal feed token.")));

    const updated = yield* findFeedByIdSql(feedId).pipe(
      Effect.mapError(queryFailed("Could not read rotated iCal feed.")),
    );
    if (Option.isNone(updated)) {
      return yield* new WorklogError({
        reason: "feedNotFound",
        message: `iCal feed '${feedId}' was not found after rotation.`,
        feedId,
      });
    }
    const feed = rowToStoredIcalFeed(updated.value);
    return {
      feed,
      rawToken,
      config: toIcalFeedConfig(feed, rawToken),
    };
  });

  const revokeFeed: WorklogStore["Service"]["revokeFeed"] = Effect.fn("WorklogStore.revokeFeed")(
    function* (feedId) {
      const existing = yield* findFeedByIdSql(feedId).pipe(
        Effect.mapError(queryFailed("Could not find iCal feed to revoke.")),
      );
      if (Option.isNone(existing)) {
        return yield* new WorklogError({
          reason: "feedNotFound",
          message: `iCal feed '${feedId}' does not exist.`,
          feedId,
        });
      }
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        UPDATE ical_feeds
        SET revoked_at = ${nowIso}, updated_at = ${nowIso}
        WHERE id = ${feedId}
      `.pipe(Effect.mapError(queryFailed("Could not revoke iCal feed.")));
    },
  );

  const deleteFeed: WorklogStore["Service"]["deleteFeed"] = Effect.fn("WorklogStore.deleteFeed")(
    function* (feedId) {
      const existing = yield* findFeedByIdSql(feedId).pipe(
        Effect.mapError(queryFailed("Could not find iCal feed to delete.")),
      );
      if (Option.isNone(existing)) {
        return yield* new WorklogError({
          reason: "feedNotFound",
          message: `iCal feed '${feedId}' does not exist.`,
          feedId,
        });
      }
      yield* sql`
        DELETE FROM ical_feeds
        WHERE id = ${feedId}
      `.pipe(Effect.mapError(queryFailed("Could not delete iCal feed.")));
    },
  );

  return WorklogStore.of({
    upsertEntry,
    upsertEntries,
    findBySourceKey,
    queryEntries,
    createFeed,
    listFeeds,
    getFeedById,
    verifyFeedToken,
    rotateFeedToken,
    revokeFeed,
    deleteFeed,
  });
});

export const layer = Layer.effect(WorklogStore, make);
