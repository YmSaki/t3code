import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0106 from "./106_MetaProjects.ts";

it.effect(
  "creates meta_projects, meta_project_members, and meta_project_threads tables idempotently",
  () =>
    Effect.gen(function* () {
      yield* Migration0106;
      yield* Migration0106;

      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('meta_projects', 'meta_project_members', 'meta_project_threads')
      ORDER BY name ASC
    `;

      expect(tables.map((row) => row.name)).toEqual([
        "meta_project_members",
        "meta_project_threads",
        "meta_projects",
      ]);

      const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_meta_project%'
      ORDER BY name ASC
    `;

      expect(indexes.map((row) => row.name)).toEqual([
        "idx_meta_project_members_meta_sort",
        "idx_meta_project_members_project",
        "idx_meta_project_threads_meta",
        "idx_meta_project_threads_thread",
        "idx_meta_projects_active_updated",
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
