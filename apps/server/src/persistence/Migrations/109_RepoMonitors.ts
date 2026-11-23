import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_monitor_rules (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      environment_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      event_kinds_json TEXT NOT NULL,
      filter_json TEXT NOT NULL DEFAULT '{}',
      action_kind TEXT NOT NULL,
      target_thread_id TEXT,
      runtime_mode TEXT,
      prompt_template TEXT NOT NULL,
      cooldown_sec INTEGER NOT NULL DEFAULT 60,
      max_triggers_per_hour INTEGER NOT NULL DEFAULT 20,
      preset_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_repo_monitor_rules_project_id
    ON repo_monitor_rules (project_id, enabled)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_monitor_cursors (
      project_id TEXT PRIMARY KEY,
      branch_heads_json TEXT NOT NULL DEFAULT '{}',
      known_pull_request_numbers_json TEXT NOT NULL DEFAULT '[]',
      merged_pull_request_numbers_json TEXT NOT NULL DEFAULT '[]',
      known_pull_request_comment_ids_json TEXT NOT NULL DEFAULT '[]',
      known_issue_keys_json TEXT NOT NULL DEFAULT '[]',
      known_issue_comment_ids_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS repo_monitor_events (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      event_kind TEXT NOT NULL,
      dedupe_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      author_login TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      branch TEXT,
      commit_sha TEXT,
      pull_request_number INTEGER,
      issue_key TEXT,
      comment_id TEXT,
      url TEXT,
      outcome TEXT NOT NULL,
      dispatched_thread_id TEXT,
      rendered_prompt TEXT,
      occurred_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_monitor_events_rule_dedupe
    ON repo_monitor_events (rule_id, dedupe_key)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_repo_monitor_events_project_occurred
    ON repo_monitor_events (project_id, occurred_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_repo_monitor_events_rule_outcome_occurred
    ON repo_monitor_events (rule_id, outcome, occurred_at DESC)
  `;
});
