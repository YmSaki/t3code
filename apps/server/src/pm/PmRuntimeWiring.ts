import {
  CommandId,
  type EnvironmentId,
  MetaProjectId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  PmDispatchError,
  type PmWorkerStatus,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as MetaProjectService from "../metaProject/MetaProjectService.ts";
import { resolveRuntimeMode } from "../mcp/delegatedTaskModes.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as PmService from "./PmService.ts";

export interface PmRuntimeDeps {
  readonly hereEnvironmentId: EnvironmentId;
  readonly threads: Pick<
    ThreadManagement.ThreadManagementServiceShape,
    "getThreadRecords" | "dispatch"
  >;
  readonly threadLaunch: Pick<ThreadLaunch.ThreadLaunchService["Service"], "launch">;
  readonly remote: Pick<RemoteDelegation.RemoteDelegation["Service"], "delegate" | "cancel">;
  readonly metaProjects: Pick<MetaProjectService.MetaProjectService["Service"], "get">;
}

const dispatchError = (cause: unknown, clientKey?: string) =>
  new PmDispatchError({ ...(clientKey === undefined ? {} : { clientKey }), cause });

const failWith = (message: string, clientKey?: string) =>
  Effect.fail(dispatchError(new Error(message), clientKey));

/** A linked environment is driven as the PM thread's MCP caller, so it needs that caller's live scope. */
const requirePmCallerScope = Effect.fn("PmRuntimeWiring.requirePmCallerScope")(function* (
  pmThreadId: ThreadId,
  operation: string,
  clientKey?: string,
) {
  const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
  if (Option.isNone(scope) || scope.value.thread?.threadId !== pmThreadId) {
    return yield* failWith(
      `${operation} in a linked environment needs the PM thread's own agent as the MCP caller.`,
      clientKey,
    );
  }
  return scope.value as McpInvocationContext.McpThreadInvocationScope;
});

export const makePmRuntimeOptions = (deps: PmRuntimeDeps): PmService.PmServiceOptions => {
  const { threads, threadLaunch, remote, metaProjects } = deps;

  // A meta-project deleted since the PM thread was linked reads as none, as an unlinked thread does.
  const resolveMetaProject: PmService.PmMetaProjectResolver = (metaProjectId) =>
    metaProjects.get({ metaProjectId: MetaProjectId.make(metaProjectId) }).pipe(
      Effect.map(({ metaProject }) => ({
        id: metaProject.id,
        name: metaProject.title,
        handbookMarkdown: metaProject.instructionsMd,
        members: metaProject.members.map((member) => ({
          environmentId: member.environmentId,
          projectId: member.projectId,
          role: member.role,
          name: member.label ?? member.projectId,
        })),
      })),
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () => Effect.succeed(null),
      ),
      Effect.mapError((cause) => dispatchError(cause)),
    );

  const pmRecords = (pmThreadId: ThreadId, clientKey?: string) =>
    threads
      .getThreadRecords(pmThreadId, ["subagents"])
      .pipe(Effect.mapError((cause) => dispatchError(cause, clientKey)));

  const launchLocal = Effect.fn("PmRuntimeWiring.launchLocal")(function* (
    request: PmService.PmWorkerLaunchRequest,
  ) {
    const { thread: pm } = yield* pmRecords(request.pmThreadId, request.clientKey);
    if (
      request.providerInstanceId !== null &&
      request.providerInstanceId !== pm.modelSelection.instanceId
    ) {
      return yield* failWith(
        `Worker provider ${request.providerInstanceId} differs from the PM thread's ${pm.modelSelection.instanceId}, and no model is known for it.`,
        request.clientKey,
      );
    }
    const runtimeMode = yield* resolveRuntimeMode(pm.runtimeMode, request.runtimeMode).pipe(
      Effect.mapError((cause) => dispatchError(cause, request.clientKey)),
    );
    const launched = yield* threadLaunch
      .launch({
        commandId: request.commandId,
        projectId: request.projectId,
        title: request.title,
        titleRenamed: true,
        modelSelection: pm.modelSelection,
        runtimeMode,
        interactionMode: pm.interactionMode,
        workspaceStrategy: request.useWorktree
          ? { type: "worktree", baseRef: "HEAD" }
          : { type: "root" },
        initialMessage: { text: request.promptPack.prompt, attachments: [] },
        createdBy: "agent",
        creationSource: "mcp",
      })
      .pipe(Effect.mapError((cause) => dispatchError(cause, request.clientKey)));
    const latestRun = launched.resumed
      ? launched.projection?.runs.reduce<(typeof launched.projection.runs)[number] | undefined>(
          (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
          undefined,
        )
      : undefined;
    const status = (latestRun ? toPmWorkerStatus(latestRun.status) : null) ?? "running";
    return { workerThreadId: launched.threadId, status } as const;
  });

  const launchRemote = Effect.fn("PmRuntimeWiring.launchRemote")(function* (
    request: PmService.PmWorkerLaunchRequest,
  ) {
    // A task there runs in that project's checkout; RemoteDelegation cannot isolate it in a worktree.
    if (request.useWorktree) {
      return yield* failWith(
        `Worktree isolation is not supported for workers in linked environment ${request.environmentId}.`,
        request.clientKey,
      );
    }
    const scope = yield* requirePmCallerScope(
      request.pmThreadId,
      "Launching a worker",
      request.clientKey,
    );
    // Provider sessions rotate across restarts, so remote retry identity uses the durable PM thread.
    const pmScope: McpInvocationContext.McpThreadInvocationScope = {
      ...scope,
      requestNamespace: `pm:${request.pmThreadId}`,
    };
    const { taskId } = yield* remote
      .delegate(pmScope, {
        clientRequestId: request.commandId,
        task: request.promptPack.prompt,
        title: request.title,
        target: {
          environmentId: request.environmentId,
          projectId: request.projectId,
          ...(request.providerInstanceId === null
            ? {}
            : { providerInstanceId: request.providerInstanceId }),
        },
        ...(request.runtimeMode === undefined ? {} : { runtimeMode: request.runtimeMode }),
        mode: "async",
      })
      .pipe(Effect.mapError((cause) => dispatchError(cause, request.clientKey)));
    const { subagents } = yield* pmRecords(request.pmThreadId, request.clientKey);
    const workerThreadId = subagents.find((task) => task.id === taskId)?.remoteChild?.threadId;
    if (workerThreadId === undefined) {
      return yield* failWith(
        `Remote task ${taskId} was recorded without its thread in ${request.environmentId}.`,
        request.clientKey,
      );
    }
    return { workerThreadId, status: "running" } as const;
  });

  const launchWorker: PmService.PmWorkerLauncher = (request) =>
    request.environmentId === deps.hereEnvironmentId ? launchLocal(request) : launchRemote(request);

  const stopLocal = Effect.fn("PmRuntimeWiring.stopLocal")(function* (
    input: PmService.PmWorkerStopRequest,
  ) {
    yield* threads
      .dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`command:pm-stop:${yield* randomUuidV4}`),
        threadId: input.workerThreadId,
        reason: input.reason,
      })
      .pipe(Effect.mapError((cause) => dispatchError(cause)));
  });

  const stopRemote = Effect.fn("PmRuntimeWiring.stopRemote")(function* (
    input: PmService.PmWorkerStopRequest,
  ) {
    const scope = yield* requirePmCallerScope(input.pmThreadId, "Stopping a worker");
    const { subagents } = yield* pmRecords(input.pmThreadId);
    const task: OrchestrationV2Subagent | undefined = subagents.find(
      (candidate) =>
        candidate.remoteChild?.threadId === input.workerThreadId &&
        candidate.remoteChild.environmentId === input.environmentId,
    );
    if (task === undefined) {
      return yield* failWith(
        `No remote task of PM thread ${input.pmThreadId} runs worker ${input.workerThreadId}.`,
      );
    }
    yield* remote
      .cancel(scope, task, { reason: input.reason })
      .pipe(Effect.mapError((cause) => dispatchError(cause)));
  });

  const stopWorker: PmService.PmWorkerStopper = (input) =>
    input.environmentId === deps.hereEnvironmentId ? stopLocal(input) : stopRemote(input);

  return { launchWorker, stopWorker, resolveMetaProject };
};

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const hereEnvironmentId = yield* ServerEnvironment.ServerEnvironment.pipe(
      Effect.flatMap((environment) => environment.getEnvironmentId),
    );
    const options = makePmRuntimeOptions({
      hereEnvironmentId,
      threads: yield* ThreadManagement.ThreadManagementService,
      threadLaunch: yield* ThreadLaunch.ThreadLaunchService,
      remote: yield* RemoteDelegation.RemoteDelegation,
      metaProjects: yield* MetaProjectService.MetaProjectService,
    });
    return PmService.makeLayer(options);
  }),
);

const STREAM_RETRY_DELAY = Duration.seconds(5);

function toPmWorkerStatus(runStatus: string): PmWorkerStatus | null {
  switch (runStatus) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    case "waiting":
      return "waiting_input";
    default:
      return null;
  }
}

/** Syncs PM worker slot status from `run.updated` domain events so completed/failed workers free concurrency slots. */
const runPmWorkerStatusSync = Effect.fn("PmRuntimeWiring.runWorkerStatusSync")(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const pmService = yield* PmService.PmService;

  const handle = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    if (event.type !== "run.updated") return;
    const status = toPmWorkerStatus(event.payload.status);
    if (status === null) return;
    yield* pmService.recordWorkerUpdate({ workerThreadId: event.threadId, status }).pipe(
      Effect.catchTags({ PmThreadNotFoundError: () => Effect.void }),
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to sync PM worker status", {
          threadId: event.threadId,
          status,
          cause,
        }),
      ),
    );
  });

  yield* Stream.runForEach(orchestrator.streamDomainEvents, handle).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("PM worker status sync stream failed; resubscribing", { error }),
    ),
    Effect.retry(Schedule.spaced(STREAM_RETRY_DELAY)),
  );
});

export const startPmWorkerStatusSync = () => Effect.forkScoped(runPmWorkerStatusSync());
