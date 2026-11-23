import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS meta_projects (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      instructions_md TEXT NOT NULL DEFAULT '',
      pinned_at TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_meta_projects_active_updated
    ON meta_projects (deleted_at, archived_at, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS meta_project_members (
      meta_project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      role TEXT NOT NULL,
      label TEXT,
      description TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      added_at TEXT NOT NULL,
      PRIMARY KEY (meta_project_id, environment_id, project_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_meta_project_members_meta_sort
    ON meta_project_members (meta_project_id, sort_order ASC, environment_id, project_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_meta_project_members_project
    ON meta_project_members (environment_id, project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS meta_project_threads (
      meta_project_id TEXT NOT NULL,
      environment_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      role TEXT NOT NULL,
      project_id TEXT,
      title TEXT,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (meta_project_id, environment_id, thread_id)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_meta_project_threads_meta
    ON meta_project_threads (meta_project_id, role, linked_at DESC)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_meta_project_threads_thread
    ON meta_project_threads (environment_id, thread_id)
  `;
});
