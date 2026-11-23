import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import Migration110Worklog from "./110_Worklog.ts";

describe("110_Worklog migration", () => {
  it.effect(
    "creates agent_worklog_entries and ical_feeds tables with indexes and unique constraints",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Migration110Worklog;
        // Running a second time must be idempotent (IF NOT EXISTS).
        yield* Migration110Worklog;

        const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('agent_worklog_entries', 'ical_feeds')
        ORDER BY name
      `;
        assert.deepStrictEqual(
          tables.map((t) => t.name),
          ["agent_worklog_entries", "ical_feeds"],
        );

        const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN ('agent_worklog_entries', 'ical_feeds')
          AND sql IS NOT NULL
        ORDER BY name
      `;
        const indexNames = indexes.map((i) => i.name);
        assert.include(indexNames, "idx_agent_worklog_entries_started_ended");
        assert.include(indexNames, "idx_agent_worklog_entries_provider_started");
        assert.include(indexNames, "idx_agent_worklog_entries_project_started");
        assert.include(indexNames, "idx_ical_feeds_token_hash");

        // Verify source_key unique constraint on agent_worklog_entries
        yield* sql`
        INSERT INTO agent_worklog_entries (
          id, source, source_key, environment_id, provider, agent_key,
          thread_title, thread_role, status, started_at, ended_at,
          duration_ms, cost_usd, input_tokens, output_tokens, created_at, updated_at
        ) VALUES (
          'wl-1', 't3_run', 't3_run:run-1', 'env-1', 'codex', 'cx',
          'Task 1', 'worker', 'completed', '2026-11-22T01:00:00.000Z', '2026-11-22T01:10:00.000Z',
          600000, 0.1, 1000, 500, '2026-11-22T01:10:00.000Z', '2026-11-22T01:10:00.000Z'
        )
      `;

        const duplicateSourceKeyExit = yield* Effect.exit(sql`
        INSERT INTO agent_worklog_entries (
          id, source, source_key, environment_id, provider, agent_key,
          thread_title, thread_role, status, started_at, ended_at,
          duration_ms, cost_usd, input_tokens, output_tokens, created_at, updated_at
        ) VALUES (
          'wl-2', 't3_run', 't3_run:run-1', 'env-1', 'codex', 'cx',
          'Task 2', 'worker', 'completed', '2026-11-22T01:00:00.000Z', '2026-11-22T01:10:00.000Z',
          600000, 0.1, 1000, 500, '2026-11-22T01:10:00.000Z', '2026-11-22T01:10:00.000Z'
        )
      `);
        assert.isTrue(Exit.isFailure(duplicateSourceKeyExit));

        // Verify token_hash unique constraint on ical_feeds
        yield* sql`
        INSERT INTO ical_feeds (
          id, name, token_hash, filter_json, revoked_at, created_at, updated_at
        ) VALUES (
          'feed-1', 'Main Feed', 'hash-abc', '{}', NULL,
          '2026-11-22T01:00:00.000Z', '2026-11-22T01:00:00.000Z'
        )
      `;
        const duplicateTokenHashExit = yield* Effect.exit(sql`
        INSERT INTO ical_feeds (
          id, name, token_hash, filter_json, revoked_at, created_at, updated_at
        ) VALUES (
          'feed-2', 'Other Feed', 'hash-abc', '{}', NULL,
          '2026-11-22T01:00:00.000Z', '2026-11-22T01:00:00.000Z'
        )
      `);
        assert.isTrue(Exit.isFailure(duplicateTokenHashExit));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
