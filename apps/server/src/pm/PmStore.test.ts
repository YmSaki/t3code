import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  type WorkerContextBrief,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import migrate107 from "../persistence/Migrations/107_PmOrchestration.ts";
import migrate112 from "../persistence/Migrations/112_PmDispatchIdempotency.ts";
import * as PmStore from "./PmStore.ts";

const sqliteLayer = NodeSqliteClient.layer({ filename: ":memory:" });
const testLayer = PmStore.layer.pipe(Layer.provideMerge(sqliteLayer));

const pmThreadId = ThreadId.make("pm-thread-1");
const workerThreadId = ThreadId.make("worker-thread-1");
const envId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("proj-1");

const brief: WorkerContextBrief = {
  objective: "Implement the PM board table",
  background: "Displays worker status rows.",
  constraints: ["Keep pure helpers in shared"],
  relatedFiles: [{ path: "apps/web/src/pm/Board.tsx" }],
  completionCriteria: ["Table renders status and turns"],
  verificationCommands: ["vp test run apps/web/src/pm/Board.test.tsx"],
};

it.layer(testLayer)("PmStore", (it) => {
  it.effect("persists PM thread configs, kill switches, and worker dispatches", () =>
    Effect.gen(function* () {
      yield* migrate107;
      yield* migrate112;
      const store = yield* PmStore.PmStore;

      expect(yield* store.getConfig(pmThreadId)).toBeNull();

      const saved = yield* store.upsertConfig({
        threadId: pmThreadId,
        metaProjectId: "meta-1",
        role: "pm",
        policy: {
          ...PmStore.DEFAULT_PM_WORKER_POLICY,
          maxConcurrentWorkers: 3,
          directEditSuppressedProviders: [ProviderDriverKind.make("codex")],
        },
      });
      expect(saved.role).toBe("pm");
      expect(saved.policy.maxConcurrentWorkers).toBe(3);
      expect(saved.killSwitchActive).toBe(false);

      yield* TestClock.adjust(Duration.seconds(5));
      const incremented = yield* store.incrementDelegatedTurns(pmThreadId, 2);
      expect(incremented.delegatedTurnCount).toBe(2);

      const toggled = yield* store.setThreadKillSwitch(pmThreadId, true);
      expect(toggled.killSwitchActive).toBe(true);
      expect(yield* store.setGlobalKillSwitch(true)).toBe(true);
      expect(yield* store.getGlobalKillSwitch).toBe(true);

      const worker = yield* store.putWorkerDispatch({
        workerThreadId,
        pmThreadId,
        clientKey: "w1",
        environmentId: envId,
        projectId,
        title: "Board table",
        targetRepoRole: "frontend",
        useWorktree: true,
        status: "running",
        turnCount: 1,
        brief,
      });
      expect(worker.status).toBe("running");
      expect(worker.pendingQuestions).toEqual([]);

      const waiting = yield* store.updateWorkerProgress({
        workerThreadId,
        status: "waiting_input",
        turnCount: 2,
        summary: "Need confirmation on column order",
        pendingQuestions: ["Should completed workers sort last?"],
      });
      expect(waiting?.status).toBe("waiting_input");
      expect(waiting?.pendingQuestions).toEqual(["Should completed workers sort last?"]);

      const afterCancel = yield* store.cancelActiveWorkers(pmThreadId);
      expect(afterCancel).toHaveLength(1);
      expect(afterCancel[0]?.status).toBe("cancelled");
      expect(afterCancel[0]?.pendingQuestions).toEqual([]);
    }),
  );
});
