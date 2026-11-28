// @effect-diagnostics-next-line nodeBuiltinImport:off -- VAPID P-256 key generation
import * as NodeCrypto from "node:crypto";

import {
  WebPushError,
  type WebPushSubscription,
  type WebPushSubscriptionDeleteInput,
  WebPushSubscriptionId,
  type WebPushSubscriptionInput,
  WebPushSubscriptionKeys,
  type WebPushVapidPublicKeyResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { parseWebPushEndpoint } from "./webPushEndpoint.ts";

const DEFAULT_VAPID_KEY_ID = "default";
const DEFAULT_VAPID_SUBJECT = "mailto:selfhost@t3.codes";
const VAPID_SECRET_REFERENCE_PREFIX = "secret-store:";
const vapidSecretName = (id: string) => `web-push-vapid-${id}`;

export interface VapidKeyRecord {
  readonly id: string;
  readonly publicKey: string;
  readonly privateKeyPkcs8Pem: string;
  readonly subject: string;
  readonly createdAt: string;
}

export interface GeneratedVapidKeyPair {
  readonly publicKey: string;
  readonly privateKeyPkcs8Pem: string;
}

function derivePublicKey(privateKeyPkcs8Pem: string): string {
  const jwk = NodeCrypto.createPublicKey(NodeCrypto.createPrivateKey(privateKeyPkcs8Pem)).export({
    format: "jwk",
  });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("EC P-256 JWK export did not produce x and y coordinates.");
  }
  return Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url"),
  ]).toString("base64url");
}

function generateVapidKeyPair(): GeneratedVapidKeyPair {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") {
    throw new Error("EC P-256 JWK export did not produce x and y coordinates.");
  }
  const xBytes = Buffer.from(jwk.x, "base64url");
  const yBytes = Buffer.from(jwk.y, "base64url");
  const uncompressed = Buffer.concat([Buffer.from([0x04]), xBytes, yBytes]).toString("base64url");
  const privateKeyPkcs8Pem = privateKey
    .export({
      type: "pkcs8",
      format: "pem",
    })
    .toString();

  return {
    publicKey: uncompressed,
    privateKeyPkcs8Pem,
  };
}

const SubscriptionRow = Schema.Struct({
  id: WebPushSubscriptionId,
  endpoint: Schema.String,
  keys: Schema.fromJsonString(WebPushSubscriptionKeys),
  deviceLabel: Schema.NullOr(Schema.String),
  enabled: Schema.BooleanFromBit,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const VapidKeyRow = Schema.Struct({
  id: Schema.String,
  publicKey: Schema.String,
  privateKeyPkcs8Pem: Schema.String,
  subject: Schema.String,
  createdAt: Schema.String,
});

const encodeKeysJson = Schema.encodeEffect(Schema.fromJsonString(WebPushSubscriptionKeys));

export class WebPushStore extends Context.Service<
  WebPushStore,
  {
    readonly upsertSubscription: (
      input: WebPushSubscriptionInput,
    ) => Effect.Effect<WebPushSubscription, WebPushError>;
    readonly getSubscription: (
      id: WebPushSubscriptionId,
    ) => Effect.Effect<WebPushSubscription | null, WebPushError>;
    readonly listSubscriptions: (options?: {
      readonly enabledOnly?: boolean | undefined;
    }) => Effect.Effect<ReadonlyArray<WebPushSubscription>, WebPushError>;
    readonly deleteSubscription: (
      input: WebPushSubscriptionDeleteInput,
    ) => Effect.Effect<boolean, WebPushError>;
    readonly ensureVapidKeys: (subject?: string) => Effect.Effect<VapidKeyRecord, WebPushError>;
    readonly getVapidPublicKey: (
      subject?: string,
    ) => Effect.Effect<WebPushVapidPublicKeyResult, WebPushError>;
  }
>()("t3/push/WebPushStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const vapidLock = yield* Semaphore.make(1);

  const toStorageError = (detail: string) => (cause: unknown) =>
    new WebPushError({
      reason: "storage",
      message: detail,
      cause,
    });

  const selectSubscriptionColumns = sql`
    id,
    endpoint,
    keys_json AS "keys",
    device_label AS "deviceLabel",
    enabled,
    created_at AS "createdAt",
    updated_at AS "updatedAt"
  `;

  const findSubscriptionById = SqlSchema.findOneOption({
    Request: WebPushSubscriptionId,
    Result: SubscriptionRow,
    execute: (id) => sql`
      SELECT ${selectSubscriptionColumns}
      FROM web_push_subscriptions
      WHERE id = ${id}
      LIMIT 1
    `,
  });

  const findSubscriptionByEndpoint = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: SubscriptionRow,
    execute: (endpoint) => sql`
      SELECT ${selectSubscriptionColumns}
      FROM web_push_subscriptions
      WHERE endpoint = ${endpoint}
      LIMIT 1
    `,
  });

  const findAllSubscriptions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SubscriptionRow,
    execute: () => sql`
      SELECT ${selectSubscriptionColumns}
      FROM web_push_subscriptions
      ORDER BY updated_at DESC, id ASC
    `,
  });

  const findEnabledSubscriptions = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SubscriptionRow,
    execute: () => sql`
      SELECT ${selectSubscriptionColumns}
      FROM web_push_subscriptions
      WHERE enabled = 1
      ORDER BY updated_at DESC, id ASC
    `,
  });

  const findVapidKey = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: VapidKeyRow,
    execute: (id) => sql`
      SELECT
        id,
        public_key AS "publicKey",
        private_key_pkcs8_pem AS "privateKeyPkcs8Pem",
        subject,
        created_at AS "createdAt"
      FROM web_push_vapid_keys
      WHERE id = ${id}
      LIMIT 1
    `,
  });

  const upsertSubscription: WebPushStore["Service"]["upsertSubscription"] = Effect.fn(
    "WebPushStore.upsertSubscription",
  )(function* (input) {
    const endpoint = input.endpoint.trim();
    yield* parseWebPushEndpoint(endpoint);

    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const existing = yield* findSubscriptionByEndpoint(endpoint).pipe(
      Effect.mapError(toStorageError("Could not query existing Web Push subscription.")),
    );
    const id =
      input.id ??
      (Option.isSome(existing)
        ? existing.value.id
        : WebPushSubscriptionId.make(`push-${NodeCrypto.randomUUID()}`));
    const createdAt = Option.isSome(existing) ? existing.value.createdAt : nowIso;
    const deviceLabel =
      input.deviceLabel !== undefined
        ? input.deviceLabel
        : Option.isSome(existing)
          ? existing.value.deviceLabel
          : null;
    const enabled =
      input.enabled !== undefined
        ? input.enabled
        : Option.isSome(existing)
          ? existing.value.enabled
          : true;
    const keysJson = yield* encodeKeysJson(input.keys).pipe(
      Effect.mapError(toStorageError("Could not encode Web Push subscription keys.")),
    );

    yield* sql`
      INSERT INTO web_push_subscriptions (
        id, endpoint, keys_json, device_label, enabled, created_at, updated_at
      ) VALUES (
        ${id}, ${endpoint}, ${keysJson}, ${deviceLabel}, ${enabled ? 1 : 0}, ${createdAt}, ${nowIso}
      )
      ON CONFLICT(endpoint) DO UPDATE SET
        keys_json = excluded.keys_json,
        device_label = excluded.device_label,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `.pipe(Effect.mapError(toStorageError("Could not save Web Push subscription.")));

    const saved = yield* findSubscriptionByEndpoint(endpoint).pipe(
      Effect.mapError(toStorageError("Could not read saved Web Push subscription.")),
    );
    if (Option.isNone(saved)) {
      return yield* new WebPushError({
        reason: "storage",
        message: "Saved Web Push subscription was not found.",
      });
    }
    return saved.value;
  });

  const getSubscription: WebPushStore["Service"]["getSubscription"] = Effect.fn(
    "WebPushStore.getSubscription",
  )(function* (id) {
    const found = yield* findSubscriptionById(id).pipe(
      Effect.mapError(toStorageError("Could not read Web Push subscription.")),
    );
    return Option.getOrNull(found);
  });

  const listSubscriptions: WebPushStore["Service"]["listSubscriptions"] = Effect.fn(
    "WebPushStore.listSubscriptions",
  )(function* (options) {
    const query = options?.enabledOnly ? findEnabledSubscriptions : findAllSubscriptions;
    return yield* query(undefined).pipe(
      Effect.mapError(toStorageError("Could not list Web Push subscriptions.")),
    );
  });

  const deleteSubscription: WebPushStore["Service"]["deleteSubscription"] = Effect.fn(
    "WebPushStore.deleteSubscription",
  )(function* (input) {
    if (input.id === undefined && input.endpoint === undefined) {
      return yield* new WebPushError({
        reason: "invalid_subscription",
        message: "Provide either subscription id or endpoint to delete.",
      });
    }

    if (input.id !== undefined) {
      const existing = yield* findSubscriptionById(input.id).pipe(
        Effect.mapError(toStorageError("Could not look up Web Push subscription for deletion.")),
      );
      if (Option.isNone(existing)) return false;
      yield* sql`DELETE FROM web_push_subscriptions WHERE id = ${input.id}`.pipe(
        Effect.mapError(toStorageError("Could not delete Web Push subscription.")),
      );
      return true;
    }

    const endpoint = input.endpoint?.trim() ?? "";
    const existing = yield* findSubscriptionByEndpoint(endpoint).pipe(
      Effect.mapError(toStorageError("Could not look up Web Push subscription for deletion.")),
    );
    if (Option.isNone(existing)) return false;
    yield* sql`DELETE FROM web_push_subscriptions WHERE endpoint = ${endpoint}`.pipe(
      Effect.mapError(toStorageError("Could not delete Web Push subscription.")),
    );
    return true;
  });

  const vapidError = (message: string) => (cause?: unknown) =>
    new WebPushError({ reason: "vapid_error", message, cause });

  // The private key lives in the secret store; the row keeps only a reference to it. A row or
  // secret that disagrees with the other is an error, never a reason to mint a new key, since a
  // new key would orphan every existing subscription.
  const ensureVapidKeysLocked = Effect.fn("WebPushStore.ensureVapidKeysLocked")(function* (
    subject: string,
  ) {
    const id = DEFAULT_VAPID_KEY_ID;
    const name = vapidSecretName(id);
    const reference = `${VAPID_SECRET_REFERENCE_PREFIX}${name}`;
    const readSecret = secrets
      .get(name)
      .pipe(
        Effect.map(Option.map((bytes) => Buffer.from(bytes).toString("utf8"))),
        Effect.mapError(vapidError("Could not read the VAPID private key.")),
      );
    const storeSecret = (pem: string) =>
      secrets.create(name, Buffer.from(pem, "utf8")).pipe(
        Effect.catchIf(ServerSecretStore.isSecretStoreError, (error) =>
          ServerSecretStore.isSecretAlreadyExistsError(error) ? Effect.void : Effect.fail(error),
        ),
        Effect.mapError(vapidError("Could not store the VAPID private key.")),
      );
    const derive = (pem: string) =>
      Effect.try({
        try: () => derivePublicKey(pem),
        catch: vapidError("The stored VAPID private key is not a valid P-256 key."),
      });
    const requireSecret = Effect.flatMap(
      readSecret,
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(vapidError("The VAPID private key is missing from the secret store.")()),
      }),
    );

    const existing = yield* findVapidKey(id).pipe(
      Effect.mapError(toStorageError("Could not query stored VAPID key pair.")),
    );

    if (Option.isSome(existing)) {
      const row = existing.value;
      if (row.privateKeyPkcs8Pem.startsWith(VAPID_SECRET_REFERENCE_PREFIX)) {
        const pem = yield* requireSecret;
        if ((yield* derive(pem)) !== row.publicKey) {
          return yield* vapidError("The stored VAPID public key does not match its private key.")();
        }
        return { ...row, privateKeyPkcs8Pem: pem };
      }
      // A plaintext row from an older build moves into the secret store.
      yield* storeSecret(row.privateKeyPkcs8Pem);
      const pem = yield* requireSecret;
      if ((yield* derive(pem)) !== row.publicKey) {
        return yield* vapidError("The stored VAPID public key does not match its private key.")();
      }
      yield* sql`
        UPDATE web_push_vapid_keys
        SET private_key_pkcs8_pem = ${reference}
        WHERE id = ${id}
          AND public_key = ${row.publicKey}
          AND private_key_pkcs8_pem = ${row.privateKeyPkcs8Pem}
      `.pipe(Effect.mapError(toStorageError("Could not migrate the VAPID private key.")));
      return { ...row, privateKeyPkcs8Pem: pem };
    }

    // No row: adopt a secret left by an interrupted setup, otherwise generate one.
    const adopted = yield* readSecret;
    const pem = Option.isSome(adopted)
      ? adopted.value
      : yield* Effect.try({
          try: () => generateVapidKeyPair().privateKeyPkcs8Pem,
          catch: vapidError("Failed to generate ECDSA P-256 VAPID key pair."),
        }).pipe(Effect.tap(storeSecret), Effect.andThen(requireSecret));
    const publicKey = yield* derive(pem);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT OR IGNORE INTO web_push_vapid_keys (
        id, public_key, private_key_pkcs8_pem, subject, created_at
      ) VALUES (${id}, ${publicKey}, ${reference}, ${subject}, ${createdAt})
    `.pipe(Effect.mapError(toStorageError("Could not persist VAPID key pair.")));

    const stored = yield* findVapidKey(id).pipe(
      Effect.mapError(toStorageError("Could not read persisted VAPID key pair.")),
    );
    if (Option.isNone(stored)) {
      return yield* vapidError("Persisted VAPID key pair was not found.")();
    }
    return { ...stored.value, privateKeyPkcs8Pem: pem };
  });

  const ensureVapidKeys: WebPushStore["Service"]["ensureVapidKeys"] = Effect.fn(
    "WebPushStore.ensureVapidKeys",
  )(function* (subject = DEFAULT_VAPID_SUBJECT) {
    return yield* vapidLock.withPermits(1)(
      ensureVapidKeysLocked(subject.trim() || DEFAULT_VAPID_SUBJECT),
    );
  });

  const getVapidPublicKey: WebPushStore["Service"]["getVapidPublicKey"] = Effect.fn(
    "WebPushStore.getVapidPublicKey",
  )(function* (subject) {
    const record = yield* ensureVapidKeys(subject);
    return {
      publicKey: record.publicKey,
      subject: record.subject,
    };
  });

  return WebPushStore.of({
    upsertSubscription,
    getSubscription,
    listSubscriptions,
    deleteSubscription,
    ensureVapidKeys,
    getVapidPublicKey,
  });
});

export const layer = Layer.effect(WebPushStore, make);
