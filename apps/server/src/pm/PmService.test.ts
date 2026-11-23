import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PmWorkerPolicy,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type WorkerContextBrief,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import migrate107 from "../persistence/Migrations/107_PmOrchestration.ts";
import * as PmService from "./PmService.ts";
import * as PmStore from "./PmStore.ts";

const envLocal = EnvironmentId.make("env-local");
const projWeb = ProjectId.make("proj-web");
const projApi = ProjectId.make("proj-api");
const pmThreadId = ThreadId.make("thread-pm");
const standardThreadId = ThreadId.make("thread-std");
const codexDriver = ProviderDriverKind.make("codex");

const brief: WorkerContextBrief = {
  objective: "Build the PM status drawer",
  background: "Shows running workers and pending questions.",
  constraints: ["Do not alter server persistence"],
  relatedFiles: [{ path: "apps/web/src/pm/StatusDrawer.tsx" }],
  completionCriteria: ["Drawer lists active workers"],
  verificationCommands: ["vp test run apps/web/src/pm/StatusDrawer.test.tsx"],
};

const policy: PmWorkerPolicy = {
  maxConcurrentWorkers: 2,
  requireWorktreeIsolation: true,
  allowNestedDelegation: false,
  allowedTargets: [],
  maxDelegatedTurns: 10,
  directEditSuppressedProviders: [codexDriver],
};

const members = [
  { environmentId: envLocal, projectId: projWeb, role: "frontend", name: "t3-web" },
  { environmentId: envLocal, projectId: projApi, role: "backend", name: "t3-api" },
];

const makeTestLayer = (options?: PmService.PmServiceOptions) => {
  const sqliteLayer = NodeSqliteClient.layer({ filename: ":memory:" });
  const storeLayer = PmStore.layer.pipe(Layer.provideMerge(sqliteLayer));
  return PmService.makeLayer(options).pipe(Layer.provideMerge(storeLayer));
};

it.layer(
  makeTestLayer({
    resolveMetaProject: (id) =>
      Effect.succeed({
        id,
        name: "T3 Monorepo",
        handbookMarkdown: "Verify with vp test run.",
        members,
      }),
  }),
)("PmService", (it) => {
  it.effect(
    "injects turn context only for PM threads, dispatches workers within limits, aggregates questions, and stops workers",
    () =>
      Effect.gen(function* () {
        yield* migrate107;
        const service = yield* PmService.PmService;

        expect(
          yield* service.buildTurnContextPrefix({
            threadId: standardThreadId,
            supportsSystemContext: true,
            userPrompt: "Hello",
          }),
        ).toBeNull();

        yield* service.setThreadRole({
          threadId: pmThreadId,
          role: "pm",
          metaProjectId: "meta-t3",
          policy,
        });

        const launchedPrompts: Array<string> = [];
        const batchResult = yield* service.dispatchBatch(
          {
            pmThreadId,
            items: [
              { clientKey: "fe", title: "Frontend drawer", targetRepoRole: "frontend", brief },
              { clientKey: "be", title: "Backend endpoint", targetRepoRole: "backend", brief },
              {
                clientKey: "over",
                title: "Extra task",
                targetRepoRole: "frontend",
                brief,
              },
            ],
          },
          {
            launchWorker: (request) =>
              Effect.sync(() => {
                launchedPrompts.push(request.promptPack.prompt);
                return {
                  workerThreadId: ThreadId.make(`worker-${request.clientKey}`),
                  status: "running",
                };
              }),
          },
        );

        expect(batchResult.dispatched.map((item) => item.threadId)).toEqual([
          "worker-fe",
          "worker-be",
        ]);
        expect(batchResult.rejected).toEqual([
          {
            clientKey: "over",
            reason: "concurrency_limit",
            detail: "2 of 2 workers are already running.",
          },
        ]);
        expect(launchedPrompts[0]).toContain("Verify with vp test run.");

        const nestedAttempt = yield* service.dispatchBatch({
          pmThreadId: ThreadId.make("worker-fe"),
          items: [{ clientKey: "sub", title: "Subworker", targetRepoRole: "frontend", brief }],
        });
        expect(nestedAttempt.dispatched).toEqual([]);
        expect(nestedAttempt.rejected[0]?.reason).toBe("nested_delegation_forbidden");

        yield* service.recordWorkerUpdate({
          workerThreadId: ThreadId.make("worker-fe"),
          status: "waiting_approval",
          turnCount: 3,
          summary: "Ready to migrate schema",
          pendingQuestions: ["Approve adding the drawer route?"],
        });

        const snapshot = yield* service.getBoardSnapshot(pmThreadId);
        expect(snapshot.delegatedTurnCount).toBe(2);
        expect(snapshot.pendingQuestions).toEqual([
          {
            workerThreadId: ThreadId.make("worker-fe"),
            title: "Frontend drawer",
            status: "waiting_approval",
            questions: ["Approve adding the drawer route?"],
          },
        ]);

        const inlineContext = yield* service.buildTurnContextPrefix({
          threadId: pmThreadId,
          providerDriver: codexDriver,
          supportsSystemContext: false,
          userPrompt: "Continue coordinating",
        });
        expect(inlineContext?.mode).toBe("inline");
        expect(inlineContext?.directEditSuppressed).toBe(true);
        expect(inlineContext?.promptText).toContain("<t3_pm_context>");
        expect(inlineContext?.promptText).toContain("Approve adding the drawer route?");

        const stoppedIds: Array<ThreadId> = [];
        const stopped = yield* service.stopAllWorkers(
          { pmThreadId, reason: "Emergency stop" },
          {
            stopWorker: ({ workerThreadId }) =>
              Effect.sync(() => {
                stoppedIds.push(workerThreadId);
              }),
          },
        );
        expect(stopped.killSwitchActive).toBe(true);
        expect(stopped.stoppedWorkerThreadIds).toEqual(["worker-fe", "worker-be"]);
        expect(stoppedIds).toEqual(["worker-fe", "worker-be"]);

        const afterStop = yield* service.dispatchBatch({
          pmThreadId,
          items: [{ clientKey: "blocked", title: "Blocked", targetRepoRole: "frontend", brief }],
        });
        expect(afterStop.dispatched).toEqual([]);
        expect(afterStop.rejected[0]?.reason).toBe("kill_switch_active");
      }),
  );
});
