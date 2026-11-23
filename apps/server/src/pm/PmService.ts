import {
  type EnvironmentId,
  type PmBoardSnapshot,
  type PmBoardWorkerSummary,
  type PmDispatchAccepted,
  type PmDispatchBatchInput,
  type PmDispatchBatchResult,
  PmDispatchError,
  PmThreadNotFoundError,
  type PmWorkerPolicy,
  type PmWorkerStatus,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
  type ThreadRole,
  type WorkerContextBrief,
} from "@t3tools/contracts";
import {
  buildPmContext,
  isActivePmWorkerStatus,
  type PmContextDelivery,
  type PmContextMetaProject,
} from "@t3tools/shared/pmContextBuilder.core";
import { evaluateDispatchBatch, type PmGuardRepoMember } from "@t3tools/shared/pmGuard.core";
import {
  buildWorkerBriefPrompt,
  type WorkerBriefBudget,
  type WorkerBriefBuildInput,
  type WorkerBriefPromptPack,
  type WorkerFileExcerpt,
} from "@t3tools/shared/workerBrief.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";

import * as PmStore from "./PmStore.ts";

export type PmServiceError = PmStore.PmStoreError | PmThreadNotFoundError | PmDispatchError;

export interface PmPendingQuestionSummary {
  readonly workerThreadId: ThreadId;
  readonly title: string;
  readonly status: PmWorkerStatus;
  readonly questions: ReadonlyArray<string>;
}

export interface PmBoardSnapshotWithQuestions extends PmBoardSnapshot {
  readonly pendingQuestions: ReadonlyArray<PmPendingQuestionSummary>;
}

export interface PmWorkerLaunchRequest {
  readonly pmThreadId: ThreadId;
  readonly clientKey: string;
  readonly title: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetRepoRole: string | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly runtimeMode: RuntimeMode | undefined;
  readonly useWorktree: boolean;
  readonly brief: WorkerContextBrief;
  readonly promptPack: WorkerBriefPromptPack;
}

export interface PmWorkerLaunchResponse {
  readonly workerThreadId: ThreadId;
  readonly status?: PmWorkerStatus | undefined;
}

export type PmWorkerLauncher = (
  request: PmWorkerLaunchRequest,
) => Effect.Effect<PmWorkerLaunchResponse, PmDispatchError>;

export interface PmWorkerStopRequest {
  readonly pmThreadId: ThreadId;
  readonly workerThreadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly reason: string;
}

export type PmWorkerStopper = (input: PmWorkerStopRequest) => Effect.Effect<void, PmDispatchError>;

export type PmMetaProjectResolver = (
  metaProjectId: string,
) => Effect.Effect<PmContextMetaProject | null, PmServiceError>;

export interface PmServiceOptions {
  readonly launchWorker?: PmWorkerLauncher | undefined;
  readonly stopWorker?: PmWorkerStopper | undefined;
  readonly resolveMetaProject?: PmMetaProjectResolver | undefined;
}

export interface PmDispatchBatchOptions {
  readonly members?: ReadonlyArray<PmGuardRepoMember> | undefined;
  readonly handbookMarkdown?: string | undefined;
  readonly excerptsByClientKey?:
    | Readonly<Record<string, ReadonlyArray<WorkerFileExcerpt>>>
    | undefined;
  readonly budget?: WorkerBriefBudget | undefined;
  readonly launchWorker?: PmWorkerLauncher | undefined;
}

export interface PmStopAllWorkersResult {
  readonly pmThreadId: ThreadId;
  readonly killSwitchActive: boolean;
  readonly stoppedWorkerThreadIds: ReadonlyArray<ThreadId>;
}

export class PmService extends Context.Service<
  PmService,
  {
    readonly setThreadRole: (input: {
      readonly threadId: ThreadId;
      readonly role: ThreadRole;
      readonly metaProjectId?: string | null | undefined;
      readonly delegationDepth?: number | undefined;
      readonly policy?: PmWorkerPolicy | undefined;
    }) => Effect.Effect<PmStore.PmThreadConfigRecord, PmServiceError>;
    readonly getConfig: (
      threadId: ThreadId,
    ) => Effect.Effect<PmStore.PmThreadConfigRecord, PmServiceError>;
    readonly setKillSwitch: (input: {
      readonly scope: "global" | "thread";
      readonly threadId?: ThreadId | undefined;
      readonly active: boolean;
    }) => Effect.Effect<
      {
        readonly scope: "global" | "thread";
        readonly active: boolean;
        readonly threadId?: ThreadId | undefined;
      },
      PmServiceError
    >;
    readonly getBoardSnapshot: (
      pmThreadId: ThreadId,
    ) => Effect.Effect<PmBoardSnapshotWithQuestions, PmServiceError>;
    readonly buildTurnContextPrefix: (input: {
      readonly threadId: ThreadId;
      readonly supportsSystemContext: boolean;
      readonly providerDriver?: ProviderDriverKind | undefined;
      readonly userPrompt?: string | undefined;
      readonly metaProject?: PmContextMetaProject | null | undefined;
    }) => Effect.Effect<PmContextDelivery | null, PmServiceError>;
    readonly buildWorkerBrief: (
      input: WorkerBriefBuildInput,
    ) => Effect.Effect<WorkerBriefPromptPack, PmServiceError>;
    readonly dispatchBatch: (
      input: PmDispatchBatchInput,
      options?: PmDispatchBatchOptions,
    ) => Effect.Effect<PmDispatchBatchResult, PmServiceError>;
    readonly stopAllWorkers: (
      input: {
        readonly pmThreadId: ThreadId;
        readonly activateKillSwitch?: boolean | undefined;
        readonly reason?: string | undefined;
      },
      options?: {
        readonly stopWorker?: PmWorkerStopper | undefined;
      },
    ) => Effect.Effect<PmStopAllWorkersResult, PmServiceError>;
    readonly recordWorkerUpdate: (input: {
      readonly workerThreadId: ThreadId;
      readonly status?: PmWorkerStatus | undefined;
      readonly turnCount?: number | undefined;
      readonly summary?: string | null | undefined;
      readonly pendingQuestions?: ReadonlyArray<string> | undefined;
    }) => Effect.Effect<PmStore.PmWorkerDispatchRecord, PmServiceError>;
  }
>()("t3/pm/PmService") {}

const formatWorkerPreview = (record: PmStore.PmWorkerDispatchRecord): string | null => {
  const questionSuffix =
    record.pendingQuestions.length === 0 ? "" : `Questions: ${record.pendingQuestions.join("; ")}`;
  if (record.summary !== null && record.summary.trim() !== "") {
    return questionSuffix === "" ? record.summary : `${record.summary} (${questionSuffix})`;
  }
  return questionSuffix === "" ? null : questionSuffix;
};

const toBoardWorkerSummary = (record: PmStore.PmWorkerDispatchRecord): PmBoardWorkerSummary => ({
  threadId: record.workerThreadId,
  environmentId: record.environmentId,
  projectId: record.projectId,
  title: record.title,
  status: record.status,
  targetRepoRole: record.targetRepoRole,
  providerInstanceId: record.providerInstanceId,
  turnCount: record.turnCount,
  lastMessagePreview: formatWorkerPreview(record),
  startedAt: record.startedAt,
  updatedAt: record.updatedAt,
});

const notConfigured = (what: "launcher" | "stopper") =>
  new PmDispatchError({
    cause: new Error(
      `PM worker ${what} is not configured; no worker was ${what === "launcher" ? "started" : "stopped"}.`,
    ),
  });

/** @public */
export const make = Effect.fn("PmService.make")(function* (serviceOptions?: PmServiceOptions) {
  const store = yield* PmStore.PmStore;

  const getConfig: PmService["Service"]["getConfig"] = Effect.fn("PmService.getConfig")(
    function* (threadId) {
      const existing = yield* store.getConfig(threadId);
      if (existing !== null) return existing;
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      return {
        threadId,
        metaProjectId: null,
        role: "standard",
        delegationDepth: 0,
        policy: PmStore.DEFAULT_PM_WORKER_POLICY,
        killSwitchActive: false,
        delegatedTurnCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
    },
  );

  const setThreadRole: PmService["Service"]["setThreadRole"] = Effect.fn("PmService.setThreadRole")(
    function* (input) {
      return yield* store.upsertConfig({
        threadId: input.threadId,
        metaProjectId: input.metaProjectId,
        role: input.role,
        delegationDepth: input.delegationDepth,
        policy: input.policy,
      });
    },
  );

  const setKillSwitch: PmService["Service"]["setKillSwitch"] = Effect.fn("PmService.setKillSwitch")(
    function* (input) {
      if (input.scope === "global") {
        const active = yield* store.setGlobalKillSwitch(input.active);
        return { scope: "global", active };
      }
      if (input.threadId === undefined) {
        return yield* new PmDispatchError({
          cause: new Error("Thread kill switch requires a threadId."),
        });
      }
      const updated = yield* store.setThreadKillSwitch(input.threadId, input.active);
      return {
        scope: "thread",
        active: updated.killSwitchActive,
        threadId: input.threadId,
      };
    },
  );

  const getBoardSnapshot: PmService["Service"]["getBoardSnapshot"] = Effect.fn(
    "PmService.getBoardSnapshot",
  )(function* (pmThreadId) {
    const config = yield* getConfig(pmThreadId);
    const globalKillSwitch = yield* store.getGlobalKillSwitch;
    const workerRecords = yield* store.listWorkersByPmThread(pmThreadId);
    const generatedAt = DateTime.formatIso(yield* DateTime.now);
    const pendingQuestions: Array<PmPendingQuestionSummary> = [];
    for (const record of workerRecords) {
      if (record.pendingQuestions.length > 0) {
        pendingQuestions.push({
          workerThreadId: record.workerThreadId,
          title: record.title,
          status: record.status,
          questions: record.pendingQuestions,
        });
      }
    }
    return {
      pmThreadId,
      metaProjectId: config.metaProjectId,
      policy: config.policy,
      killSwitchActive: globalKillSwitch || config.killSwitchActive,
      delegatedTurnCount: config.delegatedTurnCount,
      workers: workerRecords.map(toBoardWorkerSummary),
      pendingQuestions,
      generatedAt,
    };
  });

  const resolveMetaProject = (metaProjectId: string | null) =>
    metaProjectId === null || serviceOptions?.resolveMetaProject === undefined
      ? Effect.succeed<PmContextMetaProject | null>(null)
      : serviceOptions.resolveMetaProject(metaProjectId);

  const buildTurnContextPrefix: PmService["Service"]["buildTurnContextPrefix"] = Effect.fn(
    "PmService.buildTurnContextPrefix",
  )(function* (input) {
    const config = yield* getConfig(input.threadId);
    if (config.role !== "pm") return null;
    const board = yield* getBoardSnapshot(input.threadId);
    const metaProject =
      input.metaProject === undefined
        ? yield* resolveMetaProject(config.metaProjectId)
        : input.metaProject;
    return buildPmContext({
      board,
      metaProject,
      providerDriver: input.providerDriver,
      supportsSystemContext: input.supportsSystemContext,
      userPrompt: input.userPrompt,
    });
  });

  const buildWorkerBrief: PmService["Service"]["buildWorkerBrief"] = (input) =>
    Effect.succeed(buildWorkerBriefPrompt(input));

  const dispatchBatch: PmService["Service"]["dispatchBatch"] = Effect.fn("PmService.dispatchBatch")(
    function* (input, options) {
      const config = yield* getConfig(input.pmThreadId);
      const globalKillSwitch = yield* store.getGlobalKillSwitch;
      const existingWorkers = yield* store.listWorkersByPmThread(input.pmThreadId);
      const activeWorkerCount = existingWorkers.filter((worker) =>
        isActivePmWorkerStatus(worker.status),
      ).length;
      const metaProject = yield* resolveMetaProject(config.metaProjectId);
      const members: ReadonlyArray<PmGuardRepoMember> =
        options?.members ??
        metaProject?.members.map((member) => ({
          environmentId: member.environmentId,
          projectId: member.projectId,
          role: member.role,
          name: member.name,
        })) ??
        [];
      const handbookMarkdown = options?.handbookMarkdown ?? metaProject?.handbookMarkdown;

      const decision = evaluateDispatchBatch({
        requester: {
          threadId: input.pmThreadId,
          role: config.role,
          delegationDepth: config.delegationDepth,
        },
        killSwitch: {
          global: globalKillSwitch,
          stoppedThreadIds: config.killSwitchActive
            ? new Set([input.pmThreadId])
            : new Set<ThreadId>(),
        },
        policy: config.policy,
        members,
        activeWorkerCount,
        delegatedTurnCount: config.delegatedTurnCount,
        items: input.items,
      });

      const itemsByKey = new Map(input.items.map((item) => [item.clientKey, item]));
      const launcher = options?.launchWorker ?? serviceOptions?.launchWorker;
      const dispatched: Array<PmDispatchAccepted> = [];

      for (const accepted of decision.accepted) {
        const item = itemsByKey.get(accepted.clientKey);
        if (item === undefined) continue;
        if (launcher === undefined) return yield* notConfigured("launcher");
        const promptPack = buildWorkerBriefPrompt({
          title: item.title,
          brief: item.brief,
          assignment: {
            pmThreadId: input.pmThreadId,
            environmentId: accepted.environmentId,
            projectId: accepted.projectId,
            targetRepoRole: item.targetRepoRole,
            runtimeMode: item.runtimeMode,
          },
          handbookMarkdown,
          excerpts: options?.excerptsByClientKey?.[item.clientKey],
          budget: options?.budget,
        });
        const launched = yield* launcher({
          pmThreadId: input.pmThreadId,
          clientKey: item.clientKey,
          title: item.title,
          environmentId: accepted.environmentId,
          projectId: accepted.projectId,
          targetRepoRole: item.targetRepoRole ?? null,
          providerInstanceId: item.providerInstanceId ?? null,
          runtimeMode: item.runtimeMode,
          useWorktree: accepted.useWorktree,
          brief: item.brief,
          promptPack,
        });
        yield* store.upsertConfig({
          threadId: launched.workerThreadId,
          metaProjectId: config.metaProjectId,
          role: "worker",
          delegationDepth: config.delegationDepth + 1,
          policy: config.policy,
        });
        yield* store.putWorkerDispatch({
          workerThreadId: launched.workerThreadId,
          pmThreadId: input.pmThreadId,
          clientKey: item.clientKey,
          environmentId: accepted.environmentId,
          projectId: accepted.projectId,
          title: item.title,
          targetRepoRole: item.targetRepoRole ?? null,
          providerInstanceId: item.providerInstanceId ?? null,
          useWorktree: accepted.useWorktree,
          status: launched.status ?? "running",
          turnCount: 1,
          brief: item.brief,
        });
        yield* store.incrementDelegatedTurns(input.pmThreadId, 1);
        dispatched.push({
          clientKey: accepted.clientKey,
          threadId: launched.workerThreadId,
          environmentId: accepted.environmentId,
          projectId: accepted.projectId,
          useWorktree: accepted.useWorktree,
        });
      }

      return {
        pmThreadId: input.pmThreadId,
        dispatched,
        rejected: [...decision.rejected],
      };
    },
  );

  const stopAllWorkers: PmService["Service"]["stopAllWorkers"] = Effect.fn(
    "PmService.stopAllWorkers",
  )(function* (input, options) {
    const activateKillSwitch = input.activateKillSwitch ?? true;
    const reason = input.reason ?? "Stopped by PM kill switch.";
    if (activateKillSwitch) {
      yield* store.setThreadKillSwitch(input.pmThreadId, true);
    }
    const existingWorkers = yield* store.listWorkersByPmThread(input.pmThreadId);
    const activeWorkers = existingWorkers.filter((worker) => isActivePmWorkerStatus(worker.status));
    const stopper = options?.stopWorker ?? serviceOptions?.stopWorker;
    // Every worker is attempted; only one its stopper confirmed is recorded as cancelled.
    const unstopped: Array<{ readonly workerThreadId: ThreadId; readonly cause: unknown }> = [];
    for (const worker of activeWorkers) {
      if (stopper === undefined) return yield* notConfigured("stopper");
      const result = yield* Effect.result(
        stopper({
          pmThreadId: input.pmThreadId,
          workerThreadId: worker.workerThreadId,
          environmentId: worker.environmentId,
          projectId: worker.projectId,
          reason,
        }),
      );
      if (Result.isFailure(result)) {
        unstopped.push({ workerThreadId: worker.workerThreadId, cause: result.failure });
        continue;
      }
      yield* store.updateWorkerProgress({
        workerThreadId: worker.workerThreadId,
        status: "cancelled",
        summary: reason,
      });
    }
    if (unstopped.length > 0) {
      return yield* new PmDispatchError({
        cause: new AggregateError(
          unstopped.map((entry) => entry.cause),
          `Could not stop workers: ${unstopped.map((entry) => entry.workerThreadId).join(", ")}.`,
        ),
      });
    }
    const updatedConfig = yield* getConfig(input.pmThreadId);
    return {
      pmThreadId: input.pmThreadId,
      killSwitchActive: updatedConfig.killSwitchActive,
      stoppedWorkerThreadIds: activeWorkers.map((worker) => worker.workerThreadId),
    };
  });

  const recordWorkerUpdate: PmService["Service"]["recordWorkerUpdate"] = Effect.fn(
    "PmService.recordWorkerUpdate",
  )(function* (input) {
    const updated = yield* store.updateWorkerProgress(input);
    if (updated === null) {
      return yield* new PmThreadNotFoundError({ threadId: input.workerThreadId });
    }
    return updated;
  });

  return PmService.of({
    setThreadRole,
    getConfig,
    setKillSwitch,
    getBoardSnapshot,
    buildTurnContextPrefix,
    buildWorkerBrief,
    dispatchBatch,
    stopAllWorkers,
    recordWorkerUpdate,
  });
});

export const makeLayer = (options?: PmServiceOptions) => Layer.effect(PmService, make(options));
