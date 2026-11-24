import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  PmDispatchError,
  type PmWorkerPolicy,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type WorkerContextBrief,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import migrate107 from "../persistence/Migrations/107_PmOrchestration.ts";
import migrate112 from "../persistence/Migrations/112_PmDispatchIdempotency.ts";
import * as PmService from "./PmService.ts";
import * as PmStore from "./PmStore.ts";

const envLocal = EnvironmentId.make("env-local");
const projWeb = ProjectId.make("proj-web");
const projApi = ProjectId.make("proj-api");
const pmThreadId = ThreadId.make("thread-pm");
const standardThreadId = ThreadId.make("thread-std");
const otherPmThreadId = ThreadId.make("thread-pm-other");
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
    "resumes a partially failed batch without launching or counting successful workers again",
    () =>
      Effect.gen(function* () {
        yield* migrate107;
        yield* migrate112;
        const service = yield* PmService.PmService;
        const retryPm = ThreadId.make("pm-retry");
        yield* service.setThreadRole({
          threadId: retryPm,
          role: "pm",
          metaProjectId: "meta-t3",
          policy: { ...policy, maxDelegatedTurns: 2 },
        });
        const batch = {
          commandId: CommandId.make("batch-retry"),
          pmThreadId: retryPm,
          items: [
            { clientKey: "fe", title: "Frontend", targetRepoRole: "frontend", brief },
            { clientKey: "be", title: "Backend", targetRepoRole: "backend", brief },
          ],
        };
        const attempts: string[] = [];
        let failBackend = true;
        const options: PmService.PmDispatchBatchOptions = {
          members,
          launchWorker: (request) =>
            Effect.suspend(() => {
              attempts.push(request.clientKey);
              if (request.clientKey === "be" && failBackend) {
                failBackend = false;
                return Effect.fail(new PmDispatchError({ clientKey: "be", cause: "unavailable" }));
              }
              return Effect.succeed({
                workerThreadId: ThreadId.make(`retry-worker-${attempts.length}`),
              });
            }),
        };

        expect(yield* service.dispatchBatch(batch, options).pipe(Effect.flip)).toBeInstanceOf(
          PmDispatchError,
        );
        const partial = yield* service.getBoardSnapshot(retryPm);
        expect(partial.workers).toHaveLength(1);
        expect(partial.delegatedTurnCount).toBe(1);
        yield* service.recordWorkerUpdate({
          workerThreadId: ThreadId.make("retry-worker-1"),
          status: "waiting_approval",
          pendingQuestions: ["Approve the change?"],
        });

        const resumedService = yield* PmService.make();
        const resumed = yield* resumedService.dispatchBatch(batch, options);
        expect(attempts).toEqual(["fe", "be", "be"]);
        expect(resumed.rejected).toEqual([]);
        expect(resumed.dispatched.map((item) => item.threadId)).toEqual([
          "retry-worker-1",
          "retry-worker-3",
        ]);
        expect(attempts).toEqual(["fe", "be", "be"]);
        const board = yield* service.getBoardSnapshot(retryPm);
        expect(board.workers).toHaveLength(2);
        expect(board.delegatedTurnCount).toBe(2);
        expect(board.pendingQuestions[0]?.questions).toEqual(["Approve the change?"]);

        yield* service.recordWorkerUpdate({
          workerThreadId: ThreadId.make("retry-worker-1"),
          status: "completed",
        });
        expect(yield* service.dispatchBatch(batch, options)).toEqual(resumed);
        expect(attempts).toEqual(["fe", "be", "be"]);
        expect((yield* service.getBoardSnapshot(retryPm)).delegatedTurnCount).toBe(2);
      }),
  );

  it.effect(
    "serializes retries while allowing the same client key in a new batch or another PM",
    () =>
      Effect.gen(function* () {
        yield* migrate107;
        yield* migrate112;
        const service = yield* PmService.PmService;
        const firstPm = ThreadId.make("pm-concurrent-retry");
        const secondPm = ThreadId.make("pm-concurrent-other");
        for (const threadId of [firstPm, secondPm]) {
          yield* service.setThreadRole({ threadId, role: "pm", metaProjectId: "meta-t3", policy });
        }
        let launches = 0;
        const options: PmService.PmDispatchBatchOptions = {
          launchWorker: () =>
            Effect.sync(() => ({
              workerThreadId: ThreadId.make(`concurrent-worker-${++launches}`),
            })),
        };
        const batch = {
          commandId: CommandId.make("batch-concurrent"),
          pmThreadId: firstPm,
          items: [{ clientKey: "fe", title: "Frontend", targetRepoRole: "frontend", brief }],
        };
        const results = yield* Effect.all(
          [service.dispatchBatch(batch, options), service.dispatchBatch(batch, options)],
          { concurrency: "unbounded" },
        );
        expect(results[0]).toEqual(results[1]);
        expect(launches).toBe(1);
        expect((yield* service.getBoardSnapshot(firstPm)).delegatedTurnCount).toBe(1);

        const duplicate = yield* service.dispatchBatch(
          { ...batch, items: [...batch.items, ...batch.items] },
          options,
        );
        expect(duplicate.dispatched).toHaveLength(1);
        expect(duplicate.rejected.map((item) => item.reason)).toEqual(["duplicate_client_key"]);
        expect(launches).toBe(1);

        const nextBatch = yield* service.dispatchBatch(
          { ...batch, commandId: CommandId.make("batch-new") },
          options,
        );
        const otherPm = yield* service.dispatchBatch({ ...batch, pmThreadId: secondPm }, options);
        expect(nextBatch.dispatched[0]?.threadId).toBe("concurrent-worker-2");
        expect(otherPm.dispatched[0]?.threadId).toBe("concurrent-worker-3");
        expect(launches).toBe(3);

        const legacyPm = ThreadId.make("pm-legacy-retry");
        yield* service.setThreadRole({
          threadId: legacyPm,
          role: "pm",
          metaProjectId: "meta-t3",
          policy,
        });
        const legacy = { pmThreadId: legacyPm, items: batch.items };
        const firstLegacy = yield* service.dispatchBatch(legacy, options);
        const replayLegacy = yield* service.dispatchBatch(
          {
            pmThreadId: legacyPm,
            items: [{ brief, targetRepoRole: "frontend", title: "Frontend", clientKey: "fe" }],
          },
          options,
        );
        expect(replayLegacy).toEqual(firstLegacy);
        expect(launches).toBe(4);
      }),
  );

  it.effect(
    "reuses the launch identity after a failed database commit without retaining partial bookkeeping",
    () =>
      Effect.gen(function* () {
        yield* migrate107;
        yield* migrate112;
        const sql = yield* SqlClient.SqlClient;
        const service = yield* PmService.PmService;
        const savePm = ThreadId.make("pm-save-retry");
        yield* service.setThreadRole({
          threadId: savePm,
          role: "pm",
          metaProjectId: "meta-t3",
          policy,
        });
        const batch = {
          commandId: CommandId.make("batch-save-retry"),
          pmThreadId: savePm,
          items: [{ clientKey: "fe", title: "Frontend", targetRepoRole: "frontend", brief }],
        };
        const launchIds: CommandId[] = [];
        const launches = new Map<CommandId, ThreadId>();
        const options: PmService.PmDispatchBatchOptions = {
          launchWorker: (request) =>
            Effect.sync(() => {
              launchIds.push(request.commandId);
              const workerThreadId =
                launches.get(request.commandId) ??
                ThreadId.make(`save-worker-${launches.size + 1}`);
              launches.set(request.commandId, workerThreadId);
              return { workerThreadId };
            }),
        };
        yield* sql`CREATE TRIGGER fail_pm_counter BEFORE UPDATE OF delegated_turn_count ON pm_thread_configs
        WHEN NEW.thread_id = 'pm-save-retry' BEGIN SELECT RAISE(ABORT, 'write failure'); END`;
        const failure = yield* service.dispatchBatch(batch, options).pipe(Effect.flip);
        expect(failure._tag).toBe("PmStoreError");
        expect((yield* service.getBoardSnapshot(savePm)).workers).toEqual([]);
        expect((yield* service.getBoardSnapshot(savePm)).delegatedTurnCount).toBe(0);
        expect(
          yield* (yield* PmStore.PmStore).getConfig(ThreadId.make("save-worker-1")),
        ).toBeNull();
        yield* sql`DROP TRIGGER fail_pm_counter`;

        const result = yield* service.dispatchBatch(batch, options);
        expect(result.dispatched[0]?.threadId).toBe("save-worker-1");
        expect(launchIds).toHaveLength(2);
        expect(launchIds[0]).toBe(launchIds[1]);
        expect(launches.size).toBe(1);
        expect((yield* service.getBoardSnapshot(savePm)).delegatedTurnCount).toBe(1);
      }),
  );

  it.effect(
    "injects turn context only for PM threads, dispatches workers within limits, aggregates questions, and stops workers",
    () =>
      Effect.gen(function* () {
        yield* migrate107;
        yield* migrate112;
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
        yield* service.setThreadRole({
          threadId: otherPmThreadId,
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

        // An accepted item with no launcher configured fails instead of reporting a fake worker.
        const unconfiguredLaunch = yield* service
          .dispatchBatch({
            pmThreadId: otherPmThreadId,
            items: [{ clientKey: "x", title: "Unlaunched", targetRepoRole: "frontend", brief }],
          })
          .pipe(Effect.flip);
        expect(unconfiguredLaunch).toBeInstanceOf(PmDispatchError);
        expect(String(unconfiguredLaunch.cause)).toContain("launcher is not configured");
        expect((yield* service.getBoardSnapshot(otherPmThreadId)).workers).toEqual([]);

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
        expect(snapshot.role).toBe("pm");
        expect((yield* service.getBoardSnapshot(ThreadId.make("thread-unconfigured"))).role).toBe(
          "standard",
        );
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

        // With no stopper configured, nothing is marked stopped.
        const unconfiguredStop = yield* service
          .stopAllWorkers({ pmThreadId, activateKillSwitch: false })
          .pipe(Effect.flip);
        expect(unconfiguredStop).toBeInstanceOf(PmDispatchError);
        expect(String(unconfiguredStop.cause)).toContain("stopper is not configured");
        expect(
          (yield* service.getBoardSnapshot(pmThreadId)).workers.map((worker) => worker.status),
        ).toEqual(["waiting_approval", "running"]);

        // One unreachable worker still lets the others stop, and only they are marked cancelled.
        const attempted: Array<ThreadId> = [];
        const partial = yield* service
          .stopAllWorkers(
            { pmThreadId, activateKillSwitch: false, reason: "Emergency stop" },
            {
              stopWorker: ({ workerThreadId }) =>
                Effect.suspend(() => {
                  attempted.push(workerThreadId);
                  return workerThreadId === "worker-fe"
                    ? Effect.fail(new PmDispatchError({ cause: "unreachable" }))
                    : Effect.void;
                }),
            },
          )
          .pipe(Effect.flip);
        expect(String(partial.cause)).toContain("worker-fe");
        expect(attempted).toEqual(["worker-fe", "worker-be"]);
        expect(
          (yield* service.getBoardSnapshot(pmThreadId)).workers.map((worker) => worker.status),
        ).toEqual(["waiting_approval", "cancelled"]);

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
        expect(stopped.stoppedWorkerThreadIds).toEqual(["worker-fe"]);
        expect(stoppedIds).toEqual(["worker-fe"]);
        expect(
          (yield* service.getBoardSnapshot(pmThreadId)).workers.map((worker) => worker.status),
        ).toEqual(["cancelled", "cancelled"]);

        const afterStop = yield* service.dispatchBatch({
          pmThreadId,
          items: [{ clientKey: "blocked", title: "Blocked", targetRepoRole: "frontend", brief }],
        });
        expect(afterStop.dispatched).toEqual([]);
        expect(afterStop.rejected[0]?.reason).toBe("kill_switch_active");
      }),
  );
});
