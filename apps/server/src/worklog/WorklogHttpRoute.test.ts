import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest } from "effect/http";

import Migration110Worklog from "../persistence/Migrations/110_Worklog.ts";
import { WorklogStore, layer as worklogStoreLayer } from "./WorklogStore.ts";
import { WorklogService, layer as worklogServiceLayer } from "./WorklogService.ts";
import * as WorklogHttpRoute from "./WorklogHttpRoute.ts";

const testLayer = worklogServiceLayer.pipe(
  Layer.provideMerge(worklogStoreLayer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const fullRouteLayer = WorklogHttpRoute.layer.pipe(
  Layer.provideMerge(worklogServiceLayer),
  Layer.provideMerge(worklogStoreLayer),
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

describe("WorklogHttpRoute", () => {
  it.effect(
    "serves 200 text/calendar with .ics suffix, 304 on matching If-None-Match, and 404 on invalid/revoked/deleted token",
    () =>
      Effect.gen(function* () {
        yield* Migration110Worklog;
        const service = yield* WorklogService;
        const store = yield* WorklogStore;

        yield* service.ingestExternalSessions([
          {
            sessionId: "http-ical-1",
            provider: "codex",
            title: "Verify iCal HTTP endpoint",
            startedAt: "2026-11-22T09:00:00.000Z",
            endedAt: "2026-11-22T10:00:00.000Z",
            turnCount: 3,
          },
        ]);

        const created = yield* service.createIcalFeed({
          name: "HTTP Test Calendar",
          rawToken: "valid-ical-token",
          timeZone: "Asia/Tokyo",
        });

        const sendRequest = (url: string, headers?: Record<string, string>) => {
          const req = HttpServerRequest.fromWeb(
            new Request(url, {
              method: "GET",
              ...(headers !== undefined ? { headers } : {}),
            }),
          );
          return WorklogHttpRoute.handleWorklogIcalRequest.pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
          );
        };

        // 1. 200 OK with .ics suffix
        const res200 = yield* sendRequest("http://localhost/api/worklog/ical/valid-ical-token.ics");
        assert.strictEqual(res200.status, 200);
        assert.strictEqual(res200.headers["content-type"], "text/calendar; charset=utf-8");
        const etag = res200.headers["etag"];
        assert.isDefined(etag);

        // 2. 304 Not Modified when If-None-Match matches ETag
        const res304 = yield* sendRequest(
          "http://localhost/api/worklog/ical/valid-ical-token.ics",
          {
            "if-none-match": etag!,
          },
        );
        assert.strictEqual(res304.status, 304);
        assert.strictEqual(res304.headers["etag"], etag);

        // 3. 404 Not Found for unknown token
        const res404Invalid = yield* sendRequest(
          "http://localhost/api/worklog/ical/unknown-token.ics",
        );
        assert.strictEqual(res404Invalid.status, 404);

        // 4. 404 Not Found after token is revoked
        yield* store.revokeFeed(created.feed.id);
        const res404Revoked = yield* sendRequest(
          "http://localhost/api/worklog/ical/valid-ical-token.ics",
        );
        assert.strictEqual(res404Revoked.status, 404);

        // 5. Rotate token -> new token returns 200, then delete -> returns 404
        yield* service.rotateIcalFeedToken(created.feed.id, "fresh-ical-token");
        const res200Rotated = yield* sendRequest(
          "http://localhost/api/worklog/ical/fresh-ical-token",
        );
        assert.strictEqual(res200Rotated.status, 200);

        yield* service.deleteIcalFeed(created.feed.id);
        const res404Deleted = yield* sendRequest(
          "http://localhost/api/worklog/ical/fresh-ical-token",
        );
        assert.strictEqual(res404Deleted.status, 404);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("serves 200, 304, and 404 end-to-end through HttpRouter.toWebHandler", () =>
    Effect.gen(function* () {
      const routeWithMigratedDb = Layer.effectDiscard(
        Effect.gen(function* () {
          yield* Migration110Worklog;
          const service = yield* WorklogService;
          yield* service.createIcalFeed({
            name: "WebHandler Feed",
            rawToken: "router-token-xyz",
            timeZone: "UTC",
          });
        }),
      ).pipe(Layer.provideMerge(fullRouteLayer));

      const { handler, dispose } = HttpRouter.toWebHandler(routeWithMigratedDb);
      try {
        const res200 = yield* Effect.promise(() =>
          handler(new Request("http://localhost/api/worklog/ical/router-token-xyz.ics")),
        );
        assert.strictEqual(res200.status, 200);
        assert.strictEqual(res200.headers.get("content-type"), "text/calendar; charset=utf-8");
        const etag = res200.headers.get("etag");
        assert.isNotNull(etag);
        const body = yield* Effect.promise(() => res200.text());
        assert.include(body, "BEGIN:VCALENDAR\r\n");

        const res304 = yield* Effect.promise(() =>
          handler(
            new Request("http://localhost/api/worklog/ical/router-token-xyz.ics", {
              headers: { "If-None-Match": etag! },
            }),
          ),
        );
        assert.strictEqual(res304.status, 304);

        const res404 = yield* Effect.promise(() =>
          handler(new Request("http://localhost/api/worklog/ical/nonexistent.ics")),
        );
        assert.strictEqual(res404.status, 404);
      } finally {
        yield* Effect.promise(() => dispose());
      }
    }),
  );
});
