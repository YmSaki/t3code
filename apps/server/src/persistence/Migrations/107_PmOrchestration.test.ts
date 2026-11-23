import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import migrate107 from "./107_PmOrchestration.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("107_PmOrchestration", (it) => {
  it.effect("creates pm_thread_configs and pm_worker_dispatches idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate107;
      yield* migrate107;

      const objects = yield* sql<{ readonly name: string; readonly type: string }>`
        SELECT name, type FROM sqlite_master
        WHERE name LIKE 'pm_%' OR name LIKE 'idx_pm_%'
        ORDER BY name
      `;
      expect(objects).toEqual([
        { name: "idx_pm_thread_configs_meta_project_id", type: "index" },
        { name: "idx_pm_thread_configs_role", type: "index" },
        { name: "idx_pm_worker_dispatches_pm_thread_id", type: "index" },
        { name: "idx_pm_worker_dispatches_status", type: "index" },
        { name: "pm_thread_configs", type: "table" },
        { name: "pm_worker_dispatches", type: "table" },
      ]);
    }),
  );
});
