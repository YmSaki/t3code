import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(pm_worker_dispatches)`;
  if (!columns.some((column) => column.name === "dispatch_command_id")) {
    yield* sql`ALTER TABLE pm_worker_dispatches ADD COLUMN dispatch_command_id TEXT`;
  }
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pm_worker_dispatches_batch
    ON pm_worker_dispatches (pm_thread_id, dispatch_command_id, client_key)
  `;
});
