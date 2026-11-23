import { OrchestratorMcpFailure, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PmService from "../../../pm/PmService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PmToolkit } from "./tools.ts";

const toMcpFailure = (error: PmService.PmServiceError): OrchestratorMcpFailure =>
  new OrchestratorMcpFailure({
    code: error._tag === "PmThreadNotFoundError" ? "thread_not_found" : "orchestration_error",
    message: error.message,
  });

const resolveCallerPmThreadId = Effect.fn("PmToolkit.resolveCallerPmThreadId")(function* (
  requestedThreadId: ThreadId | undefined,
  toolName: string,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, toolName);
  if (requestedThreadId !== undefined && requestedThreadId !== thread.threadId) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `${toolName} can only act on the calling thread (${thread.threadId}).`,
    });
  }
  return thread.threadId;
});

const requirePmCaller = Effect.fn("PmToolkit.requirePmCaller")(function* (
  requestedThreadId: ThreadId | undefined,
  toolName: string,
) {
  const pmThreadId = yield* resolveCallerPmThreadId(requestedThreadId, toolName);
  const pmService = yield* PmService.PmService;
  const config = yield* pmService.getConfig(pmThreadId).pipe(Effect.mapError(toMcpFailure));
  if (config.role === "standard") {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `Thread '${pmThreadId}' has role 'standard'; ${toolName} requires a PM thread.`,
    });
  }
  if (config.role === "worker" && !config.policy.allowNestedDelegation) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: `Worker thread '${pmThreadId}' is not permitted to delegate or manage child workers.`,
    });
  }
  return { pmThreadId, pmService };
});

const handlers = {
  pm_board_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const pmThreadId = yield* resolveCallerPmThreadId(input.pmThreadId, "pm_board_status");
      const pmService = yield* PmService.PmService;
      return yield* pmService.getBoardSnapshot(pmThreadId).pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  pm_dispatch_batch: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { pmThreadId, pmService } = yield* requirePmCaller(
        input.pmThreadId,
        "pm_dispatch_batch",
      );
      return yield* pmService
        .dispatchBatch({ pmThreadId, items: input.items })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  pm_stop_all_workers: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { pmThreadId, pmService } = yield* requirePmCaller(
        input.pmThreadId,
        "pm_stop_all_workers",
      );
      return yield* pmService
        .stopAllWorkers({
          pmThreadId,
          activateKillSwitch: input.activateKillSwitch,
          reason: input.reason,
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
  pm_build_worker_brief: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        "pm_build_worker_brief",
      );
      const pmService = yield* PmService.PmService;
      return yield* pmService
        .buildWorkerBrief({
          title: input.title,
          brief: input.brief,
          assignment: {
            pmThreadId: thread.threadId,
            targetRepoRole: input.targetRepoRole,
          },
          handbookMarkdown: input.handbookMarkdown,
          budget:
            input.maxBytes === undefined && input.maxTokens === undefined
              ? undefined
              : { maxBytes: input.maxBytes, maxTokens: input.maxTokens },
        })
        .pipe(Effect.mapError(toMcpFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PmToolkit.tools>;

export const layer = McpToolAccess.toLayer(PmToolkit, handlers);
