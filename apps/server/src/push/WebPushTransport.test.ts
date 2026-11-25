// @effect-diagnostics nodeBuiltinImport:off -- the test decrypts and verifies with the receiver's keys.
import * as NodeCrypto from "node:crypto";
import type * as NodeDns from "node:dns";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import { expect, it } from "@effect/vitest";
import { WebPushSubscriptionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import type { WebPushPayloadMessage } from "./WebPushService.ts";
import type { VapidKeyRecord } from "./WebPushStore.ts";
import { makeHttpTransport, nodeHttpTransport, postWithCheckedLookup } from "./WebPushTransport.ts";

const { lookup } = vi.hoisted(() => ({
  lookup: vi.fn<() => Promise<NodeDns.LookupAddress[]>>(async () => [
    { address: "93.184.215.14", family: 4 },
  ]),
}));
vi.mock("node:dns/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:dns/promises")>()),
  lookup,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: () => ({ test: [{ address: "198.51.100.7", family: "IPv4" }] }),
}));
vi.mock("@effect/platform-node/NodeHttpClient", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeHttpClient>();
  return { ...actual, layerNodeHttpOptions: vi.fn(actual.layerNodeHttpOptions) };
});

const transportAnswering = (
  status: number,
  seen: Array<HttpClientRequest.HttpClientRequest> = [],
  responses: Response[] = [],
) =>
  makeHttpTransport().pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          seen.push(request);
          const response = new Response("provider detail", {
            status,
            headers: status === 307 ? { location: "https://other.invalid" } : {},
          });
          responses.push(response);
          return HttpClientResponse.fromWeb(request, response);
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
    for (const status of [307, 500]) {
      const seen: HttpClientRequest.HttpClientRequest[] = [];
      const responses: Response[] = [];
      expect(
        yield* (yield* answering(status, seen, responses))({ subscription, payload, vapid }),
      ).toEqual({
        status: "failed",
        statusCode: status,
        errorMessage: `Push service answered ${status}`,
      });
      expect(seen.map((request) => request.url)).toEqual([subscription.endpoint]);
      expect(responses[0]?.bodyUsed).toBe(false);
    }

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
    expect(refused.message).toBe("Push service did not answer.");

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

it.effect("revalidates stored destinations and every DNS answer before each delivery", () =>
  Effect.gen(function* () {
    const { subscription, payload, vapid } = setup();
    const seen: HttpClientRequest.HttpClientRequest[] = [];
    const send = yield* transportAnswering(201, seen);
    for (const endpoint of [
      "http://push.example.com/sub",
      "https://user@push.example.com/sub",
      "https://[::ffff:10.0.0.1]/sub",
      "https://198.51.100.7/sub",
    ]) {
      const error = yield* Effect.flip(
        send({ subscription: { ...subscription, endpoint }, payload, vapid }),
      );
      expect(error.reason).toBe("invalid_subscription");
    }
    expect(seen).toHaveLength(0);
    lookup.mockReset();
    expect((yield* send({ subscription, payload, vapid })).status).toBe("delivered");
    for (const answers of [
      [{ address: "127.0.0.1", family: 4 }],
      [
        { address: "93.184.215.14", family: 4 },
        { address: "fd00::1", family: 6 },
      ],
      [{ address: "198.18.2.40", family: 4 }],
      [{ address: "198.51.100.7", family: 4 }],
      [{ address: "::ffff:198.51.100.7", family: 6 }],
      [{ address: "64:ff9b::c633:6407", family: 6 }],
      [{ address: "2002:c633:6407::1", family: 6 }],
      [],
    ]) {
      lookup.mockResolvedValueOnce(answers);
      const error = yield* Effect.flip(send({ subscription, payload, vapid }));
      expect(error.message).toBe("Push endpoint did not resolve to a public address.");
    }
    expect(lookup).toHaveBeenCalledTimes(9);
    expect(lookup).toHaveBeenCalledWith("push.example.com", { all: true, verbatim: true });
    expect(seen).toHaveLength(1);
  }),
);

it.effect(
  "pins both Node lookup modes to the vetted snapshot and preserves the HTTPS authority",
  () =>
    Effect.gen(function* () {
      const input = setup();
      const answers = [
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "93.184.215.14", family: 4 },
      ];
      lookup.mockReset().mockResolvedValueOnce(answers);
      const urls: string[] = [];
      const layer = vi
        .mocked(NodeHttpClient.layerNodeHttpOptions)
        .mockClear()
        .mockReturnValueOnce(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request, url) => {
              urls.push(url.href);
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 201 })),
              );
            }),
          ),
        );
      expect((yield* nodeHttpTransport(input)).status).toBe("delivered");
      expect(urls).toEqual([input.subscription.endpoint]);
      const pinned = layer.mock.calls[0]?.[0]?.lookup;
      expect(pinned).toBeDefined();
      const callback = vi.fn();
      pinned!("push.example.com", { all: true }, callback);
      pinned!("push.example.com", {}, callback);
      expect(callback.mock.calls).toEqual([
        [null, answers],
        [null, answers[0]!.address, 6],
      ]);
      expect(lookup.mock.calls).toEqual([["push.example.com", { all: true, verbatim: true }]]);
    }),
);

it.effect("shares ten seconds between DNS and response headers and discards late DNS answers", () =>
  Effect.gen(function* () {
    const input = setup();
    lookup.mockReset();
    const executing = Promise.withResolvers<void>();
    const execute = vi.fn(() => {
      executing.resolve();
      return Effect.never;
    });
    const send = yield* makeHttpTransport().pipe(
      Effect.provideService(HttpClient.HttpClient, HttpClient.make(execute)),
    );
    for (const expiresDuringDns of [false, true]) {
      const resolving = Promise.withResolvers<void>();
      const answers = Promise.withResolvers<NodeDns.LookupAddress[]>();
      lookup.mockImplementationOnce(() => {
        resolving.resolve();
        return answers.promise;
      });
      const delivery = yield* Effect.forkChild(Effect.flip(send(input)));
      yield* Effect.promise(() => resolving.promise);
      yield* TestClock.adjust("7 seconds");
      if (!expiresDuringDns) {
        answers.resolve([{ address: "93.184.215.14", family: 4 }]);
        yield* Effect.promise(() => executing.promise);
      }
      yield* TestClock.adjust("3 seconds");
      expect((yield* Fiber.join(delivery)).message).toBe("Push delivery timed out.");
      if (expiresDuringDns) {
        answers.resolve([{ address: "93.184.215.14", family: 4 }]);
        yield* Effect.promise(() => answers.promise);
      }
    }
    expect(execute).toHaveBeenCalledTimes(1);
  }),
);

it.live(
  "connects using the supplied lookup, returns redirect headers and closes interrupted connections",
  () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const waitingForHeaders = Promise.withResolvers<void>();
      const interrupted = Promise.withResolvers<void>();
      const redirectClosed = Promise.withResolvers<void>();
      const peer = NodeHttp.createServer((request, response) => {
        paths.push(request.url!);
        if (request.url === "/redirect") {
          request.socket.once("close", redirectClosed.resolve);
          response.writeHead(307, { location: "/unexpected" });
          response.flushHeaders();
        } else if (request.url === "/pending") {
          request.socket.once("close", interrupted.resolve);
          waitingForHeaders.resolve();
        } else {
          response.end();
        }
      });
      yield* Effect.acquireRelease(
        Effect.callback<void, Error>((resume) => {
          peer.once("error", (error) => resume(Effect.fail(error)));
          peer.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () =>
          Effect.callback<void>((resume) => {
            peer.close(() => resume(Effect.void));
            peer.closeAllConnections();
          }),
      );
      const port = (peer.address() as NodeNet.AddressInfo).port;
      const hosts: string[] = [];
      const checked: NodeNet.LookupFunction = (host, options, callback) => {
        hosts.push(host);
        if (options.all) callback(null, [{ address: "127.0.0.1", family: 4 }]);
        else callback(null, "127.0.0.1", 4);
      };
      const post = (path: string) =>
        postWithCheckedLookup(
          HttpClientRequest.post(`http://push.invalid:${port}${path}`),
          checked,
        );
      expect(yield* post("/redirect")).toBe(307);
      yield* Effect.promise(() => redirectClosed.promise);
      const delivery = yield* Effect.forkChild(post("/pending"));
      yield* Effect.promise(() => waitingForHeaders.promise);
      yield* Fiber.interrupt(delivery);
      yield* Effect.promise(() => interrupted.promise);
      expect(paths).toEqual(["/redirect", "/pending"]);
      expect(hosts).toEqual(["push.invalid", "push.invalid"]);
    }).pipe(Effect.scoped),
);
