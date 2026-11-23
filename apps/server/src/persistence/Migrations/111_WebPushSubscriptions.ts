import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS web_push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      keys_json TEXT NOT NULL,
      device_label TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_endpoint
    ON web_push_subscriptions (endpoint)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_web_push_subscriptions_enabled
    ON web_push_subscriptions (enabled, updated_at DESC)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS web_push_vapid_keys (
      id TEXT PRIMARY KEY,
      public_key TEXT NOT NULL,
      private_key_pkcs8_pem TEXT NOT NULL,
      subject TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
});
