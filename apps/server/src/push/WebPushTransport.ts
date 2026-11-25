// @effect-diagnostics-next-line nodeBuiltinImport:off -- ECDH, HKDF-style HMAC and AES-GCM for RFC 8291, ES256 for RFC 8292
import * as NodeCrypto from "node:crypto";
import type * as NodeNet from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { WebPushError } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schema from "effect/Schema";

import { resolvePublicLookup } from "../utils/publicAddresses.ts";
import { parseWebPushEndpoint } from "./webPushEndpoint.ts";
import type { WebPushDeliveryOutcome, WebPushDeliveryTransport } from "./WebPushService.ts";

/** Push services keep an undeliverable message this long before dropping it. */
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;
/** RFC 8292 caps `exp` at 24 hours; stay well inside it so clock skew never trips it. */
const VAPID_JWT_LIFETIME_SECONDS = 12 * 60 * 60;
const RECORD_SIZE = 4096;
/** A push service that hangs must not hold up every later notification behind it. */
const REQUEST_TIMEOUT = Duration.seconds(10);
const encodePayloadJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

interface WebPushEncryptionSeed {
  readonly salt: Uint8Array;
  readonly ephemeralPrivateKey: NodeCrypto.ECDH;
}

export interface WebPushHttpTransportOptions {
  readonly ttlSeconds?: number | undefined;
}

const hmac = (key: Uint8Array, data: Uint8Array) =>
  NodeCrypto.createHmac("sha256", key).update(data).digest();

const base64Url = (data: Uint8Array | string) => Buffer.from(data).toString("base64url");

function signVapidJwt(input: {
  readonly audience: string;
  readonly subject: string;
  readonly expiresAtSeconds: number;
  readonly privateKeyPkcs8Pem: string;
}): string {
  const header = base64Url(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = base64Url(
    JSON.stringify({ aud: input.audience, exp: input.expiresAtSeconds, sub: input.subject }),
  );
  const signingInput = `${header}.${claims}`;
  // JWS ES256 wants raw R||S, not Node's default DER signature.
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: input.privateKeyPkcs8Pem,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

/** RFC 8291 `aes128gcm` content encoding for a single record. */
function encryptWebPushPayload(input: {
  readonly plaintext: Uint8Array;
  readonly receiverPublicKey: Uint8Array;
  readonly authSecret: Uint8Array;
  readonly seed: WebPushEncryptionSeed;
}): Uint8Array {
  const { salt, ephemeralPrivateKey } = input.seed;
  const senderPublicKey = ephemeralPrivateKey.getPublicKey();
  const ecdhSecret = ephemeralPrivateKey.computeSecret(input.receiverPublicKey);
  const keyInfo = Buffer.concat([
    Buffer.from("WebPush: info\0"),
    input.receiverPublicKey,
    senderPublicKey,
    Buffer.from([1]),
  ]);
  const ikm = hmac(hmac(input.authSecret, ecdhSecret), keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);

  const cipher = NodeCrypto.createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([input.plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([
    salt,
    recordSize,
    Buffer.from([senderPublicKey.length]),
    senderPublicKey,
    ciphertext,
  ]);
}

const freshSeed = (): WebPushEncryptionSeed => {
  const ephemeralPrivateKey = NodeCrypto.createECDH("prime256v1");
  ephemeralPrivateKey.generateKeys();
  return { salt: NodeCrypto.randomBytes(16), ephemeralPrivateKey };
};

const outcomeForStatus = (status: number): WebPushDeliveryOutcome => {
  if (status >= 200 && status < 300) return { status: "delivered", statusCode: status };
  if (status === 404 || status === 410) return { status: "gone", statusCode: status };
  return {
    status: "failed",
    statusCode: status,
    errorMessage: `Push service answered ${status}`,
  };
};

const responseStatus = Effect.fn("WebPushTransport.responseStatus")(function* (
  request: HttpClientRequest.HttpClientRequest,
) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.withScope(http).execute(request);
  return response.status;
}, Effect.scoped);

export const postWithCheckedLookup = Effect.fn("WebPushTransport.postWithCheckedLookup")(function* (
  request: HttpClientRequest.HttpClientRequest,
  lookup: NodeNet.LookupFunction,
) {
  return yield* responseStatus(request).pipe(
    Effect.provide(
      NodeHttpClient.layerNodeHttpOptions({ lookup, autoSelectFamily: true, keepAlive: false }),
    ),
  );
});

const deliveryTransport = (
  post: typeof postWithCheckedLookup,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): WebPushDeliveryTransport =>
  Effect.fn("WebPushTransport.send")(
    function* ({ subscription, payload, vapid }) {
      const { url, host } = yield* parseWebPushEndpoint(subscription.endpoint);
      const lookup = yield* Effect.tryPromise({
        try: () => resolvePublicLookup(host),
        catch: (cause) =>
          new WebPushError({
            reason: "delivery_failed",
            message: "Push endpoint did not resolve to a public address.",
            cause,
          }),
      });
      if (!lookup) {
        return yield* new WebPushError({
          reason: "delivery_failed",
          message: "Push endpoint did not resolve to a public address.",
        });
      }
      const nowSeconds = Math.floor(DateTime.toEpochMillis(yield* DateTime.now) / 1000);
      const plaintext = yield* encodePayloadJson(payload).pipe(
        Effect.mapError(
          (cause) =>
            new WebPushError({ reason: "delivery_failed", message: "Unencodable payload.", cause }),
        ),
      );
      // Bad stored keys throw inside node:crypto; one broken subscription must not stop the rest.
      const request = yield* Effect.try({
        try: () => {
          const jwt = signVapidJwt({
            audience: url.origin,
            subject: vapid.subject,
            expiresAtSeconds: nowSeconds + VAPID_JWT_LIFETIME_SECONDS,
            privateKeyPkcs8Pem: vapid.privateKeyPkcs8Pem,
          });
          const body = encryptWebPushPayload({
            plaintext: Buffer.from(plaintext),
            receiverPublicKey: Buffer.from(subscription.keys.p256dh, "base64url"),
            authSecret: Buffer.from(subscription.keys.auth, "base64url"),
            seed: freshSeed(),
          });
          return HttpClientRequest.post(url.toString()).pipe(
            HttpClientRequest.setHeaders({
              Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
              TTL: String(ttlSeconds),
              Urgency: payload.priority === "high" ? "high" : "normal",
              "Content-Encoding": "aes128gcm",
            }),
            HttpClientRequest.bodyUint8Array(body, "application/octet-stream"),
          );
        },
        catch: (cause) =>
          new WebPushError({
            reason: "invalid_subscription",
            message: "Could not sign or encrypt the push payload.",
            cause,
          }),
      });

      return yield* post(request, lookup).pipe(
        Effect.map(outcomeForStatus),
        Effect.mapError(
          (cause) =>
            new WebPushError({
              reason: "delivery_failed",
              message: "Push service did not answer.",
              cause,
            }),
        ),
      );
    },
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.catchTags({
      TimeoutError: (cause) =>
        Effect.fail(
          new WebPushError({
            reason: "delivery_failed",
            message: "Push delivery timed out.",
            cause,
          }),
        ),
    }),
  );

export const nodeHttpTransport = deliveryTransport(postWithCheckedLookup);

export const makeHttpTransport = Effect.fn("WebPushTransport.makeHttpTransport")(function* (
  options: WebPushHttpTransportOptions = {},
) {
  const http = yield* HttpClient.HttpClient;
  return deliveryTransport(
    (request) => responseStatus(request).pipe(Effect.provideService(HttpClient.HttpClient, http)),
    options.ttlSeconds,
  );
});
