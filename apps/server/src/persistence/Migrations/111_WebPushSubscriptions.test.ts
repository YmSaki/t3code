import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import migrate111 from "./111_WebPushSubscriptions.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("111_WebPushSubscriptions", (it) => {
  it.effect("creates web_push_subscriptions and web_push_vapid_keys idempotently", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* migrate111;
      yield* migrate111;

      const objects = yield* sql<{ readonly name: string; readonly type: string }>`
        SELECT name, type FROM sqlite_master
        WHERE name LIKE 'web_push_%' OR name LIKE 'idx_web_push_%'
        ORDER BY name
      `;
      expect(objects).toEqual([
        { name: "idx_web_push_subscriptions_enabled", type: "index" },
        { name: "idx_web_push_subscriptions_endpoint", type: "index" },
        { name: "web_push_subscriptions", type: "table" },
        { name: "web_push_vapid_keys", type: "table" },
      ]);
    }),
  );
});
