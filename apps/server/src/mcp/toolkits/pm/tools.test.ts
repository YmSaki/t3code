import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PmWorkerPolicy,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type WorkerContextBrief,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import migrate107 from "../../../persistence/Migrations/107_PmOrchestration.ts";
import migrate112 from "../../../persistence/Migrations/112_PmDispatchIdempotency.ts";
import * as PmService from "../../../pm/PmService.ts";
import * as PmStore from "../../../pm/PmStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as PmHandlers from "./handlers.ts";
import { PmToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("env:pm-mcp");
const projectWeb = ProjectId.make("proj:web");
const projectApi = ProjectId.make("proj:api");
const pmThreadId = ThreadId.make("thread:pm");
const standardThreadId = ThreadId.make("thread:standard");
const otherPmThreadId = ThreadId.make("thread:other-pm");

const brief = {
  objective: "Ship the PM status card",
  background: "Displays worker counts and pending approvals.",
  constraints: ["Stay within web package"],
  relatedFiles: [{ path: "apps/web/src/pm/StatusCard.tsx" }],
  completionCriteria: ["Status card renders active count"],
  verificationCommands: ["vp test run apps/web/src/pm/StatusCard.test.tsx"],
} satisfies WorkerContextBrief;

const policy: PmWorkerPolicy = {
  maxConcurrentWorkers: 1,
  requireWorktreeIsolation: true,
  allowNestedDelegation: false,
  allowedTargets: [],
  maxDelegatedTurns: 8,
  directEditSuppressedProviders: [ProviderDriverKind.make("codex")],
};

const invocationLayer = (callerThreadId: ThreadId) =>
  Layer.succeed(McpInvocationContext.McpInvocationContext, {
    environmentId,
    requestNamespace: `provider:${callerThreadId}`,
    thread: {
      threadId: callerThreadId,
      providerSessionId: `provider:${callerThreadId}`,
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(["orchestration" as const]),
    issuedAt: 0,
  });

const basePmLayer = () => {
  const sqliteLayer = NodeSqliteClient.layer({ filename: ":memory:" });
  const storeLayer = PmStore.layer.pipe(Layer.provideMerge(sqliteLayer));
  const serviceLayer = PmService.makeLayer({
    launchWorker: (request) =>
      Effect.succeed({
        workerThreadId: ThreadId.make(`worker:${request.pmThreadId}:${request.clientKey}`),
        status: "running" as const,
      }),
    stopWorker: () => Effect.void,
    resolveMetaProject: (id) =>
      Effect.succeed({
        id,
        name: "T3 Workspace",
        handbookMarkdown: "Run check:changed before finishing.",
        members: [
          { environmentId, projectId: projectWeb, role: "frontend", name: "web" },
          { environmentId, projectId: projectApi, role: "backend", name: "api" },
        ],
      }),
  }).pipe(Layer.provideMerge(storeLayer));
  const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (id) => Effect.succeed(liveThreadShell(id)),
  });
  return Layer.mergeAll(serviceLayer, threadsLayer);
};

it("exports provider-compatible object schemas for all PM tools", () => {
  for (const tool of Object.values(PmToolkit.tools)) {
    const schema = Tool.getJsonSchema(tool) as {
      readonly type?: unknown;
      readonly anyOf?: unknown;
      readonly oneOf?: unknown;
    };
    expect(schema.type, `${tool.name} must export a top-level object schema`).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
  }
});

it.effect(
  "enforces PM role permissions, concurrency limits, kill switch rejections, and pending question aggregation",
  () =>
    Effect.gen(function* () {
      yield* migrate107;
      yield* migrate112;
      const pmService = yield* PmService.PmService;

      yield* pmService.setThreadRole({
        threadId: pmThreadId,
        role: "pm",
        metaProjectId: "meta-1",
        policy,
      });

      const runAs = <A, E, R>(
        callerThreadId: ThreadId,
        program: (toolkit: Effect.Success<typeof PmToolkit>) => Effect.Effect<A, E, R>,
      ) =>
        Effect.gen(function* () {
          const toolkit = yield* PmToolkit;
          return yield* program(toolkit);
        }).pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(PmHandlers.layer).pipe(
              Layer.provideMerge(invocationLayer(callerThreadId)),
            ),
          ),
        );

      const callTool = <Name extends keyof typeof PmToolkit.tools>(
        toolkit: Effect.Success<typeof PmToolkit>,
        name: Name,
        params: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit.handle(name, params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((parts) => parts.at(-1)?.result),
        );

      // 1. Permission refusal for standard thread
      const standardDenied = yield* runAs(standardThreadId, (toolkit) =>
        callTool(toolkit, "pm_dispatch_batch", {
          items: [{ clientKey: "w1", title: "Card", targetRepoRole: "frontend", brief }],
        }),
      );
      expect(standardDenied).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("requires a PM thread"),
      });

      // Cross-thread spoofing refusal
      const spoofDenied = yield* runAs(pmThreadId, (toolkit) =>
        callTool(toolkit, "pm_dispatch_batch", {
          pmThreadId: otherPmThreadId,
          items: [{ clientKey: "w1", title: "Card", targetRepoRole: "frontend", brief }],
        }),
      );
      expect(spoofDenied).toMatchObject({
        code: "capability_denied",
      });

      // 2. Concurrency limit enforcement (maxConcurrentWorkers = 1)
      const batch = yield* runAs(pmThreadId, (toolkit) =>
        callTool(toolkit, "pm_dispatch_batch", {
          commandId: "pm-tool-batch",
          items: [
            { clientKey: "w1", title: "Frontend card", targetRepoRole: "frontend", brief },
            { clientKey: "w2", title: "Backend api", targetRepoRole: "backend", brief },
          ],
        }),
      );
      expect(batch).toMatchObject({
        pmThreadId,
        dispatched: [
          {
            clientKey: "w1",
            threadId: "worker:thread:pm:w1",
            environmentId,
            projectId: projectWeb,
            useWorktree: true,
          },
        ],
        rejected: [
          {
            clientKey: "w2",
            reason: "concurrency_limit",
          },
        ],
      });

      const replayed = yield* runAs(pmThreadId, (toolkit) =>
        callTool(toolkit, "pm_dispatch_batch", {
          commandId: "pm-tool-batch",
          items: [{ clientKey: "w1", title: "Retry frontend", targetRepoRole: "frontend", brief }],
        }),
      );
      expect(replayed).toMatchObject({
        dispatched: [{ threadId: "worker:thread:pm:w1" }],
        rejected: [],
      });

      // Nested worker permission refusal
      const workerThreadId = ThreadId.make("worker:thread:pm:w1");
      const workerDenied = yield* runAs(workerThreadId, (toolkit) =>
        callTool(toolkit, "pm_dispatch_batch", {
          items: [{ clientKey: "sub", title: "Nested", targetRepoRole: "frontend", brief }],
        }),
      );
      expect(workerDenied).toMatchObject({
        code: "capability_denied",
        message: expect.stringContaining("not permitted to delegate"),
      });

      // 3. Pending approval / question aggregation on pm_board_status
      yield* pmService.recordWorkerUpdate({
        workerThreadId,
        status: "waiting_approval",
        turnCount: 2,
        summary: "Ready to merge",
        pendingQuestions: ["Approve adding the status card to the sidebar?"],
      });

      const board = yield* runAs(pmThreadId, (toolkit) => callTool(toolkit, "pm_board_status", {}));
      expect(board).toMatchObject({
        pmThreadId,
        delegatedTurnCount: 1,
        pendingQuestions: [
          {
            workerThreadId,
            title: "Frontend card",
            status: "waiting_approval",
            questions: ["Approve adding the status card to the sidebar?"],
          },
        ],
      });

      // 4. pm_build_worker_brief budget clamping
      const builtBrief = yield* runAs(pmThreadId, (toolkit) =>
        callTool(toolkit, "pm_build_worker_brief", {
          title: "Frontend card",
          brief,
          targetRepoRole: "frontend",
          handbookMarkdown: "Handbook ".repeat(100),
          maxTokens: 120,
        }),
      );
      expect(builtBrief).toMatchObject({
        effectiveMaxBytes: 480,
        truncated: true,
      });

      // 5. KillSwitch activation via pm_stop_all_workers and subsequent dispatch rejection
      const stopped = yield* runAs(pmThreadId, (toolkit) =>
        callTool(toolkit, "pm_stop_all_workers", {
          reason: "Halt delegation",
        }),
      );
      expect(stopped).toEqual({
        pmThreadId,
        killSwitchActive: true,
        stoppedWorkerThreadIds: [workerThreadId],
      });

      const afterKillSwitch = yield* runAs(pmThreadId, (toolkit) =>
        callTool(toolkit, "pm_dispatch_batch", {
          items: [{ clientKey: "w3", title: "After stop", targetRepoRole: "frontend", brief }],
        }),
      );
      expect(afterKillSwitch).toMatchObject({
        pmThreadId,
        dispatched: [],
        rejected: [
          {
            clientKey: "w3",
            reason: "kill_switch_active",
          },
        ],
      });
    }).pipe(Effect.provide(basePmLayer())),
);
