import { expect, it } from "@effect/vitest";
import {
  WebPushError,
  WebPushSubscriptionId,
  type WebPushSubscriptionKeys,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import migrate111 from "../persistence/Migrations/111_WebPushSubscriptions.ts";
import * as WebPushService from "./WebPushService.ts";
import * as WebPushStore from "./WebPushStore.ts";

const sqliteLayer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

sqliteLayer("WebPushService", (it) => {
  it.effect(
    "delivers notifications, enforces quiet hours and debounce, and prunes 410 Gone endpoints",
    () =>
      Effect.gen(function* () {
        yield* migrate111;
        const deliveries: Array<{
          readonly endpoint: string;
          readonly keys: WebPushSubscriptionKeys;
          readonly title: string;
        }> = [];

        const serviceLayer = WebPushService.layerWithOptions({
          vapidSubject: "mailto:hub@example.com",
          transport: ({ subscription, payload }) => {
            if (subscription.id === "sub-0-blocked") {
              return Effect.fail(
                new WebPushError({
                  reason: "delivery_failed",
                  message: "Push endpoint did not resolve to a public address.",
                }),
              );
            }
            if (subscription.endpoint.includes("gone")) {
              return Effect.succeed({ status: "gone", statusCode: 410 });
            }
            deliveries.push({
              endpoint: subscription.endpoint,
              keys: subscription.keys,
              title: payload.title,
            });
            return Effect.succeed({ status: "delivered", statusCode: 201 });
          },
        }).pipe(Layer.provideMerge(WebPushStore.layer));

        const service = yield* WebPushService.WebPushService.pipe(Effect.provide(serviceLayer));

        const vapid = yield* service.getVapidPublicKey;
        expect(vapid.subject).toBe("mailto:hub@example.com");
        expect(vapid.publicKey.length).toBeGreaterThan(80);

        const active = {
          id: WebPushSubscriptionId.make("sub-active"),
          endpoint: "https://push.example.com/active",
          deviceLabel: "Active Phone",
          enabled: true,
        };
        const gone = {
          id: WebPushSubscriptionId.make("sub-gone"),
          endpoint: "https://push.example.com/gone",
          deviceLabel: "Stale Browser",
          enabled: true,
        };
        const activeKeys = { p256dh: "p256-a", auth: "auth-a" };
        const blocked = {
          ...active,
          id: WebPushSubscriptionId.make("sub-0-blocked"),
          endpoint: "https://blocked.example/sub",
        };
        yield* service.subscribe({ ...blocked, keys: activeKeys });
        yield* service.subscribe({ ...active, keys: activeKeys });
        yield* service.subscribe({
          ...gone,
          keys: { p256dh: "p256-g", auth: "auth-g" },
        });

        expect(yield* service.listSubscriptions).toStrictEqual([blocked, active, gone]);

        const firstDispatch = yield* service.notifyEvent({
          kind: "approval_requested",
          occurredAt: "2026-11-22T14:00:00.000Z",
          projectTitle: "t3code",
          threadId: "thread-1",
          threadTitle: "Refactor auth",
          requestId: "req-1",
          provider: "claudeAgent",
          commandOrToolName: "bash",
        });

        expect(firstDispatch.decision.shouldSend).toBe(true);
        expect(firstDispatch.deliveredCount).toBe(1);
        expect(firstDispatch.failedCount).toBe(2);
        expect(firstDispatch.prunedSubscriptionIds).toEqual([
          WebPushSubscriptionId.make("sub-gone"),
        ]);
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]?.keys).toEqual(activeKeys);
        expect(deliveries[0]?.title).toContain("[cl]");

        const remaining = yield* service.listSubscriptions;
        expect(remaining.map((sub) => sub.id)).toEqual([blocked.id, active.id]);

        const duplicateDispatch = yield* service.notifyEvent({
          kind: "approval_requested",
          occurredAt: "2026-11-22T14:00:10.000Z",
          projectTitle: "t3code",
          threadId: "thread-1",
          requestId: "req-1",
        });
        expect(duplicateDispatch.decision.shouldSend).toBe(false);
        expect(duplicateDispatch.decision.reason).toBe("debounced");
        expect(deliveries).toHaveLength(1);

        yield* TestClock.adjust(Duration.minutes(2));
        yield* service.setPreferences({
          enabled: true,
          enabledKinds: ["approval_requested", "pm_completed"],
          quietHours: {
            enabled: true,
            startTime: "22:00",
            endTime: "07:00",
            timeZone: "UTC",
            allowUrgent: true,
          },
          debounceWindowMs: 60_000,
        });

        const quietBlocked = yield* service.notifyEvent({
          kind: "pm_completed",
          occurredAt: "2026-11-22T23:30:00.000Z",
          threadId: "thread-pm",
          summary: "Wave 2 done",
        });
        expect(quietBlocked.decision.shouldSend).toBe(false);
        expect(quietBlocked.decision.reason).toBe("quiet_hours");

        const quietUrgentAllowed = yield* service.notifyEvent({
          kind: "approval_requested",
          occurredAt: "2026-11-22T23:31:00.000Z",
          threadId: "thread-2",
          requestId: "req-urgent",
          urgent: true,
        });
        expect(quietUrgentAllowed.decision.shouldSend).toBe(true);
        expect(quietUrgentAllowed.deliveredCount).toBe(1);
      }),
  );
});
