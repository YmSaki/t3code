// @effect-diagnostics nodeBuiltinImport:off -- the test decrypts and verifies with the receiver's keys.
import * as NodeCrypto from "node:crypto";

import { expect, it } from "@effect/vitest";
import { WebPushSubscriptionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { WebPushPayloadMessage } from "./WebPushService.ts";
import type { VapidKeyRecord } from "./WebPushStore.ts";
import { makeHttpTransport } from "./WebPushTransport.ts";

const transportAnswering = (
  status: number,
  seen: Array<HttpClientRequest.HttpClientRequest> = [],
) =>
  makeHttpTransport().pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push(request);
          return HttpClientResponse.fromWeb(
            request,
            new Response(status === 201 ? "" : "nope", { status }),
          );
        }),
      ),
    ),
  );

const hmac = (key: Uint8Array, data: Uint8Array) =>
  NodeCrypto.createHmac("sha256", key).update(data).digest();

/** The user agent's side of RFC 8291, written independently of the sender. */
const decryptAsReceiver = (body: Uint8Array, receiver: NodeCrypto.ECDH, authSecret: Buffer) => {
  const buffer = Buffer.from(body);
  const salt = buffer.subarray(0, 16);
  const recordSize = buffer.readUInt32BE(16);
  const keyIdLength = buffer[20]!;
  const senderPublicKey = buffer.subarray(21, 21 + keyIdLength);
  const ciphertext = buffer.subarray(21 + keyIdLength);
  const ikm = hmac(
    hmac(authSecret, receiver.computeSecret(senderPublicKey)),
    Buffer.concat([
      Buffer.from("WebPush: info\0"),
      receiver.getPublicKey(),
      senderPublicKey,
      Buffer.from([1]),
    ]),
  );
  const prk = hmac(salt, ikm);
  const decipher = NodeCrypto.createDecipheriv(
    "aes-128-gcm",
    hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16),
    hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12),
  );
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([
    decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
    decipher.final(),
  ]);
  expect(padded[padded.length - 1]).toBe(2);
  return { recordSize, plaintext: padded.subarray(0, padded.length - 1).toString("utf8") };
};

const vapidPublicKeyObject = (uncompressed: string) => {
  const point = Buffer.from(uncompressed, "base64url");
  return NodeCrypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: point.subarray(1, 33).toString("base64url"),
      y: point.subarray(33, 65).toString("base64url"),
    },
    format: "jwk",
  });
};

const setup = () => {
  const receiver = NodeCrypto.createECDH("prime256v1");
  receiver.generateKeys();
  const authSecret = NodeCrypto.randomBytes(16);
  const vapidKeys = NodeCrypto.createECDH("prime256v1");
  vapidKeys.generateKeys();
  const vapidPublicKey = vapidKeys.getPublicKey();
  const vapidPrivateKey = NodeCrypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: vapidPublicKey.subarray(1, 33).toString("base64url"),
      y: vapidPublicKey.subarray(33, 65).toString("base64url"),
      d: vapidKeys.getPrivateKey().toString("base64url"),
    },
    format: "jwk",
  });
  const vapid: VapidKeyRecord = {
    id: "vapid-1",
    publicKey: vapidPublicKey.toString("base64url"),
    privateKeyPkcs8Pem: vapidPrivateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    subject: "mailto:hub@example.com",
    createdAt: "2026-11-22T00:00:00.000Z",
  };
  const subscription = {
    id: WebPushSubscriptionId.make("sub-1"),
    endpoint: "https://push.example.com/send/abc?x=1",
    keys: {
      p256dh: receiver.getPublicKey().toString("base64url"),
      auth: authSecret.toString("base64url"),
    },
    deviceLabel: null,
    enabled: true,
    createdAt: "2026-11-22T00:00:00.000Z",
    updatedAt: "2026-11-22T00:00:00.000Z",
  };
  const payload: WebPushPayloadMessage = {
    title: "Approval needed",
    body: "Run rm -rf build?",
    priority: "high",
    dedupeKey: "approval:thread-1",
    kind: "approval_requested",
    occurredAt: "2026-11-22T14:00:00.000Z",
    threadId: "thread-1",
  };
  return { receiver, authSecret, vapid, subscription, payload };
};

it.effect("signs an ES256 VAPID JWT and posts an aes128gcm body the receiver can decrypt", () =>
  Effect.gen(function* () {
    const { receiver, authSecret, vapid, subscription, payload } = setup();
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const transport = yield* transportAnswering(201, requests);

    const outcome = yield* transport({ subscription, payload, vapid });
    expect(outcome).toEqual({ status: "delivered", statusCode: 201 });
    expect(requests).toHaveLength(1);

    const request = requests[0]!;
    expect(request.url).toBe(subscription.endpoint);
    expect(request.method).toBe("POST");
    expect(request.headers).toMatchObject({
      ttl: "86400",
      urgency: "high",
      "content-encoding": "aes128gcm",
    });
    expect(request.body._tag).toBe("Uint8Array");
    if (request.body._tag !== "Uint8Array") return;
    expect(request.body.contentType).toBe("application/octet-stream");

    const authorization = /^vapid t=([^,]+), k=(.+)$/.exec(request.headers.authorization!);
    expect(authorization?.[2]).toBe(vapid.publicKey);
    const [header, claims, signature] = authorization![1]!.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({
      aud: "https://push.example.com",
      exp: 12 * 60 * 60,
      sub: "mailto:hub@example.com",
    });
    const signatureBytes = Buffer.from(signature!, "base64url");
    expect(signatureBytes).toHaveLength(64);
    expect(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: vapidPublicKeyObject(vapid.publicKey), dsaEncoding: "ieee-p1363" },
        signatureBytes,
      ),
    ).toBe(true);

    const decrypted = decryptAsReceiver(request.body.body, receiver, authSecret);
    expect(decrypted.recordSize).toBe(4096);
    expect(JSON.parse(decrypted.plaintext)).toEqual(payload);
  }),
);

it.effect("maps push service answers and failures to delivery outcomes", () =>
  Effect.gen(function* () {
    const { vapid, subscription, payload } = setup();
    const answering = transportAnswering;

    expect(yield* (yield* answering(410))({ subscription, payload, vapid })).toEqual({
      status: "gone",
      statusCode: 410,
    });
    expect(yield* (yield* answering(404))({ subscription, payload, vapid })).toMatchObject({
      status: "gone",
    });
    expect(yield* (yield* answering(500))({ subscription, payload, vapid })).toEqual({
      status: "failed",
      statusCode: 500,
      errorMessage: "Push service answered 500: nope",
    });

    const unreachable = yield* makeHttpTransport().pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error("ECONNREFUSED"),
              }),
            }),
          ),
        ),
      ),
    );
    const refused = yield* Effect.flip(unreachable({ subscription, payload, vapid }));
    expect(refused.reason).toBe("delivery_failed");

    const badKeys = yield* Effect.flip(
      (yield* answering(201))({
        subscription: { ...subscription, keys: { p256dh: "not-a-point", auth: "x" } },
        payload,
        vapid,
      }),
    );
    expect(badKeys.reason).toBe("invalid_subscription");
  }),
);
