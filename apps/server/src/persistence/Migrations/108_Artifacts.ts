import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      environment_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      active_version INTEGER NOT NULL DEFAULT 1,
      state_version INTEGER NOT NULL DEFAULT 0,
      state_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_thread_id
    ON artifacts (thread_id, updated_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_artifacts_project_id
    ON artifacts (project_id, updated_at DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      summary TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, version),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact_id
    ON artifact_versions (artifact_id, version DESC)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS artifact_actions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      action_name TEXT NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      prompt_text TEXT,
      state_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_artifact_actions_artifact_id
    ON artifact_actions (artifact_id, created_at DESC)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_artifact_actions_thread_id
    ON artifact_actions (thread_id, created_at DESC)
  `;
});
