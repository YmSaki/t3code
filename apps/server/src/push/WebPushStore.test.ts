// @effect-diagnostics nodeBuiltinImport:off -- registration tests control DNS and the server's interfaces.
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeCrypto from "node:crypto";
import type * as NodeOS from "node:os";

import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { WebPushSubscriptionId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import migrate111 from "../persistence/Migrations/111_WebPushSubscriptions.ts";
import * as WebPushStore from "./WebPushStore.ts";

vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeDnsPromises>()),
  lookup: vi.fn(() => Promise.reject(new Error("Unexpected DNS lookup during registration"))),
}));

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOS>()),
  networkInterfaces: () => ({
    ethernet: [
      {
        address: "198.51.100.7",
        family: "IPv4",
        internal: false,
        netmask: "255.255.255.0",
        mac: "00:00:00:00:00:00",
        cidr: "198.51.100.7/24",
      },
    ],
  }),
}));

const platformLayer = Layer.mergeAll(NodeServices.layer, NodePlatformCrypto.layer);

const testLayer = () =>
  Layer.mergeAll(
    NodeSqliteClient.layer({ filename: ":memory:" }),
    ServerSecretStore.layer.pipe(
      Layer.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-web-push-test-" }).pipe(
          Layer.provide(platformLayer),
        ),
      ),
      Layer.provide(platformLayer),
    ),
  );

const layer = it.layer(testLayer());

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

      for (const endpoint of [
        "http://push.example/sub",
        "not a URL",
        "https://user:secret@push.example/sub",
        "https://@push.example/sub",
        "https://127.0.0.1/sub",
        "https://[::ffff:10.0.0.1]/sub",
        "https://[::ffff:7f00:1]/sub",
        "https://[0:0:0:0:0:ffff:0a00:0001]/sub",
        "https://198.51.100.7/sub",
        "https://[::ffff:198.51.100.7]/sub",
      ]) {
        const outcome = yield* store
          .upsertSubscription({
            endpoint,
            keys: { p256dh: "p256", auth: "auth" },
          })
          .pipe(Effect.match({ onFailure: (error) => error.reason, onSuccess: () => "accepted" }));
        expect(outcome, endpoint).toBe("invalid_subscription");
      }

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
        endpoint: "https://198.51.100.8/send/D456",
        keys: { p256dh: "p256-desk", auth: "auth-desk" },
        deviceLabel: "Desktop PWA",
        enabled: true,
      });
      expect(second.enabled).toBe(true);
      expect(NodeDnsPromises.lookup).not.toHaveBeenCalled();

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

const generatePem = () => {
  const { privateKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return privateKey.export({ type: "pkcs8", format: "pem" }).toString();
};
const publicKeyOf = (pem: string) => {
  const jwk = NodeCrypto.createPublicKey(NodeCrypto.createPrivateKey(pem)).export({
    format: "jwk",
  });
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x!, "base64url"),
    Buffer.from(jwk.y!, "base64url"),
  ]).toString("base64url");
};
const secretName = "web-push-vapid-default";

const insertRow = (publicKey: string, privateKey: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO web_push_vapid_keys (id, public_key, private_key_pkcs8_pem, subject, created_at)
      VALUES ('default', ${publicKey}, ${privateKey}, 'mailto:a@example.com', '2026-01-01T00:00:00Z')
    `;
  });
const readRowPrivateKey = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly value: string }>`
    SELECT private_key_pkcs8_pem AS value FROM web_push_vapid_keys WHERE id = 'default'
  `;
  return rows[0]?.value;
});
const makeStore = Effect.gen(function* () {
  yield* migrate111;
  return yield* WebPushStore.WebPushStore.pipe(Effect.provide(WebPushStore.layer));
});

it.effect("keeps a generated VAPID private key out of SQLite and serves one key concurrently", () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;

    const results = yield* Effect.all(
      Array.from({ length: 8 }, () => store.ensureVapidKeys()),
      { concurrency: "unbounded" },
    );
    expect(new Set(results.map((record) => record.publicKey)).size).toBe(1);
    expect(yield* readRowPrivateKey).toBe(`secret-store:${secretName}`);
    const secret = yield* secrets.get(secretName);
    expect(Buffer.from(Option.getOrThrow(secret)).toString()).toBe(results[0]!.privateKeyPkcs8Pem);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("moves a plaintext PEM into the secret store and keeps the published public key", () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const pem = generatePem();
    const publicKey = publicKeyOf(pem);
    yield* insertRow(publicKey, pem);

    const migrated = yield* store.ensureVapidKeys();
    const again = yield* store.ensureVapidKeys();

    expect(migrated.publicKey).toBe(publicKey);
    expect(again.privateKeyPkcs8Pem).toBe(pem);
    expect(yield* readRowPrivateKey).toBe(`secret-store:${secretName}`);
    const signature = NodeCrypto.sign(
      "sha256",
      Buffer.from("payload"),
      migrated.privateKeyPkcs8Pem,
    );
    const jwk = NodeCrypto.createPublicKey(pem);
    expect(NodeCrypto.verify("sha256", Buffer.from("payload"), jwk, signature)).toBe(true);
    expect(Option.isSome(yield* secrets.get(secretName))).toBe(true);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("finishes a migration when the secret was already created with the same key", () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const pem = generatePem();
    yield* insertRow(publicKeyOf(pem), pem);
    yield* secrets.create(secretName, Buffer.from(pem));

    expect((yield* store.ensureVapidKeys()).privateKeyPkcs8Pem).toBe(pem);
    expect(yield* readRowPrivateKey).toBe(`secret-store:${secretName}`);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("registers a row for a secret left without one", () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const pem = generatePem();
    yield* secrets.create(secretName, Buffer.from(pem));

    const record = yield* store.ensureVapidKeys();
    expect(record.publicKey).toBe(publicKeyOf(pem));
    expect(yield* readRowPrivateKey).toBe(`secret-store:${secretName}`);
  }).pipe(Effect.provide(testLayer())),
);

it.effect("fails instead of regenerating when the row and secret disagree", () =>
  Effect.gen(function* () {
    const store = yield* makeStore;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const pem = generatePem();
    const row = `secret-store:${secretName}`;

    yield* insertRow(publicKeyOf(pem), row);
    const missing = yield* Effect.flip(store.ensureVapidKeys());
    expect(missing.reason).toBe("vapid_error");
    expect(Option.isNone(yield* secrets.get(secretName))).toBe(true);

    yield* secrets.create(secretName, Buffer.from(generatePem()));
    const mismatched = yield* Effect.flip(store.ensureVapidKeys());
    expect(mismatched.reason).toBe("vapid_error");
    expect(yield* readRowPrivateKey).toBe(row);
  }).pipe(Effect.provide(testLayer())),
);
