import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PmWorkerPolicy,
  PmWorkerStatus,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  ThreadRole,
  TrimmedNonEmptyString,
  WorkerContextBrief,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

export const DEFAULT_PM_WORKER_POLICY: PmWorkerPolicy = {
  maxConcurrentWorkers: 4,
  requireWorktreeIsolation: true,
  allowNestedDelegation: false,
  allowedTargets: [],
  maxDelegatedTurns: 32,
  directEditSuppressedProviders: [],
};

export class PmStoreError extends Schema.TaggedError<PmStoreError>()("PmStoreError", {
  operation: Schema.Literals(["read", "write", "delete"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `PmStore ${this.operation} failed: ${this.detail}`;
  }
}

export const PmThreadConfigRecord = Schema.Struct({
  threadId: ThreadId,
  metaProjectId: Schema.NullOr(TrimmedNonEmptyString),
  role: ThreadRole,
  delegationDepth: NonNegativeInt,
  policy: PmWorkerPolicy,
  killSwitchActive: Schema.Boolean,
  delegatedTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PmThreadConfigRecord = typeof PmThreadConfigRecord.Type;

export const PmWorkerDispatchRecord = Schema.Struct({
  dispatchCommandId: Schema.NullOr(CommandId),
  workerThreadId: ThreadId,
  pmThreadId: ThreadId,
  clientKey: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  targetRepoRole: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  useWorktree: Schema.Boolean,
  status: PmWorkerStatus,
  turnCount: NonNegativeInt,
  brief: WorkerContextBrief,
  summary: Schema.NullOr(Schema.String),
  pendingQuestions: Schema.Array(TrimmedNonEmptyString),
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});
export type PmWorkerDispatchRecord = typeof PmWorkerDispatchRecord.Type;

export interface PmUpsertThreadConfigInput {
  readonly threadId: ThreadId;
  readonly metaProjectId?: string | null | undefined;
  readonly role?: ThreadRole | undefined;
  readonly delegationDepth?: number | undefined;
  readonly policy?: PmWorkerPolicy | undefined;
  readonly killSwitchActive?: boolean | undefined;
  readonly delegatedTurnCount?: number | undefined;
}

export interface PmPutWorkerDispatchInput {
  readonly dispatchCommandId?: CommandId | undefined;
  readonly workerThreadId: ThreadId;
  readonly pmThreadId: ThreadId;
  readonly clientKey: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly targetRepoRole?: string | null | undefined;
  readonly providerInstanceId?: ProviderInstanceId | null | undefined;
  readonly useWorktree: boolean;
  readonly status?: PmWorkerStatus | undefined;
  readonly turnCount?: number | undefined;
  readonly brief: WorkerContextBrief;
  readonly summary?: string | null | undefined;
  readonly pendingQuestions?: ReadonlyArray<string> | undefined;
  readonly startedAt?: string | null | undefined;
}

export interface PmUpdateWorkerProgressInput {
  readonly workerThreadId: ThreadId;
  readonly status?: PmWorkerStatus | undefined;
  readonly turnCount?: number | undefined;
  readonly summary?: string | null | undefined;
  readonly pendingQuestions?: ReadonlyArray<string> | undefined;
  readonly startedAt?: string | null | undefined;
}

export class PmStore extends Context.Service<
  PmStore,
  {
    readonly getConfig: (
      threadId: ThreadId,
    ) => Effect.Effect<PmThreadConfigRecord | null, PmStoreError>;
    readonly upsertConfig: (
      input: PmUpsertThreadConfigInput,
    ) => Effect.Effect<PmThreadConfigRecord, PmStoreError>;
    readonly setThreadKillSwitch: (
      threadId: ThreadId,
      active: boolean,
    ) => Effect.Effect<PmThreadConfigRecord, PmStoreError>;
    readonly getGlobalKillSwitch: Effect.Effect<boolean, PmStoreError>;
    readonly setGlobalKillSwitch: (active: boolean) => Effect.Effect<boolean, PmStoreError>;
    readonly incrementDelegatedTurns: (
      threadId: ThreadId,
      delta?: number,
    ) => Effect.Effect<PmThreadConfigRecord, PmStoreError>;
    readonly getWorkerDispatch: (
      workerThreadId: ThreadId,
    ) => Effect.Effect<PmWorkerDispatchRecord | null, PmStoreError>;
    readonly listWorkersByPmThread: (
      pmThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<PmWorkerDispatchRecord>, PmStoreError>;
    readonly putWorkerDispatch: (
      input: PmPutWorkerDispatchInput,
    ) => Effect.Effect<PmWorkerDispatchRecord, PmStoreError>;
    readonly recordWorkerLaunch: (
      input: PmPutWorkerDispatchInput,
      config: Pick<PmUpsertThreadConfigInput, "metaProjectId" | "policy" | "delegationDepth">,
    ) => Effect.Effect<PmWorkerDispatchRecord, PmStoreError>;
    readonly updateWorkerProgress: (
      input: PmUpdateWorkerProgressInput,
    ) => Effect.Effect<PmWorkerDispatchRecord | null, PmStoreError>;
    readonly cancelActiveWorkers: (
      pmThreadId: ThreadId,
      summary?: string,
    ) => Effect.Effect<ReadonlyArray<PmWorkerDispatchRecord>, PmStoreError>;
  }
>()("t3/pm/PmStore") {}

const PendingQuestionsJson = Schema.fromJsonString(Schema.Array(TrimmedNonEmptyString));
const PolicyJson = Schema.fromJsonString(PmWorkerPolicy);
const BriefJson = Schema.fromJsonString(WorkerContextBrief);

const PmThreadConfigRow = Schema.Struct({
  threadId: ThreadId,
  metaProjectId: Schema.NullOr(TrimmedNonEmptyString),
  role: ThreadRole,
  delegationDepth: NonNegativeInt,
  policy: PolicyJson,
  killSwitchActive: Schema.BooleanFromBit,
  delegatedTurnCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

const PmWorkerDispatchRow = Schema.Struct({
  dispatchCommandId: Schema.NullOr(CommandId),
  workerThreadId: ThreadId,
  pmThreadId: ThreadId,
  clientKey: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  targetRepoRole: Schema.NullOr(TrimmedNonEmptyString),
  providerInstanceId: Schema.NullOr(ProviderInstanceId),
  useWorktree: Schema.BooleanFromBit,
  status: PmWorkerStatus,
  turnCount: NonNegativeInt,
  brief: BriefJson,
  summary: Schema.NullOr(Schema.String),
  pendingQuestions: PendingQuestionsJson,
  startedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
});

const encodePolicyJson = Schema.encodeEffect(PolicyJson);
const encodeBriefJson = Schema.encodeEffect(BriefJson);
const encodePendingQuestionsJson = Schema.encodeEffect(PendingQuestionsJson);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const globalKillSwitchRef = yield* Ref.make(false);

  const readFailed = (detail: string) => (cause: unknown) =>
    new PmStoreError({ operation: "read", detail, cause });
  const writeFailed = (detail: string) => (cause: unknown) =>
    new PmStoreError({ operation: "write", detail, cause });

  const configColumns = sql`
    thread_id AS "threadId",
    meta_project_id AS "metaProjectId",
    role,
    delegation_depth AS "delegationDepth",
    policy_json AS "policy",
    kill_switch_active AS "killSwitchActive",
    delegated_turn_count AS "delegatedTurnCount",
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const workerColumns = sql`
    dispatch_command_id AS "dispatchCommandId",
    worker_thread_id AS "workerThreadId",
    pm_thread_id AS "pmThreadId",
    client_key AS "clientKey",
    environment_id AS "environmentId",
    project_id AS "projectId",
    title,
    role AS "targetRepoRole",
    provider_instance_id AS "providerInstanceId",
    use_worktree AS "useWorktree",
    status,
    turn_count AS "turnCount",
    brief_json AS "brief",
    summary,
    pending_questions_json AS "pendingQuestions",
    started_at AS "startedAt",
    updated_at AS "updatedAt"
  `;

  const findConfigRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: PmThreadConfigRow,
    execute: (threadId) => sql`
      SELECT ${configColumns} FROM pm_thread_configs
      WHERE thread_id = ${threadId}
      LIMIT 1
    `,
  });

  const findWorkerRows = SqlSchema.findAll({
    Request: ThreadId,
    Result: PmWorkerDispatchRow,
    execute: (workerThreadId) => sql`
      SELECT ${workerColumns} FROM pm_worker_dispatches
      WHERE worker_thread_id = ${workerThreadId}
      LIMIT 1
    `,
  });

  const listWorkerRowsByPm = SqlSchema.findAll({
    Request: ThreadId,
    Result: PmWorkerDispatchRow,
    execute: (pmThreadId) => sql`
      SELECT ${workerColumns} FROM pm_worker_dispatches
      WHERE pm_thread_id = ${pmThreadId}
      ORDER BY rowid ASC
    `,
  });

  const getConfig: PmStore["Service"]["getConfig"] = Effect.fn("PmStore.getConfig")(
    function* (threadId) {
      const rows = yield* findConfigRows(threadId).pipe(
        Effect.mapError(readFailed(`Could not read PM thread config '${threadId}'.`)),
      );
      return rows[0] ?? null;
    },
  );

  const upsertConfig: PmStore["Service"]["upsertConfig"] = Effect.fn("PmStore.upsertConfig")(
    function* (input) {
      const existing = yield* getConfig(input.threadId);
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      const metaProjectId =
        input.metaProjectId === undefined ? (existing?.metaProjectId ?? null) : input.metaProjectId;
      const role = input.role ?? existing?.role ?? "standard";
      const delegationDepth = input.delegationDepth ?? existing?.delegationDepth ?? 0;
      const policy = input.policy ?? existing?.policy ?? DEFAULT_PM_WORKER_POLICY;
      const killSwitchActive = input.killSwitchActive ?? existing?.killSwitchActive ?? false;
      const delegatedTurnCount = input.delegatedTurnCount ?? existing?.delegatedTurnCount ?? 0;
      const createdAt = existing?.createdAt ?? nowIso;
      const policyJson = yield* encodePolicyJson(policy).pipe(
        Effect.mapError(writeFailed("Could not encode PM worker policy.")),
      );

      yield* sql`
        INSERT INTO pm_thread_configs (
          thread_id, meta_project_id, role, delegation_depth, policy_json,
          kill_switch_active, delegated_turn_count, created_at, updated_at
        ) VALUES (
          ${input.threadId}, ${metaProjectId}, ${role}, ${delegationDepth}, ${policyJson},
          ${killSwitchActive ? 1 : 0}, ${delegatedTurnCount}, ${createdAt}, ${nowIso}
        )
        ON CONFLICT (thread_id) DO UPDATE SET
          meta_project_id = excluded.meta_project_id,
          role = excluded.role,
          delegation_depth = excluded.delegation_depth,
          policy_json = excluded.policy_json,
          kill_switch_active = excluded.kill_switch_active,
          delegated_turn_count = excluded.delegated_turn_count,
          updated_at = excluded.updated_at
      `.pipe(
        Effect.mapError(writeFailed(`Could not upsert PM thread config '${input.threadId}'.`)),
      );

      return {
        threadId: input.threadId,
        metaProjectId,
        role,
        delegationDepth,
        policy,
        killSwitchActive,
        delegatedTurnCount,
        createdAt,
        updatedAt: nowIso,
      };
    },
  );

  const setThreadKillSwitch: PmStore["Service"]["setThreadKillSwitch"] = Effect.fn(
    "PmStore.setThreadKillSwitch",
  )(function* (threadId, active) {
    return yield* upsertConfig({ threadId, killSwitchActive: active });
  });

  const incrementDelegatedTurns: PmStore["Service"]["incrementDelegatedTurns"] = Effect.fn(
    "PmStore.incrementDelegatedTurns",
  )(function* (threadId, delta = 1) {
    const existing = yield* getConfig(threadId);
    const current = existing?.delegatedTurnCount ?? 0;
    return yield* upsertConfig({
      threadId,
      delegatedTurnCount: Math.max(0, current + delta),
    });
  });

  const getWorkerDispatch: PmStore["Service"]["getWorkerDispatch"] = Effect.fn(
    "PmStore.getWorkerDispatch",
  )(function* (workerThreadId) {
    const rows = yield* findWorkerRows(workerThreadId).pipe(
      Effect.mapError(readFailed(`Could not read worker dispatch '${workerThreadId}'.`)),
    );
    return rows[0] ?? null;
  });

  const listWorkersByPmThread: PmStore["Service"]["listWorkersByPmThread"] = Effect.fn(
    "PmStore.listWorkersByPmThread",
  )(function* (pmThreadId) {
    return yield* listWorkerRowsByPm(pmThreadId).pipe(
      Effect.mapError(readFailed(`Could not list workers for PM thread '${pmThreadId}'.`)),
    );
  });

  const putWorkerDispatch: PmStore["Service"]["putWorkerDispatch"] = Effect.fn(
    "PmStore.putWorkerDispatch",
  )(function* (input) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const status = input.status ?? "running";
    const dispatchCommandId = input.dispatchCommandId ?? null;
    const turnCount = input.turnCount ?? 1;
    const targetRepoRole = input.targetRepoRole ?? null;
    const providerInstanceId = input.providerInstanceId ?? null;
    const summary = input.summary ?? null;
    const pendingQuestions = [...(input.pendingQuestions ?? [])];
    const startedAt = input.startedAt === undefined ? nowIso : input.startedAt;
    const briefJson = yield* encodeBriefJson(input.brief).pipe(
      Effect.mapError(writeFailed("Could not encode worker brief.")),
    );
    const pendingQuestionsJson = yield* encodePendingQuestionsJson(pendingQuestions).pipe(
      Effect.mapError(writeFailed("Could not encode worker pending questions.")),
    );

    yield* sql`
      INSERT INTO pm_worker_dispatches (
        worker_thread_id, pm_thread_id, client_key, dispatch_command_id, environment_id, project_id,
        title, role, provider_instance_id, use_worktree, status, turn_count,
        brief_json, summary, pending_questions_json, started_at, updated_at
      ) VALUES (
        ${input.workerThreadId}, ${input.pmThreadId}, ${input.clientKey}, ${dispatchCommandId},
        ${input.environmentId}, ${input.projectId}, ${input.title},
        ${targetRepoRole}, ${providerInstanceId}, ${input.useWorktree ? 1 : 0},
        ${status}, ${turnCount}, ${briefJson}, ${summary}, ${pendingQuestionsJson},
        ${startedAt}, ${nowIso}
      )
      ON CONFLICT (worker_thread_id) DO UPDATE SET
        status = excluded.status,
        turn_count = excluded.turn_count,
        brief_json = excluded.brief_json,
        summary = excluded.summary,
        pending_questions_json = excluded.pending_questions_json,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at
    `.pipe(
      Effect.mapError(writeFailed(`Could not persist worker dispatch '${input.workerThreadId}'.`)),
    );

    return {
      workerThreadId: input.workerThreadId,
      dispatchCommandId,
      pmThreadId: input.pmThreadId,
      clientKey: input.clientKey,
      environmentId: input.environmentId,
      projectId: input.projectId,
      title: input.title,
      targetRepoRole,
      providerInstanceId,
      useWorktree: input.useWorktree,
      status,
      turnCount,
      brief: input.brief,
      summary,
      pendingQuestions,
      startedAt,
      updatedAt: nowIso,
    };
  });

  const updateWorkerProgress: PmStore["Service"]["updateWorkerProgress"] = Effect.fn(
    "PmStore.updateWorkerProgress",
  )(function* (input) {
    const existing = yield* getWorkerDispatch(input.workerThreadId);
    if (existing === null) return null;
    return yield* putWorkerDispatch({
      ...(existing.dispatchCommandId === null
        ? {}
        : { dispatchCommandId: existing.dispatchCommandId }),
      workerThreadId: existing.workerThreadId,
      pmThreadId: existing.pmThreadId,
      clientKey: existing.clientKey,
      environmentId: existing.environmentId,
      projectId: existing.projectId,
      title: existing.title,
      targetRepoRole: existing.targetRepoRole,
      providerInstanceId: existing.providerInstanceId,
      useWorktree: existing.useWorktree,
      status: input.status ?? existing.status,
      turnCount: input.turnCount ?? existing.turnCount,
      brief: existing.brief,
      summary: input.summary === undefined ? existing.summary : input.summary,
      pendingQuestions: input.pendingQuestions ?? existing.pendingQuestions,
      startedAt: input.startedAt === undefined ? existing.startedAt : input.startedAt,
    });
  });

  const recordWorkerLaunch: PmStore["Service"]["recordWorkerLaunch"] = Effect.fn(
    "PmStore.recordWorkerLaunch",
  )(function* (input, config) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* getWorkerDispatch(input.workerThreadId);
          if (existing !== null) return existing;
          yield* upsertConfig({ ...config, threadId: input.workerThreadId, role: "worker" });
          const worker = yield* putWorkerDispatch(input);
          yield* incrementDelegatedTurns(input.pmThreadId, 1);
          return worker;
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "PmStoreError"
            ? cause
            : new PmStoreError({
                operation: "write",
                detail: "Could not record PM worker launch.",
                cause,
              }),
        ),
      );
  });

  const cancelActiveWorkers: PmStore["Service"]["cancelActiveWorkers"] = Effect.fn(
    "PmStore.cancelActiveWorkers",
  )(function* (pmThreadId, summary = "Stopped by PM kill switch.") {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      UPDATE pm_worker_dispatches
      SET status = 'cancelled',
          summary = ${summary},
          pending_questions_json = '[]',
          updated_at = ${nowIso}
      WHERE pm_thread_id = ${pmThreadId}
        AND status IN ('queued', 'running', 'waiting_approval', 'waiting_input')
    `.pipe(Effect.mapError(writeFailed(`Could not cancel active workers for '${pmThreadId}'.`)));
    return yield* listWorkersByPmThread(pmThreadId);
  });

  const setGlobalKillSwitch: PmStore["Service"]["setGlobalKillSwitch"] = Effect.fn(
    "PmStore.setGlobalKillSwitch",
  )(function* (active: boolean) {
    yield* Ref.set(globalKillSwitchRef, active);
    return active;
  });

  return PmStore.of({
    getConfig,
    upsertConfig,
    setThreadKillSwitch,
    getGlobalKillSwitch: Ref.get(globalKillSwitchRef),
    setGlobalKillSwitch,
    incrementDelegatedTurns,
    getWorkerDispatch,
    listWorkersByPmThread,
    putWorkerDispatch,
    recordWorkerLaunch,
    updateWorkerProgress,
    cancelActiveWorkers,
  });
});

export const layer = Layer.effect(PmStore, make);
