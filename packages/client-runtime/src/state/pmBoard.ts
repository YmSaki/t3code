import {
  type EnvironmentId,
  type PmBoardWorkerSummary,
  type PmWorkerPolicy,
  type ThreadId,
  type ThreadRole,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createPmBoardEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const board = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:pm:board",
    tag: WS_METHODS.pmGetBoard,
    staleTimeMs: 5_000,
    refreshIntervalMs: 5_000,
  });

  const refreshBoard = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    pmThreadId: ThreadId,
  ) =>
    Effect.sync(() => {
      registry.refresh(board({ environmentId, input: { pmThreadId } }));
    });

  return {
    board,
    /** Alias for board query used by callers enumerating worker rows. */
    listWorkers: board,
    setRole: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pm:set-role",
      tag: WS_METHODS.pmSetRole,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshBoard(registry, environmentId, input.threadId),
    }),
    updatePolicy: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pm:update-policy",
      tag: WS_METHODS.pmSetRole,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshBoard(registry, environmentId, input.threadId),
    }),
    setKillSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pm:set-kill-switch",
      tag: WS_METHODS.pmSetKillSwitch,
      onSuccess: ({ environmentId, input }, registry) =>
        input.threadId === undefined
          ? Effect.void
          : refreshBoard(registry, environmentId, input.threadId),
    }),
    resetKillSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pm:reset-kill-switch",
      tag: WS_METHODS.pmSetKillSwitch,
      onSuccess: ({ environmentId, input }, registry) =>
        input.threadId === undefined
          ? Effect.void
          : refreshBoard(registry, environmentId, input.threadId),
    }),
    dispatchBatch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pm:dispatch-batch",
      tag: WS_METHODS.pmDispatchBatch,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshBoard(registry, environmentId, input.pmThreadId),
    }),
    stopAll: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:pm:stop-all",
      tag: WS_METHODS.pmStopAllWorkers,
      onSuccess: ({ environmentId, input }, registry) =>
        refreshBoard(registry, environmentId, input.pmThreadId),
    }),
  };
}

export interface PmPolicyUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly role: ThreadRole;
  readonly policy: PmWorkerPolicy;
  readonly metaProjectId?: string | null | undefined;
}

export function buildPmPolicyUpdateInput(target: PmPolicyUpdateTarget): {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly threadId: ThreadId;
    readonly role: ThreadRole;
    readonly policy: PmWorkerPolicy;
    readonly metaProjectId?: string | null | undefined;
  };
} {
  return {
    environmentId: target.environmentId,
    input: {
      threadId: target.threadId,
      role: target.role,
      policy: target.policy,
      ...(target.metaProjectId === undefined ? {} : { metaProjectId: target.metaProjectId }),
    },
  };
}

export function countActivePmWorkers(workers: ReadonlyArray<PmBoardWorkerSummary>): number {
  let count = 0;
  for (const worker of workers) {
    if (
      worker.status === "queued" ||
      worker.status === "running" ||
      worker.status === "waiting_approval" ||
      worker.status === "waiting_input"
    ) {
      count += 1;
    }
  }
  return count;
}
