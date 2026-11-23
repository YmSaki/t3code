import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_thread_configs (
      thread_id TEXT PRIMARY KEY,
      meta_project_id TEXT,
      role TEXT NOT NULL,
      delegation_depth INTEGER NOT NULL DEFAULT 0,
      policy_json TEXT NOT NULL,
      kill_switch_active INTEGER NOT NULL DEFAULT 0,
      delegated_turn_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pm_thread_configs_meta_project_id
    ON pm_thread_configs (meta_project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pm_thread_configs_role
    ON pm_thread_configs (role)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pm_worker_dispatches (
      worker_thread_id TEXT PRIMARY KEY,
      pm_thread_id TEXT NOT NULL,
      client_key TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      role TEXT,
      provider_instance_id TEXT,
      use_worktree INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL,
      turn_count INTEGER NOT NULL DEFAULT 0,
      brief_json TEXT NOT NULL,
      summary TEXT,
      pending_questions_json TEXT NOT NULL DEFAULT '[]',
      started_at TEXT,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pm_worker_dispatches_pm_thread_id
    ON pm_worker_dispatches (pm_thread_id, updated_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_pm_worker_dispatches_status
    ON pm_worker_dispatches (pm_thread_id, status)
  `;
});
