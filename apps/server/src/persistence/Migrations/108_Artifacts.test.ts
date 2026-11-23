import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import migration108 from "./108_Artifacts.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })));

layer("108_Artifacts", (it) => {
  it.effect("creates artifacts, artifact_versions, and artifact_actions tables idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* migration108;
      yield* migration108;

      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('artifacts', 'artifact_versions', 'artifact_actions')
        ORDER BY name ASC
      `;
      expect(tables.map((row) => row.name)).toEqual([
        "artifact_actions",
        "artifact_versions",
        "artifacts",
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'idx_artifact%'
        ORDER BY name ASC
      `;
      expect(indexes.map((row) => row.name)).toEqual([
        "idx_artifact_actions_artifact_id",
        "idx_artifact_actions_thread_id",
        "idx_artifact_versions_artifact_id",
        "idx_artifacts_project_id",
        "idx_artifacts_thread_id",
      ]);
    }),
  );
});
