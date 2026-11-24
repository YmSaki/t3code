import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import migrate107 from "./107_PmOrchestration.ts";
import migrate112 from "./112_PmDispatchIdempotency.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("112_PmDispatchIdempotency", (it) => {
  it.effect("preserves legacy dispatches and enforces uniqueness within each PM batch", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate107;
      for (const worker of ["worker-1", "worker-2"]) {
        yield* sql`INSERT INTO pm_worker_dispatches (
          worker_thread_id, pm_thread_id, client_key, environment_id, project_id,
          title, status, brief_json, updated_at
        ) VALUES (${worker}, 'pm', 'fe', 'env', 'project', 'Frontend', 'running', '{}', '2026-11-24T00:00:00.000Z')`;
      }
      yield* migrate112;
      yield* migrate112;
      expect(yield* sql`SELECT dispatch_command_id FROM pm_worker_dispatches`).toEqual([
        { dispatch_command_id: null },
        { dispatch_command_id: null },
      ]);
      yield* sql`UPDATE pm_worker_dispatches SET dispatch_command_id = 'batch-1' WHERE worker_thread_id = 'worker-1'`;
      const duplicate =
        yield* sql`UPDATE pm_worker_dispatches SET dispatch_command_id = 'batch-1' WHERE worker_thread_id = 'worker-2'`.pipe(
          Effect.flip,
        );
      expect(duplicate._tag).toBe("SqlError");
      yield* sql`UPDATE pm_worker_dispatches SET dispatch_command_id = 'batch-2' WHERE worker_thread_id = 'worker-2'`;
      expect(
        yield* sql`SELECT worker_thread_id, dispatch_command_id FROM pm_worker_dispatches ORDER BY worker_thread_id`,
      ).toEqual([
        { worker_thread_id: "worker-1", dispatch_command_id: "batch-1" },
        { worker_thread_id: "worker-2", dispatch_command_id: "batch-2" },
      ]);
    }),
  );
});
