import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  MetaProjectError,
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
  PmDispatchError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import type * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import type * as PmService from "./PmService.ts";
import { makePmRuntimeOptions, type PmRuntimeDeps } from "./PmRuntimeWiring.ts";

const here = EnvironmentId.make("env-here");
const there = EnvironmentId.make("env-there");
const projectId = ProjectId.make("proj-web");
const pmThreadId = ThreadId.make("thread-pm");
const codex = ProviderInstanceId.make("codex");
const remoteWorker = ThreadId.make("thread-remote-worker");
const remoteTaskId = NodeId.make("node-remote-task");

const pmThread = {
  id: pmThreadId,
  projectId,
  modelSelection: { instanceId: codex, model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
};

const remoteTask = {
  id: remoteTaskId,
  remoteChild: { environmentId: there, threadId: remoteWorker, label: "There", title: "W" },
} as unknown as OrchestrationV2Subagent;

const launchRequest = (
  overrides: Partial<PmService.PmWorkerLaunchRequest> = {},
): PmService.PmWorkerLaunchRequest => ({
  pmThreadId,
  clientKey: "fe",
  title: "Frontend drawer",
  environmentId: here,
  projectId,
  targetRepoRole: "frontend",
  providerInstanceId: null,
  runtimeMode: undefined,
  useWorktree: true,
  brief: {
    objective: "Build it",
    background: "",
    constraints: [],
    relatedFiles: [],
    completionCriteria: [],
    verificationCommands: [],
  },
  promptPack: { prompt: "WORKER PROMPT" } as PmService.PmWorkerLaunchRequest["promptPack"],
  ...overrides,
});

const pmScope = Effect.provideService(McpInvocationContext.McpInvocationContext, {
  environmentId: here,
  requestNamespace: `provider:${pmThreadId}`,
  thread: { threadId: pmThreadId, providerSessionId: "session-pm", providerInstanceId: codex },
  client: undefined,
  capabilities: new Set(["orchestration" as const]),
  issuedAt: 0,
});

const makeHarness = () => {
  const launches: Array<ThreadLaunch.ThreadLaunchInput> = [];
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const delegated: Array<Parameters<RemoteDelegation.RemoteDelegation["Service"]["delegate"]>[1]> =
    [];
  const cancelled: Array<{ readonly taskId: NodeId; readonly reason: string | undefined }> = [];
  const deps: PmRuntimeDeps = {
    hereEnvironmentId: here,
    threads: {
      getThreadRecords: (() =>
        Effect.succeed({
          thread: pmThread,
          subagents: delegated.length === 0 && cancelled.length === 0 ? [] : [remoteTask],
        })) as unknown as ThreadManagement.ThreadManagementServiceShape["getThreadRecords"],
      dispatch: (command) =>
        Effect.sync(() => {
          dispatched.push(command);
          return {} as Effect.Success<
            ReturnType<ThreadManagement.ThreadManagementServiceShape["dispatch"]>
          >;
        }),
    },
    threadLaunch: {
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          return { threadId: ThreadId.make("thread-local-worker") } as Effect.Success<
            ReturnType<ThreadLaunch.ThreadLaunchService["Service"]["launch"]>
          >;
        }),
    },
    remote: {
      delegate: (_scope, input) =>
        Effect.sync(() => {
          delegated.push(input);
          return { taskId: remoteTaskId };
        }),
      cancel: (_scope, task, input) =>
        Effect.sync(() => {
          cancelled.push({ taskId: task.id, reason: input.reason });
          return { taskId: task.id, status: "cancelled" as const };
        }),
    },
    metaProjects: {
      get: () =>
        Effect.fail(new MetaProjectError({ reason: "not_found", message: "Missing meta project" })),
    },
  };
  return { deps, launches, dispatched, delegated, cancelled };
};

it.effect("launches a local worker through ThreadLaunchService with the PM thread's model", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const options = makePmRuntimeOptions(harness.deps);

    const launched = yield* options.launchWorker!(launchRequest());
    expect(launched.workerThreadId).toBe("thread-local-worker");
    expect(harness.launches).toHaveLength(1);
    expect(harness.launches[0]).toMatchObject({
      projectId,
      title: "Frontend drawer",
      modelSelection: pmThread.modelSelection,
      runtimeMode: "full-access",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      initialMessage: { text: "WORKER PROMPT", attachments: [] },
    });

    const otherProvider = yield* options.launchWorker!(
      launchRequest({ providerInstanceId: ProviderInstanceId.make("claude") }),
    ).pipe(Effect.flip);
    expect(otherProvider).toBeInstanceOf(PmDispatchError);
    expect(harness.launches).toHaveLength(1);

    yield* options.stopWorker!({
      pmThreadId,
      workerThreadId: launched.workerThreadId,
      environmentId: here,
      projectId,
      reason: "Emergency stop",
    });
    expect(harness.dispatched).toMatchObject([
      { type: "thread.stop", threadId: "thread-local-worker", reason: "Emergency stop" },
    ]);
  }),
);

it.effect("drives a linked-environment worker through RemoteDelegation as the PM caller", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const options = makePmRuntimeOptions(harness.deps);
    const remoteRequest = launchRequest({ environmentId: there, useWorktree: false });

    const noCaller = yield* options.launchWorker!(remoteRequest).pipe(Effect.flip);
    expect(noCaller).toBeInstanceOf(PmDispatchError);
    expect(harness.delegated).toEqual([]);

    const worktree = yield* options.launchWorker!({ ...remoteRequest, useWorktree: true }).pipe(
      pmScope,
      Effect.flip,
    );
    expect(worktree).toBeInstanceOf(PmDispatchError);
    expect(harness.delegated).toEqual([]);

    const launched = yield* options.launchWorker!(remoteRequest).pipe(pmScope);
    expect(launched.workerThreadId).toBe(remoteWorker);
    expect(harness.delegated).toMatchObject([
      { task: "WORKER PROMPT", target: { environmentId: there, projectId }, mode: "async" },
    ]);

    const stop = {
      pmThreadId,
      workerThreadId: remoteWorker,
      environmentId: there,
      projectId,
      reason: "Emergency stop",
    };
    expect(yield* options.stopWorker!(stop).pipe(Effect.flip)).toBeInstanceOf(PmDispatchError);
    expect(harness.cancelled).toEqual([]);
    yield* options.stopWorker!(stop).pipe(pmScope);
    expect(harness.cancelled).toEqual([{ taskId: remoteTaskId, reason: "Emergency stop" }]);
    expect(harness.dispatched).toEqual([]);
  }),
);

it.effect("resolves a deleted meta-project as none", () =>
  Effect.gen(function* () {
    const options = makePmRuntimeOptions(makeHarness().deps);
    expect(yield* options.resolveMetaProject!("meta-gone")).toBeNull();
  }),
);
