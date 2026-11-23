import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  WorklogEntryId,
  type AgentWorklogEntry,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import Migration110Worklog from "../persistence/Migrations/110_Worklog.ts";
import * as WorklogRuntimeWiring from "./WorklogRuntimeWiring.ts";
import { WorklogService, layer as worklogServiceLayer } from "./WorklogService.ts";
import { layer as worklogStoreLayer, WorklogStore } from "./WorklogStore.ts";

const sqliteLayer = NodeSqliteClient.layer({ filename: ":memory:" });

function runUpdated(runId: string, completedAt: string | null): OrchestrationV2DomainEvent {
  const instanceId = ProviderInstanceId.make("codex");
  const requestedAt = DateTime.makeUnsafe("2026-11-22T08:00:00.000Z");
  return {
    id: EventId.make(`event-${runId}-${completedAt ?? "running"}`),
    type: "run.updated",
    threadId: ThreadId.make("thread-live"),
    occurredAt: requestedAt,
    payload: {
      id: RunId.make(runId),
      threadId: ThreadId.make("thread-live"),
      ordinal: PositiveInt.make(1),
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5-codex" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message-${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: completedAt === null ? "running" : "completed",
      requestedAt,
      startedAt: requestedAt,
      completedAt: completedAt === null ? null : DateTime.makeUnsafe(completedAt),
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function peerEntry(id: string, startedAt: string, endedAt: string): AgentWorklogEntry {
  return {
    id: WorklogEntryId.make(id),
    source: "t3_run",
    environmentId: EnvironmentId.make("env-local"),
    projectId: ProjectId.make("proj-remote"),
    threadId: ThreadId.make(`thread-${id}`),
    runId: RunId.make(`run-${id}`),
    threadRole: "standard",
    provider: ProviderDriverKind.make("claudeAgent"),
    title: TrimmedNonEmptyString.make("Remote run"),
    status: "completed",
    startedAt,
    endedAt,
    durationMs: NonNegativeInt.make(3_600_000),
    turnCount: PositiveInt.make(1),
    stats: {
      changedFilesCount: NonNegativeInt.make(0),
      commandsCount: NonNegativeInt.make(0),
      inputTokens: NonNegativeInt.make(0),
      outputTokens: NonNegativeInt.make(0),
      cachedTokens: NonNegativeInt.make(0),
      estimatedCostUsd: 0,
    },
  };
}

describe("WorklogRuntimeWiring", () => {
  it.effect("records runs from live completion events, matching backfill's entry", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* Migration110Worklog;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          'thread-live', 'proj-1', 'Live worklog thread', 'codex', 'agent', 'interactive',
          NULL, '2026-11-22T08:00:00.000Z', '2026-11-22T08:30:00.000Z', NULL, NULL, '{}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES
          ('run-done', 'thread-live', 1, 'codex', NULL, 'completed',
           '2026-11-22T08:00:00.000Z', '2026-11-22T08:20:00.000Z', '{}'),
          ('run-busy', 'thread-live', 2, 'codex', NULL, 'running',
           '2026-11-22T08:21:00.000Z', NULL, '{}')
      `;

      yield* WorklogRuntimeWiring.runWorklogEventSubscription({ environmentId: "env-hub" }).pipe(
        Effect.provide(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromIterable([
              runUpdated("run-busy", null),
              runUpdated("run-done", "2026-11-22T08:20:00.000Z"),
              runUpdated("run-done", "2026-11-22T08:20:00.000Z"),
            ]),
          }),
        ),
      );

      const store = yield* WorklogStore;
      const live = yield* store.queryEntries();
      assert.deepStrictEqual(
        live.map((entry) => `${entry.runId}|${entry.environmentId}|${entry.durationMs}`),
        [`run-done|env-hub|${20 * 60_000}`],
      );

      const service = yield* WorklogService;
      // A client backfill may name this environment differently; it must update, not collide.
      yield* service.backfillFromOrchestrationV2({ environmentId: "env-real" });
      const afterBackfill = yield* store.queryEntries();
      assert.deepStrictEqual(afterBackfill.map((entry) => String(entry.runId)).toSorted(), [
        "run-busy",
        "run-done",
      ]);
    }).pipe(
      Effect.provide(
        worklogServiceLayer.pipe(
          Layer.provideMerge(worklogStoreLayer),
          Layer.provideMerge(sqliteLayer),
        ),
      ),
    ),
  );

  it.effect("merges linked environments' entries, skipping a peer that does not answer", () => {
    const calls: Array<{ readonly environmentId: string; readonly arguments: unknown }> = [];
    const call: PeerMcpClient.PeerMcpClient["Service"]["call"] = (input) => {
      calls.push({ environmentId: input.environmentId, arguments: input.arguments });
      assert.strictEqual(input.tool, WorklogRuntimeWiring.WORKLOG_PEER_TOOL);
      return input.environmentId === "env-mac"
        ? Effect.succeed({
            entries: [peerEntry("mac-1", "2026-11-22T09:00:00.000Z", "2026-11-22T10:00:00.000Z")],
          })
        : Effect.die("peer unreachable");
    };
    return Effect.gen(function* () {
      yield* Migration110Worklog;
      const service = yield* WorklogService;

      const queried = yield* service.queryWorklog({
        filter: {
          since: "2026-11-22T00:00:00.000Z",
          environmentIds: [EnvironmentId.make("env-mac"), EnvironmentId.make("env-down")],
        },
      });

      assert.deepStrictEqual(
        queried.entries.map((entry) => [entry.id, entry.environmentId]),
        [["mac-1", "env-mac"]],
      );
      assert.deepStrictEqual(calls.map((c) => c.environmentId).toSorted(), ["env-down", "env-mac"]);
      assert.deepStrictEqual(calls[0]?.arguments, {
        filter: { since: "2026-11-22T00:00:00.000Z", environmentIds: undefined },
      });
    }).pipe(
      Effect.provide(
        WorklogRuntimeWiring.layerWithPeers().pipe(
          Layer.provideMerge(worklogStoreLayer),
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(PeerLinks.PeerLinks)({
                enabled: Effect.succeed(true),
                names: Effect.succeed([
                  { environmentId: EnvironmentId.make("env-mac"), label: "Mac" },
                  { environmentId: EnvironmentId.make("env-down"), label: "Down" },
                  { environmentId: EnvironmentId.make("env-filtered"), label: "Filtered out" },
                ]),
              }),
              Layer.mock(PeerMcpClient.PeerMcpClient)({ call }),
            ),
          ),
          Layer.provideMerge(sqliteLayer),
        ),
      ),
    );
  });
});
