import { expect, it } from "@effect/vitest";
import { WebPushSubscriptionId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import migrate111 from "../persistence/Migrations/111_WebPushSubscriptions.ts";
import * as WebPushStore from "./WebPushStore.ts";

const layer = it.layer(NodeSqliteClient.layer({ filename: ":memory:" }));

layer("WebPushStore", (it) => {
  it.effect("generates and persists an ECDSA P-256 VAPID key pair idempotently", () =>
    Effect.gen(function* () {
      yield* migrate111;
      const store = yield* WebPushStore.WebPushStore.pipe(Effect.provide(WebPushStore.layer));

      const first = yield* store.ensureVapidKeys("mailto:ops@example.com");
      const second = yield* store.getVapidPublicKey();

      expect(first.publicKey).toBe(second.publicKey);
      expect(second.subject).toBe("mailto:ops@example.com");
      expect(Buffer.from(first.publicKey, "base64url").length).toBe(65);
      expect(Buffer.from(first.publicKey, "base64url")[0]).toBe(0x04);
      expect(first.privateKeyPkcs8Pem).toContain("BEGIN PRIVATE KEY");
    }),
  );

  it.effect("upserts, lists, filters, and deletes Web Push subscriptions", () =>
    Effect.gen(function* () {
      yield* migrate111;
      const store = yield* WebPushStore.WebPushStore.pipe(Effect.provide(WebPushStore.layer));

      const created = yield* store.upsertSubscription({
        id: WebPushSubscriptionId.make("sub-iphone"),
        endpoint: "https://web.push.apple.com/Q123",
        keys: { p256dh: "p256-initial", auth: "auth-initial" },
        deviceLabel: "iPhone",
        enabled: true,
      });
      expect(created.id).toBe(WebPushSubscriptionId.make("sub-iphone"));
      expect(created.deviceLabel).toBe("iPhone");

      yield* TestClock.adjust(Duration.seconds(30));

      const updated = yield* store.upsertSubscription({
        endpoint: "https://web.push.apple.com/Q123",
        keys: { p256dh: "p256-rotated", auth: "auth-rotated" },
        enabled: false,
      });
      expect(updated.id).toBe(created.id);
      expect(updated.keys.p256dh).toBe("p256-rotated");
      expect(updated.enabled).toBe(false);

      const second = yield* store.upsertSubscription({
        id: WebPushSubscriptionId.make("sub-desktop"),
        endpoint: "https://fcm.googleapis.com/fcm/send/D456",
        keys: { p256dh: "p256-desk", auth: "auth-desk" },
        deviceLabel: "Desktop PWA",
        enabled: true,
      });
      expect(second.enabled).toBe(true);

      const all = yield* store.listSubscriptions();
      expect(all).toHaveLength(2);

      const enabledOnly = yield* store.listSubscriptions({ enabledOnly: true });
      expect(enabledOnly.map((sub) => sub.id)).toEqual([WebPushSubscriptionId.make("sub-desktop")]);

      const removed = yield* store.deleteSubscription({
        endpoint: "https://web.push.apple.com/Q123",
      });
      expect(removed).toBe(true);

      const missing = yield* store.getSubscription(WebPushSubscriptionId.make("sub-iphone"));
      expect(missing).toBeNull();
    }),
  );
});
