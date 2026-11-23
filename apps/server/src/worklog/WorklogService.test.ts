import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  WorklogEntryId,
  NonNegativeInt,
  PositiveInt,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import Migration110Worklog from "../persistence/Migrations/110_Worklog.ts";
import { WorklogService, layer as worklogServiceLayer } from "./WorklogService.ts";
import { layer as worklogStoreLayer } from "./WorklogStore.ts";

const testLayer = worklogServiceLayer.pipe(
  Layer.provideMerge(worklogStoreLayer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("WorklogService", () => {
  it.effect("backfills idempotently from orchestration_v2_projection_runs and threads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* Migration110Worklog;

      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          'thread-100', 'proj-1', 'Implement Worklog Service', 'codex', 'agent', 'interactive',
          'pt-1', '2026-11-22T08:00:00.000Z', '2026-11-22T08:45:00.000Z', NULL, NULL,
          '{"threadRole":"pm","projectTitle":"T3 Code","model":"gpt-6-astra"}'
        )
      `;

      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          'run-100', 'thread-100', 1, 'codex', 'pt-1', 'completed',
          '2026-11-22T08:00:00.000Z', '2026-11-22T08:30:00.000Z',
          '{"turnCount":3,"summary":"Backfill verified","stats":{"changedFilesCount":4,"commandsCount":6,"inputTokens":9000,"outputTokens":2100,"cachedTokens":4000,"estimatedCostUsd":0.35}}'
        )
      `;

      const service = yield* WorklogService;
      const firstBackfill = yield* service.backfillFromOrchestrationV2({
        environmentId: "env-hub",
      });
      assert.strictEqual(firstBackfill.backfilledCount, 1);
      assert.strictEqual(firstBackfill.entries[0]?.title, "Implement Worklog Service");
      assert.strictEqual(firstBackfill.entries[0]?.threadRole, "pm");
      assert.strictEqual(firstBackfill.entries[0]?.durationMs, 30 * 60_000);
      assert.strictEqual(firstBackfill.entries[0]?.stats.changedFilesCount, 4);

      // Second backfill must be idempotent (still 1 row total)
      const secondBackfill = yield* service.backfillFromOrchestrationV2({
        environmentId: "env-hub",
      });
      assert.strictEqual(secondBackfill.backfilledCount, 1);

      const queried = yield* service.queryWorklog();
      assert.strictEqual(queried.entries.length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "ingests external CLI sessions idempotently while skipping overlaps with T3 runs, and merges peer entries",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* Migration110Worklog;

        yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          'thread-200', 'proj-1', 'T3 Codex Run', 'codex', 'agent', 'interactive',
          'pt-2', '2026-11-22T10:00:00.000Z', '2026-11-22T10:30:00.000Z', NULL, NULL, '{}'
        )
      `;
        yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          'run-200', 'thread-200', 1, 'codex', 'pt-2', 'completed',
          '2026-11-22T10:00:00.000Z', '2026-11-22T10:30:00.000Z',
          '{"turnCount":2,"stats":{"estimatedCostUsd":0.2}}'
        )
      `;

        const service = yield* WorklogService;
        yield* service.backfillFromOrchestrationV2({ environmentId: "env-local" });

        const ingestResult = yield* service.ingestExternalSessions([
          {
            // Overlaps with run-200 on codex in env-local -> should be skipped!
            sessionId: "codex-cli-dup",
            provider: "codex",
            environmentId: "env-local",
            title: "Duplicate CLI transcript of run-200",
            startedAt: "2026-11-22T10:02:00.000Z",
            endedAt: "2026-11-22T10:28:00.000Z",
          },
          {
            // Non-overlapping standalone Claude CLI session -> should be ingested!
            sessionId: "claude-cli-standalone",
            provider: "claudeAgent",
            environmentId: "env-local",
            projectTitle: "External Repo",
            title: "Standalone Claude CLI Session",
            startedAt: "2026-11-22T11:00:00.000Z",
            endedAt: "2026-11-22T12:00:00.000Z",
            turnCount: 5,
            stats: {
              changedFilesCount: 3,
              commandsCount: 4,
              inputTokens: 8000,
              outputTokens: 2000,
              cachedTokens: 3000,
              estimatedCostUsd: 0.4,
            },
          },
        ]);

        assert.strictEqual(ingestResult.ingestedCount, 1);
        assert.strictEqual(ingestResult.skippedOverlappingCount, 1);

        // Re-ingesting the same standalone session is idempotent
        const reIngest = yield* service.ingestExternalSessions([
          {
            sessionId: "claude-cli-standalone",
            provider: "claudeAgent",
            environmentId: "env-local",
            projectTitle: "External Repo",
            title: "Standalone Claude CLI Session",
            startedAt: "2026-11-22T11:00:00.000Z",
            endedAt: "2026-11-22T12:00:00.000Z",
            turnCount: 5,
          },
        ]);
        assert.strictEqual(reIngest.ingestedCount, 1);

        // Query with peer fetcher injecting a remote PC's worklog entry
        const queried = yield* service.queryWorklog({
          timeZone: "UTC",
          peerFetcher: () =>
            Effect.succeed([
              {
                id: WorklogEntryId.make("wl-peer-1"),
                source: "t3_run",
                environmentId: EnvironmentId.make("env-remote-mac"),
                projectId: ProjectId.make("proj-remote"),
                projectTitle: TrimmedNonEmptyString.make("Remote Mac Project"),
                threadId: ThreadId.make("thread-remote-1"),
                runId: RunId.make("run-remote-1"),
                threadRole: "worker",
                provider: ProviderDriverKind.make("cursor"),
                title: TrimmedNonEmptyString.make("Remote Cursor Run"),
                status: "completed",
                startedAt: "2026-11-22T10:15:00.000Z",
                endedAt: "2026-11-22T11:15:00.000Z",
                durationMs: NonNegativeInt.make(3_600_000),
                turnCount: PositiveInt.make(3),
                stats: {
                  changedFilesCount: NonNegativeInt.make(2),
                  commandsCount: NonNegativeInt.make(3),
                  inputTokens: NonNegativeInt.make(4000),
                  outputTokens: NonNegativeInt.make(1000),
                  cachedTokens: NonNegativeInt.make(1000),
                  estimatedCostUsd: 0.15,
                },
              },
            ]),
        });

        assert.strictEqual(queried.entries.length, 3);
        const stats = yield* service.getStats({
          timeZone: "UTC",
          peerEntries: queried.entries.filter((e) => e.environmentId === "env-remote-mac"),
        });
        assert.strictEqual(stats.totalEntriesCount, 3);
        assert.strictEqual(stats.maxConcurrency, 2);
        assert.strictEqual(stats.byProvider.length, 3);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("manages iCal feeds and renders deterministic RFC 5545 output and ETag by token", () =>
    Effect.gen(function* () {
      yield* Migration110Worklog;
      const service = yield* WorklogService;

      yield* service.ingestExternalSessions([
        {
          sessionId: "s-ical-1",
          provider: "codex",
          title: "Prepare release notes",
          startedAt: "2026-11-22T09:00:00.000Z",
          endedAt: "2026-11-22T09:30:00.000Z",
          turnCount: 2,
        },
      ]);

      const created = yield* service.createIcalFeed({
        name: "Team Worklog",
        rawToken: "feed-token-123",
        timeZone: "Asia/Tokyo",
      });

      const rendered1 = yield* service.renderIcalFeedByToken("feed-token-123.ics");
      const rendered2 = yield* service.renderIcalFeedByToken("feed-token-123");
      assert.strictEqual(rendered1.etag, rendered2.etag);
      assert.include(rendered1.icsText, "SUMMARY:[cx] Prepare release notes\r\n");

      // Rotate token invalidates old token
      const rotated = yield* service.rotateIcalFeedToken(created.feed.id, "feed-token-456");
      assert.strictEqual(rotated.rawToken, "feed-token-456");

      const oldTokenExit = yield* Effect.exit(service.renderIcalFeedByToken("feed-token-123"));
      assert.isTrue(Exit.isFailure(oldTokenExit));

      const newTokenRendered = yield* service.renderIcalFeedByToken("feed-token-456.ics");
      assert.include(newTokenRendered.icsText, "BEGIN:VCALENDAR\r\n");

      // Delete feed invalidates new token
      yield* service.deleteIcalFeed(created.feed.id);
      const deletedExit = yield* Effect.exit(service.renderIcalFeedByToken("feed-token-456"));
      assert.isTrue(Exit.isFailure(deletedExit));
    }).pipe(Effect.provide(testLayer)),
  );
});
