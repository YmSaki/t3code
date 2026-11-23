import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderDriverKind, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import Migration110Worklog from "../persistence/Migrations/110_Worklog.ts";
import { hashIcalFeedToken, WorklogStore, layer as worklogStoreLayer } from "./WorklogStore.ts";

const testLayer = worklogStoreLayer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("WorklogStore", () => {
  it.effect(
    "idempotently upserts entries by source_key and queries by date range and filters",
    () =>
      Effect.gen(function* () {
        yield* Migration110Worklog;
        const store = yield* WorklogStore;

        const envId = EnvironmentId.make("env-local");
        const projId = ProjectId.make("proj-1");
        const threadId = ThreadId.make("thread-1");
        const runId = RunId.make("run-1");
        const codex = ProviderDriverKind.make("codex");
        const claude = ProviderDriverKind.make("claudeAgent");

        const first = yield* store.upsertEntry({
          id: "wl-run-1",
          sourceKey: "t3_run:env-local:run-1",
          source: "t3_run",
          environmentId: envId,
          provider: codex,
          projectId: projId,
          projectTitle: "T3 Code",
          threadId,
          runId,
          title: "Initial run title",
          threadRole: "worker",
          status: "running",
          startedAt: "2026-11-22T01:00:00.000Z",
          endedAt: "2026-11-22T01:15:00.000Z",
          turnCount: 1,
          stats: {
            changedFilesCount: 1,
            commandsCount: 2,
            inputTokens: 1000,
            outputTokens: 200,
            cachedTokens: 500,
            estimatedCostUsd: 0.05,
          },
        });

        assert.strictEqual(first.id, "wl-run-1");
        assert.strictEqual(first.status, "running");
        assert.strictEqual(first.durationMs, 15 * 60_000);

        // Upsert again with same sourceKey: updates existing row without duplicating
        const updated = yield* store.upsertEntry({
          id: "wl-run-1-ignored-new-id",
          sourceKey: "t3_run:env-local:run-1",
          source: "t3_run",
          environmentId: envId,
          provider: codex,
          projectId: projId,
          projectTitle: "T3 Code",
          threadId,
          runId,
          title: "Completed run title",
          threadRole: "worker",
          summary: "Finished all tasks",
          status: "completed",
          startedAt: "2026-11-22T01:00:00.000Z",
          endedAt: "2026-11-22T01:30:00.000Z",
          turnCount: 3,
          stats: {
            changedFilesCount: 4,
            commandsCount: 8,
            inputTokens: 5000,
            outputTokens: 1200,
            cachedTokens: 2000,
            estimatedCostUsd: 0.25,
          },
        });

        assert.strictEqual(updated.id, "wl-run-1");
        assert.strictEqual(updated.status, "completed");
        assert.strictEqual(updated.title, "Completed run title");
        assert.strictEqual(updated.turnCount, 3);
        assert.strictEqual(updated.durationMs, 30 * 60_000);

        yield* store.upsertEntry({
          id: "wl-cli-1",
          sourceKey: "imported_cli:claudeAgent:session-99",
          source: "imported_cli",
          environmentId: envId,
          provider: claude,
          projectId: null,
          threadId: null,
          runId: null,
          title: "External Claude CLI session",
          threadRole: "standard",
          status: "completed",
          startedAt: "2026-11-22T04:00:00.000Z",
          endedAt: "2026-11-22T04:20:00.000Z",
          turnCount: 2,
          stats: {
            changedFilesCount: 2,
            commandsCount: 3,
            inputTokens: 3000,
            outputTokens: 800,
            cachedTokens: 1000,
            estimatedCostUsd: 0.12,
          },
        });

        const all = yield* store.queryEntries();
        assert.strictEqual(all.length, 2);

        const codexOnly = yield* store.queryEntries({ providers: [codex] });
        assert.strictEqual(codexOnly.length, 1);
        assert.strictEqual(codexOnly[0]?.id, "wl-run-1");

        const morningRange = yield* store.queryEntries({
          since: "2026-11-22T00:00:00.000Z",
          until: "2026-11-22T02:00:00.000Z",
        });
        assert.strictEqual(morningRange.length, 1);
        assert.strictEqual(morningRange[0]?.id, "wl-run-1");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "stores only SHA-256 token_hash for iCal feeds and supports token verification, rotation, revocation, and deletion",
    () =>
      Effect.gen(function* () {
        yield* Migration110Worklog;
        const sql = yield* SqlClient.SqlClient;
        const store = yield* WorklogStore;

        const created = yield* store.createFeed({
          id: "feed-main",
          name: "My Worklog Feed",
          rawToken: "super-secret-raw-token",
          timeZone: "Asia/Tokyo",
          gapToleranceMinutes: 15,
        });

        assert.strictEqual(created.rawToken, "super-secret-raw-token");
        assert.strictEqual(created.config.token, "super-secret-raw-token");

        // Check SQLite directly: raw token must NOT be stored in ical_feeds
        const rawRows = yield* sql<{ readonly token_hash: string }>`
        SELECT token_hash FROM ical_feeds WHERE id = 'feed-main'
      `;
        assert.strictEqual(rawRows.length, 1);
        assert.notStrictEqual(rawRows[0]?.token_hash, "super-secret-raw-token");
        assert.strictEqual(rawRows[0]?.token_hash, hashIcalFeedToken("super-secret-raw-token"));

        // Verify token succeeds for raw token and returns null for wrong token
        const verified = yield* store.verifyFeedToken("super-secret-raw-token");
        assert.strictEqual(verified?.id, "feed-main");
        assert.isNull(yield* store.verifyFeedToken("wrong-token"));

        // Rotate token invalidates old token and activates new token
        const rotated = yield* store.rotateFeedToken(created.feed.id, "rotated-secret-token");
        assert.strictEqual(rotated.rawToken, "rotated-secret-token");
        assert.isNull(yield* store.verifyFeedToken("super-secret-raw-token"));
        assert.strictEqual((yield* store.verifyFeedToken("rotated-secret-token"))?.id, "feed-main");

        // Revoke feed prevents verification
        yield* store.revokeFeed(created.feed.id);
        assert.isNull(yield* store.verifyFeedToken("rotated-secret-token"));
        assert.strictEqual((yield* store.listFeeds()).length, 0);
        assert.strictEqual((yield* store.listFeeds({ includeRevoked: true })).length, 1);

        // Delete feed removes record completely
        yield* store.deleteFeed(created.feed.id);
        assert.isNull(yield* store.getFeedById(created.feed.id));
      }).pipe(Effect.provide(testLayer)),
  );
});
