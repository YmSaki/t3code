// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as PlatformNodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import { RepoMonitorSnapshotSource } from "./RepoMonitorRuntimeWiring.ts";
import { RepoMonitorService } from "./RepoMonitorService.ts";
import { makeRepoMonitorWebhookHandler } from "./RepoMonitorWebhookRoute.ts";

const SECRET = "test-repo-monitor-secret";

function signGitHub(body: string, secret: string): string {
  return `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;
}

function makeTestHandler(ingested: Array<unknown>) {
  const routeLayer = HttpRouter.add(
    "POST",
    "/api/repo-monitor/webhook/:projectId",
    makeRepoMonitorWebhookHandler(() => SECRET).pipe(Effect.orDie),
  );
  const serviceLayer = Layer.mock(RepoMonitorService)({
    ingestWebhookEvent: (input) =>
      Effect.sync(() => {
        ingested.push(input);
        return [];
      }),
  });
  const sourceLayer = Layer.mock(RepoMonitorSnapshotSource)({
    lastSelfAccountLogins: () => Effect.succeed([]),
  });
  const runtimeLayer = Layer.mergeAll(serviceLayer, sourceLayer, PlatformNodeCrypto.layer);
  return {
    webHandler: HttpRouter.toWebHandler(routeLayer.pipe(Layer.provide(runtimeLayer))),
    runtimeLayer,
  };
}

it.effect("returns 401 on invalid signature, 202 on ignored event, and 200 on valid push", () =>
  Effect.gen(function* () {
    const ingested: Array<unknown> = [];
    const {
      webHandler: { handler, dispose },
      runtimeLayer,
    } = makeTestHandler(ingested);
    const ctx = yield* Layer.build(runtimeLayer);
    try {
      const payload = JSON.stringify({
        ref: "refs/heads/main",
        after: "abc123",
        sender: { login: "alice", type: "User" },
      });

      const badRes = yield* Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/repo-monitor/webhook/${ProjectId.make("proj:1")}`, {
            method: "POST",
            headers: {
              "x-github-event": "push",
              "x-hub-signature-256": "sha256=deadbeef",
            },
            body: payload,
          }),
          ctx,
        ),
      );
      expect(badRes.status).toBe(401);

      const ignoredRes = yield* Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/repo-monitor/webhook/${ProjectId.make("proj:1")}`, {
            method: "POST",
            headers: {
              "x-github-event": "ping",
              "x-hub-signature-256": signGitHub("{}", SECRET),
            },
            body: "{}",
          }),
          ctx,
        ),
      );
      expect(ignoredRes.status).toBe(202);

      const okRes = yield* Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/repo-monitor/webhook/${ProjectId.make("proj:1")}`, {
            method: "POST",
            headers: {
              "x-github-event": "push",
              "x-hub-signature-256": signGitHub(payload, SECRET),
            },
            body: payload,
          }),
          ctx,
        ),
      );
      expect(okRes.status).toBe(200);
      expect(ingested).toHaveLength(1);
    } finally {
      yield* Effect.promise(() => dispose());
    }
  }),
);
