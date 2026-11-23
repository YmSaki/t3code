import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_worklog_entries (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      environment_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_instance_id TEXT,
      agent_key TEXT NOT NULL,
      model TEXT,
      project_id TEXT,
      project_title TEXT,
      thread_id TEXT,
      run_id TEXT,
      thread_title TEXT NOT NULL,
      thread_role TEXT NOT NULL,
      summary TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 1,
      changed_files_count INTEGER NOT NULL DEFAULT 0,
      commands_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cached_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      thread_url TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_worklog_entries_started_ended
    ON agent_worklog_entries (started_at, ended_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_worklog_entries_provider_started
    ON agent_worklog_entries (provider, started_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_worklog_entries_project_started
    ON agent_worklog_entries (project_id, started_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_agent_worklog_entries_thread_started
    ON agent_worklog_entries (thread_id, started_at)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS ical_feeds (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      time_zone TEXT NOT NULL DEFAULT 'UTC',
      gap_tolerance_minutes INTEGER NOT NULL DEFAULT 5,
      filter_json TEXT NOT NULL DEFAULT '{}',
      include_stats_in_description INTEGER NOT NULL DEFAULT 1,
      include_thread_url INTEGER NOT NULL DEFAULT 1,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_ical_feeds_token_hash
    ON ical_feeds (token_hash)
  `;
});
