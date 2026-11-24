import {
  createPmBoardEnvironmentAtoms,
  type PmPolicyUpdateTarget,
} from "@t3tools/client-runtime/state/pmBoard";
import type {
  EnvironmentId,
  PmBoardWorkerSummary,
  PmDispatchBatchInput,
  PmWorkerPolicy,
  ThreadId,
  ThreadRole,
} from "@t3tools/contracts";
import { useMessages } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

export const pmBoardEnvironment = createPmBoardEnvironmentAtoms(connectionAtomRuntime);

export interface PmBoardPendingQuestionItem {
  readonly workerThreadId: ThreadId;
  readonly title: string;
  readonly status: PmBoardWorkerSummary["status"];
  readonly questions: ReadonlyArray<string>;
}

export interface PmBoardSnapshotData {
  readonly pmThreadId: ThreadId;
  readonly role: ThreadRole;
  readonly metaProjectId: string | null;
  readonly policy: PmWorkerPolicy;
  readonly killSwitchActive: boolean;
  readonly delegatedTurnCount: number;
  readonly workers: ReadonlyArray<PmBoardWorkerSummary>;
  readonly generatedAt: string;
  readonly pendingQuestions: ReadonlyArray<PmBoardPendingQuestionItem>;
}

export function usePmBoard(environmentId: EnvironmentId | null, pmThreadId: ThreadId | null) {
  const resolve = useMessages();
  const query = useEnvironmentQuery(
    environmentId !== null && pmThreadId !== null
      ? pmBoardEnvironment.board({ environmentId, input: { pmThreadId } })
      : null,
    resolve,
  );
  return {
    board: query.data,
    error: query.error,
    isPending: query.isPending,
    isSuccess: query.isSuccess,
    refresh: query.refresh,
  };
}

export function usePmBoardActions() {
  const setRole = useAtomCommand(pmBoardEnvironment.setRole, {
    label: "pm:set-role",
    reportFailure: false,
  });
  const updatePolicy = useAtomCommand(pmBoardEnvironment.updatePolicy, {
    label: "pm:update-policy",
    reportFailure: false,
  });
  const setKillSwitch = useAtomCommand(pmBoardEnvironment.setKillSwitch, {
    label: "pm:set-kill-switch",
    reportFailure: false,
  });
  const resetKillSwitch = useAtomCommand(pmBoardEnvironment.resetKillSwitch, {
    label: "pm:reset-kill-switch",
    reportFailure: false,
  });
  const dispatchBatch = useAtomCommand(pmBoardEnvironment.dispatchBatch, {
    label: "pm:dispatch-batch",
    reportFailure: false,
  });
  const stopAll = useAtomCommand(pmBoardEnvironment.stopAll, {
    label: "pm:stop-all",
    reportFailure: false,
  });

  return {
    setRole: (input: {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly role: ThreadRole;
      readonly metaProjectId?: string | null | undefined;
      readonly policy?: PmWorkerPolicy | undefined;
    }) =>
      setRole({
        environmentId: input.environmentId,
        input: {
          threadId: input.threadId,
          role: input.role,
          ...(input.metaProjectId === undefined ? {} : { metaProjectId: input.metaProjectId }),
          ...(input.policy === undefined ? {} : { policy: input.policy }),
        },
      }),
    updatePolicy: (target: PmPolicyUpdateTarget) =>
      updatePolicy({
        environmentId: target.environmentId,
        input: {
          threadId: target.threadId,
          role: target.role,
          policy: target.policy,
          ...(target.metaProjectId === undefined ? {} : { metaProjectId: target.metaProjectId }),
        },
      }),
    setKillSwitch: (input: {
      readonly environmentId: EnvironmentId;
      readonly scope: "global" | "thread";
      readonly threadId?: ThreadId | undefined;
      readonly active: boolean;
    }) =>
      setKillSwitch({
        environmentId: input.environmentId,
        input: {
          scope: input.scope,
          active: input.active,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        },
      }),
    resetKillSwitch: (input: {
      readonly environmentId: EnvironmentId;
      readonly scope: "global" | "thread";
      readonly threadId?: ThreadId | undefined;
    }) =>
      resetKillSwitch({
        environmentId: input.environmentId,
        input: {
          scope: input.scope,
          active: false,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        },
      }),
    dispatchBatch: (environmentId: EnvironmentId, input: PmDispatchBatchInput) =>
      dispatchBatch({ environmentId, input }),
    stopAll: (input: {
      readonly environmentId: EnvironmentId;
      readonly pmThreadId: ThreadId;
      readonly activateKillSwitch?: boolean | undefined;
      readonly reason?: string | undefined;
    }) =>
      stopAll({
        environmentId: input.environmentId,
        input: {
          pmThreadId: input.pmThreadId,
          ...(input.activateKillSwitch === undefined
            ? {}
            : { activateKillSwitch: input.activateKillSwitch }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
        },
      }),
  };
}
