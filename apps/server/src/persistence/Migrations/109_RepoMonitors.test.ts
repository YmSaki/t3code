import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0109 from "./109_RepoMonitors.ts";

describe("109_RepoMonitors migration", () => {
  it.effect(
    "creates rules, cursors, and events tables with unique (rule_id, dedupe_key) index",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* Migration0109;

        const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('repo_monitor_rules', 'repo_monitor_cursors', 'repo_monitor_events')
        ORDER BY name
      `;
        assert.deepStrictEqual(
          tables.map((row) => row.name),
          ["repo_monitor_cursors", "repo_monitor_events", "repo_monitor_rules"],
        );

        yield* sql`
        INSERT INTO repo_monitor_events (
          id, rule_id, project_id, event_kind, dedupe_key, summary, is_bot, outcome, occurred_at
        ) VALUES (
          'evt-1', 'rule-1', 'proj-1', 'pr_comment', 'proj-1:rule-1:pr_comment:1:c1', 'Comment', 0, 'triggered', '2026-11-22T10:00:00Z'
        )
      `;

        const duplicateInsert = yield* Effect.exit(sql`
        INSERT INTO repo_monitor_events (
          id, rule_id, project_id, event_kind, dedupe_key, summary, is_bot, outcome, occurred_at
        ) VALUES (
          'evt-2', 'rule-1', 'proj-1', 'pr_comment', 'proj-1:rule-1:pr_comment:1:c1', 'Duplicate', 0, 'triggered', '2026-11-22T10:01:00Z'
        )
      `);
        assert.isTrue(Exit.isFailure(duplicateInsert));
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
