import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RepoMonitorActionKind,
  RepoMonitorCursor,
  RepoMonitorError,
  RepoMonitorEventId,
  RepoMonitorEventKind,
  RepoMonitorEventOutcome,
  RepoMonitorEventRecord,
  RepoMonitorFilter,
  RepoMonitorRule,
  RepoMonitorRuleId,
  RuntimeMode,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export interface RepoMonitorEventQueryFilter {
  readonly projectId?: ProjectId | undefined;
  readonly ruleId?: RepoMonitorRuleId | undefined;
  readonly limit?: number | undefined;
}

export interface RepoMonitorTriggerWindowStats {
  readonly lastTriggeredAt: string | null;
  readonly recentTriggeredAt: ReadonlyArray<string>;
  readonly countInWindow: number;
}

export class RepoMonitorStore extends Context.Service<
  RepoMonitorStore,
  {
    readonly listRules: (
      projectId?: ProjectId | undefined,
    ) => Effect.Effect<ReadonlyArray<RepoMonitorRule>, RepoMonitorError>;
    readonly getRule: (
      id: RepoMonitorRuleId,
    ) => Effect.Effect<RepoMonitorRule | null, RepoMonitorError>;
    readonly putRule: (rule: RepoMonitorRule) => Effect.Effect<RepoMonitorRule, RepoMonitorError>;
    readonly deleteRule: (id: RepoMonitorRuleId) => Effect.Effect<boolean, RepoMonitorError>;
    readonly getCursor: (
      projectId: ProjectId,
    ) => Effect.Effect<RepoMonitorCursor | null, RepoMonitorError>;
    readonly putCursor: (
      cursor: RepoMonitorCursor,
    ) => Effect.Effect<RepoMonitorCursor, RepoMonitorError>;
    readonly hasDedupeKey: (
      ruleId: RepoMonitorRuleId,
      dedupeKey: string,
    ) => Effect.Effect<boolean, RepoMonitorError>;
    readonly recordEvent: (
      event: RepoMonitorEventRecord,
    ) => Effect.Effect<
      { readonly inserted: boolean; readonly event: RepoMonitorEventRecord },
      RepoMonitorError
    >;
    readonly listEvents: (
      filter?: RepoMonitorEventQueryFilter | undefined,
    ) => Effect.Effect<ReadonlyArray<RepoMonitorEventRecord>, RepoMonitorError>;
    readonly getTriggerWindowStats: (input: {
      readonly ruleId: RepoMonitorRuleId;
      readonly sinceIso: string;
    }) => Effect.Effect<RepoMonitorTriggerWindowStats, RepoMonitorError>;
  }
>()("t3/repoMonitor/RepoMonitorStore") {}

const EventKindsJsonSchema = Schema.fromJsonString(
  Schema.Array(RepoMonitorEventKind).check(Schema.isMinLength(1)),
);
const FilterJsonSchema = Schema.fromJsonString(RepoMonitorFilter);
const BranchHeadsJsonSchema = Schema.fromJsonString(
  Schema.Record(TrimmedNonEmptyString, TrimmedNonEmptyString),
);
const PositiveIntArrayJsonSchema = Schema.fromJsonString(Schema.Array(PositiveInt));
const StringArrayJsonSchema = Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString));

const encodeEventKinds = Schema.encodeEffect(EventKindsJsonSchema);
const encodeFilter = Schema.encodeEffect(FilterJsonSchema);
const encodeBranchHeads = Schema.encodeEffect(BranchHeadsJsonSchema);
const encodePositiveIntArray = Schema.encodeEffect(PositiveIntArrayJsonSchema);
const encodeStringArray = Schema.encodeEffect(StringArrayJsonSchema);

const RuleRowSchema = Schema.Struct({
  id: RepoMonitorRuleId,
  projectId: ProjectId,
  environmentId: Schema.NullOr(EnvironmentId),
  name: TrimmedNonEmptyString,
  description: Schema.NullOr(Schema.String),
  enabled: Schema.BooleanFromBit,
  eventKinds: EventKindsJsonSchema,
  filter: FilterJsonSchema,
  actionKind: RepoMonitorActionKind,
  targetThreadId: Schema.NullOr(ThreadId),
  runtimeMode: Schema.NullOr(RuntimeMode),
  promptTemplate: TrimmedNonEmptyString,
  cooldownSec: NonNegativeInt,
  maxTriggersPerHour: PositiveInt,
  presetId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
type RuleRow = typeof RuleRowSchema.Type;

const CursorRowSchema = Schema.Struct({
  projectId: ProjectId,
  branchHeads: BranchHeadsJsonSchema,
  knownPullRequestNumbers: PositiveIntArrayJsonSchema,
  mergedPullRequestNumbers: PositiveIntArrayJsonSchema,
  knownPullRequestCommentIds: StringArrayJsonSchema,
  knownIssueKeys: StringArrayJsonSchema,
  knownIssueCommentIds: StringArrayJsonSchema,
  updatedAt: IsoDateTime,
});

const EventRowSchema = Schema.Struct({
  id: RepoMonitorEventId,
  ruleId: RepoMonitorRuleId,
  projectId: ProjectId,
  eventKind: RepoMonitorEventKind,
  dedupeKey: TrimmedNonEmptyString,
  summary: TrimmedNonEmptyString,
  authorLogin: Schema.NullOr(TrimmedNonEmptyString),
  isBot: Schema.BooleanFromBit,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  commitSha: Schema.NullOr(TrimmedNonEmptyString),
  pullRequestNumber: Schema.NullOr(PositiveInt),
  issueKey: Schema.NullOr(TrimmedNonEmptyString),
  commentId: Schema.NullOr(TrimmedNonEmptyString),
  url: Schema.NullOr(TrimmedNonEmptyString),
  outcome: RepoMonitorEventOutcome,
  dispatchedThreadId: Schema.NullOr(ThreadId),
  renderedPrompt: Schema.NullOr(Schema.String),
  occurredAt: IsoDateTime,
});
type EventRow = typeof EventRowSchema.Type;

function rowToRule(row: RuleRow): RepoMonitorRule {
  return {
    id: row.id,
    projectId: row.projectId,
    ...(row.environmentId === null ? {} : { environmentId: row.environmentId }),
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    enabled: row.enabled,
    eventKinds: row.eventKinds,
    filter: row.filter,
    actionKind: row.actionKind,
    targetThreadId: row.targetThreadId,
    ...(row.runtimeMode === null ? {} : { runtimeMode: row.runtimeMode }),
    promptTemplate: row.promptTemplate,
    cooldownSec: row.cooldownSec,
    maxTriggersPerHour: row.maxTriggersPerHour,
    ...(row.presetId === null ? {} : { presetId: row.presetId }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function rowToEvent(row: EventRow): RepoMonitorEventRecord {
  return {
    id: row.id,
    ruleId: row.ruleId,
    projectId: row.projectId,
    eventKind: row.eventKind,
    dedupeKey: row.dedupeKey,
    summary: row.summary,
    authorLogin: row.authorLogin,
    isBot: row.isBot,
    branch: row.branch,
    commitSha: row.commitSha,
    pullRequestNumber: row.pullRequestNumber,
    issueKey: row.issueKey,
    commentId: row.commentId,
    url: row.url,
    outcome: row.outcome,
    dispatchedThreadId: row.dispatchedThreadId,
    renderedPrompt: row.renderedPrompt,
    occurredAt: row.occurredAt,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const toStoreError =
    (message: string, ruleId?: RepoMonitorRuleId | undefined) => (cause: unknown) =>
      new RepoMonitorError({
        message,
        ...(ruleId === undefined ? {} : { ruleId }),
        cause,
      });

  const ruleColumns = sql`
    id,
    project_id AS "projectId",
    environment_id AS "environmentId",
    name,
    description,
    enabled,
    event_kinds_json AS "eventKinds",
    filter_json AS "filter",
    action_kind AS "actionKind",
    target_thread_id AS "targetThreadId",
    runtime_mode AS "runtimeMode",
    prompt_template AS "promptTemplate",
    cooldown_sec AS "cooldownSec",
    max_triggers_per_hour AS "maxTriggersPerHour",
    preset_id AS "presetId",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const cursorColumns = sql`
    project_id AS "projectId",
    branch_heads_json AS "branchHeads",
    known_pull_request_numbers_json AS "knownPullRequestNumbers",
    merged_pull_request_numbers_json AS "mergedPullRequestNumbers",
    known_pull_request_comment_ids_json AS "knownPullRequestCommentIds",
    known_issue_keys_json AS "knownIssueKeys",
    known_issue_comment_ids_json AS "knownIssueCommentIds",
    updated_at AS "updatedAt"
  `;

  const eventColumns = sql`
    id,
    rule_id AS "ruleId",
    project_id AS "projectId",
    event_kind AS "eventKind",
    dedupe_key AS "dedupeKey",
    summary,
    author_login AS "authorLogin",
    is_bot AS "isBot",
    branch,
    commit_sha AS "commitSha",
    pull_request_number AS "pullRequestNumber",
    issue_key AS "issueKey",
    comment_id AS "commentId",
    url,
    outcome,
    dispatched_thread_id AS "dispatchedThreadId",
    rendered_prompt AS "renderedPrompt",
    occurred_at AS "occurredAt"
  `;

  const findAllRules = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RuleRowSchema,
    execute: () => sql`SELECT ${ruleColumns} FROM repo_monitor_rules ORDER BY created_at ASC`,
  });

  const findRulesByProject = SqlSchema.findAll({
    Request: ProjectId,
    Result: RuleRowSchema,
    execute: (projectId) => sql`
      SELECT ${ruleColumns} FROM repo_monitor_rules
      WHERE project_id = ${projectId}
      ORDER BY created_at ASC
    `,
  });

  const findRuleById = SqlSchema.findOneOption({
    Request: RepoMonitorRuleId,
    Result: RuleRowSchema,
    execute: (id) => sql`SELECT ${ruleColumns} FROM repo_monitor_rules WHERE id = ${id} LIMIT 1`,
  });

  const findCursorByProject = SqlSchema.findOneOption({
    Request: ProjectId,
    Result: CursorRowSchema,
    execute: (projectId) => sql`
      SELECT ${cursorColumns} FROM repo_monitor_cursors
      WHERE project_id = ${projectId}
      LIMIT 1
    `,
  });

  const findEventByRuleAndDedupe = SqlSchema.findOneOption({
    Request: Schema.Struct({
      ruleId: RepoMonitorRuleId,
      dedupeKey: Schema.String,
    }),
    Result: EventRowSchema,
    execute: ({ ruleId, dedupeKey }) => sql`
      SELECT ${eventColumns} FROM repo_monitor_events
      WHERE rule_id = ${ruleId} AND dedupe_key = ${dedupeKey}
      LIMIT 1
    `,
  });

  const findAllEvents = SqlSchema.findAll({
    Request: Schema.Int,
    Result: EventRowSchema,
    execute: (limit) => sql`
      SELECT ${eventColumns} FROM repo_monitor_events
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `,
  });

  const findEventsByProject = SqlSchema.findAll({
    Request: Schema.Struct({
      projectId: ProjectId,
      limit: Schema.Int,
    }),
    Result: EventRowSchema,
    execute: ({ projectId, limit }) => sql`
      SELECT ${eventColumns} FROM repo_monitor_events
      WHERE project_id = ${projectId}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `,
  });

  const findEventsByRule = SqlSchema.findAll({
    Request: Schema.Struct({
      ruleId: RepoMonitorRuleId,
      limit: Schema.Int,
    }),
    Result: EventRowSchema,
    execute: ({ ruleId, limit }) => sql`
      SELECT ${eventColumns} FROM repo_monitor_events
      WHERE rule_id = ${ruleId}
      ORDER BY occurred_at DESC
      LIMIT ${limit}
    `,
  });

  const listRules: RepoMonitorStore["Service"]["listRules"] = Effect.fn(
    "RepoMonitorStore.listRules",
  )(function* (projectId) {
    const rows =
      projectId === undefined
        ? yield* findAllRules(undefined).pipe(
            Effect.mapError(toStoreError("Failed to list repo monitor rules")),
          )
        : yield* findRulesByProject(projectId).pipe(
            Effect.mapError(toStoreError("Failed to list repo monitor rules for project")),
          );
    return rows.map(rowToRule);
  });

  const getRule: RepoMonitorStore["Service"]["getRule"] = Effect.fn("RepoMonitorStore.getRule")(
    function* (id) {
      const row = yield* findRuleById(id).pipe(
        Effect.mapError(toStoreError("Failed to get repo monitor rule", id)),
      );
      return Option.isSome(row) ? rowToRule(row.value) : null;
    },
  );

  const putRule: RepoMonitorStore["Service"]["putRule"] = Effect.fn("RepoMonitorStore.putRule")(
    function* (rule) {
      const eventKindsJson = yield* encodeEventKinds(rule.eventKinds).pipe(
        Effect.mapError(toStoreError("Failed to encode rule eventKinds", rule.id)),
      );
      const filterJson = yield* encodeFilter(rule.filter).pipe(
        Effect.mapError(toStoreError("Failed to encode rule filter", rule.id)),
      );

      yield* sql`
        INSERT INTO repo_monitor_rules (
          id, project_id, environment_id, name, description, enabled,
          event_kinds_json, filter_json, action_kind, target_thread_id,
          runtime_mode, prompt_template, cooldown_sec, max_triggers_per_hour,
          preset_id, created_at, updated_at
        ) VALUES (
          ${rule.id},
          ${rule.projectId},
          ${rule.environmentId ?? null},
          ${rule.name},
          ${rule.description ?? null},
          ${rule.enabled ? 1 : 0},
          ${eventKindsJson},
          ${filterJson},
          ${rule.actionKind},
          ${rule.targetThreadId ?? null},
          ${rule.runtimeMode ?? null},
          ${rule.promptTemplate},
          ${rule.cooldownSec},
          ${rule.maxTriggersPerHour},
          ${rule.presetId ?? null},
          ${rule.createdAt},
          ${rule.updatedAt}
        )
        ON CONFLICT (id) DO UPDATE SET
          project_id = excluded.project_id,
          environment_id = excluded.environment_id,
          name = excluded.name,
          description = excluded.description,
          enabled = excluded.enabled,
          event_kinds_json = excluded.event_kinds_json,
          filter_json = excluded.filter_json,
          action_kind = excluded.action_kind,
          target_thread_id = excluded.target_thread_id,
          runtime_mode = excluded.runtime_mode,
          prompt_template = excluded.prompt_template,
          cooldown_sec = excluded.cooldown_sec,
          max_triggers_per_hour = excluded.max_triggers_per_hour,
          preset_id = excluded.preset_id,
          updated_at = excluded.updated_at
      `.pipe(Effect.mapError(toStoreError("Failed to persist repo monitor rule", rule.id)));

      return rule;
    },
  );

  const deleteRule: RepoMonitorStore["Service"]["deleteRule"] = Effect.fn(
    "RepoMonitorStore.deleteRule",
  )(function* (id) {
    const existing = yield* getRule(id);
    if (existing === null) return false;
    yield* sql`DELETE FROM repo_monitor_rules WHERE id = ${id}`.pipe(
      Effect.mapError(toStoreError("Failed to delete repo monitor rule", id)),
    );
    return true;
  });

  const getCursor: RepoMonitorStore["Service"]["getCursor"] = Effect.fn(
    "RepoMonitorStore.getCursor",
  )(function* (projectId) {
    const row = yield* findCursorByProject(projectId).pipe(
      Effect.mapError(toStoreError("Failed to read repo monitor cursor")),
    );
    return Option.getOrNull(row);
  });

  const putCursor: RepoMonitorStore["Service"]["putCursor"] = Effect.fn(
    "RepoMonitorStore.putCursor",
  )(function* (cursor) {
    const branchHeadsJson = yield* encodeBranchHeads(cursor.branchHeads).pipe(
      Effect.mapError(toStoreError("Failed to encode branchHeads")),
    );
    const knownPrsJson = yield* encodePositiveIntArray(cursor.knownPullRequestNumbers).pipe(
      Effect.mapError(toStoreError("Failed to encode knownPullRequestNumbers")),
    );
    const mergedPrsJson = yield* encodePositiveIntArray(cursor.mergedPullRequestNumbers).pipe(
      Effect.mapError(toStoreError("Failed to encode mergedPullRequestNumbers")),
    );
    const knownPrCommentsJson = yield* encodeStringArray(cursor.knownPullRequestCommentIds).pipe(
      Effect.mapError(toStoreError("Failed to encode knownPullRequestCommentIds")),
    );
    const knownIssuesJson = yield* encodeStringArray(cursor.knownIssueKeys).pipe(
      Effect.mapError(toStoreError("Failed to encode knownIssueKeys")),
    );
    const knownIssueCommentsJson = yield* encodeStringArray(cursor.knownIssueCommentIds).pipe(
      Effect.mapError(toStoreError("Failed to encode knownIssueCommentIds")),
    );

    yield* sql`
      INSERT INTO repo_monitor_cursors (
        project_id,
        branch_heads_json,
        known_pull_request_numbers_json,
        merged_pull_request_numbers_json,
        known_pull_request_comment_ids_json,
        known_issue_keys_json,
        known_issue_comment_ids_json,
        updated_at
      ) VALUES (
        ${cursor.projectId},
        ${branchHeadsJson},
        ${knownPrsJson},
        ${mergedPrsJson},
        ${knownPrCommentsJson},
        ${knownIssuesJson},
        ${knownIssueCommentsJson},
        ${cursor.updatedAt}
      )
      ON CONFLICT (project_id) DO UPDATE SET
        branch_heads_json = excluded.branch_heads_json,
        known_pull_request_numbers_json = excluded.known_pull_request_numbers_json,
        merged_pull_request_numbers_json = excluded.merged_pull_request_numbers_json,
        known_pull_request_comment_ids_json = excluded.known_pull_request_comment_ids_json,
        known_issue_keys_json = excluded.known_issue_keys_json,
        known_issue_comment_ids_json = excluded.known_issue_comment_ids_json,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(toStoreError("Failed to persist repo monitor cursor")));

    return cursor;
  });

  const hasDedupeKey: RepoMonitorStore["Service"]["hasDedupeKey"] = Effect.fn(
    "RepoMonitorStore.hasDedupeKey",
  )(function* (ruleId, dedupeKey) {
    const existing = yield* findEventByRuleAndDedupe({ ruleId, dedupeKey }).pipe(
      Effect.mapError(toStoreError("Failed to query repo monitor event dedupeKey", ruleId)),
    );
    return Option.isSome(existing);
  });

  const recordEvent: RepoMonitorStore["Service"]["recordEvent"] = Effect.fn(
    "RepoMonitorStore.recordEvent",
  )(function* (event) {
    const existing = yield* findEventByRuleAndDedupe({
      ruleId: event.ruleId,
      dedupeKey: event.dedupeKey,
    }).pipe(
      Effect.mapError(toStoreError("Failed to check existing repo monitor event", event.ruleId)),
    );

    if (Option.isSome(existing)) {
      return { inserted: false, event: rowToEvent(existing.value) };
    }

    yield* sql`
      INSERT INTO repo_monitor_events (
        id, rule_id, project_id, event_kind, dedupe_key, summary,
        author_login, is_bot, branch, commit_sha, pull_request_number,
        issue_key, comment_id, url, outcome, dispatched_thread_id,
        rendered_prompt, occurred_at
      ) VALUES (
        ${event.id},
        ${event.ruleId},
        ${event.projectId},
        ${event.eventKind},
        ${event.dedupeKey},
        ${event.summary},
        ${event.authorLogin},
        ${event.isBot ? 1 : 0},
        ${event.branch ?? null},
        ${event.commitSha ?? null},
        ${event.pullRequestNumber ?? null},
        ${event.issueKey ?? null},
        ${event.commentId ?? null},
        ${event.url ?? null},
        ${event.outcome},
        ${event.dispatchedThreadId ?? null},
        ${event.renderedPrompt ?? null},
        ${event.occurredAt}
      )
      ON CONFLICT (rule_id, dedupe_key) DO NOTHING
    `.pipe(Effect.mapError(toStoreError("Failed to record repo monitor event", event.ruleId)));

    return { inserted: true, event };
  });

  const listEvents: RepoMonitorStore["Service"]["listEvents"] = Effect.fn(
    "RepoMonitorStore.listEvents",
  )(function* (filter) {
    const limit = Math.max(1, Math.min(500, filter?.limit ?? 100));
    const rows =
      filter?.ruleId !== undefined
        ? yield* findEventsByRule({ ruleId: filter.ruleId, limit }).pipe(
            Effect.mapError(
              toStoreError("Failed to list repo monitor events by rule", filter.ruleId),
            ),
          )
        : filter?.projectId !== undefined
          ? yield* findEventsByProject({ projectId: filter.projectId, limit }).pipe(
              Effect.mapError(toStoreError("Failed to list repo monitor events by project")),
            )
          : yield* findAllEvents(limit).pipe(
              Effect.mapError(toStoreError("Failed to list repo monitor events")),
            );
    return rows.map(rowToEvent);
  });

  const getTriggerWindowStats: RepoMonitorStore["Service"]["getTriggerWindowStats"] = Effect.fn(
    "RepoMonitorStore.getTriggerWindowStats",
  )(function* ({ ruleId, sinceIso }) {
    const latestRows = yield* sql<{ readonly occurred_at: string }>`
      SELECT occurred_at FROM repo_monitor_events
      WHERE rule_id = ${ruleId} AND outcome = 'triggered'
      ORDER BY occurred_at DESC
      LIMIT 1
    `.pipe(Effect.mapError(toStoreError("Failed to read latest triggered event", ruleId)));

    const windowRows = yield* sql<{ readonly occurred_at: string }>`
      SELECT occurred_at FROM repo_monitor_events
      WHERE rule_id = ${ruleId} AND outcome = 'triggered' AND occurred_at > ${sinceIso}
      ORDER BY occurred_at DESC
    `.pipe(Effect.mapError(toStoreError("Failed to read trigger window stats", ruleId)));

    const recentTriggeredAt = windowRows.map((row) => row.occurred_at);
    return {
      lastTriggeredAt: latestRows[0]?.occurred_at ?? null,
      recentTriggeredAt,
      countInWindow: recentTriggeredAt.length,
    };
  });

  return RepoMonitorStore.of({
    listRules,
    getRule,
    putRule,
    deleteRule,
    getCursor,
    putCursor,
    hasDedupeKey,
    recordEvent,
    listEvents,
    getTriggerWindowStats,
  });
});

export const layer = Layer.effect(RepoMonitorStore, make);
