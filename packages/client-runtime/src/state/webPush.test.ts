import {
  AuthSettingsWriteScope,
  EnvironmentId,
  WS_METHODS,
  WebPushSubscriptionId,
  type AuthSessionState,
  type WebPushSubscription,
  type WebPushSubscriptionInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { AVAILABLE_CONNECTION_STATE, type PreparedConnection } from "../connection/model.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import { awaitAtomResult, runAtomCommand } from "./runtime.ts";
import {
  createWebPushEnvironmentAtoms,
  removeWebPushSubscriptionFromList,
  upsertWebPushSubscriptionList,
} from "./webPush.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: mockSessions }),
}));

const mockSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const envId = EnvironmentId.make("env-web-push");

const createTestWebPushAtoms = Effect.gen(function* () {
  const stored = new Map<string, WebPushSubscription>();
  const client = {
    [WS_METHODS.webPushGetVapidPublicKey]: () =>
      Effect.succeed({
        publicKey:
          "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U",
        subject: "mailto:admin@example.com",
      }),
    [WS_METHODS.webPushSubscribe]: (input: WebPushSubscriptionInput) =>
      Effect.sync(() => {
        const sub: WebPushSubscription = {
          id: input.id ?? WebPushSubscriptionId.make("sub-1"),
          endpoint: input.endpoint,
          keys: input.keys,
          deviceLabel: input.deviceLabel ?? null,
          enabled: input.enabled ?? true,
          createdAt: "2026-11-22T00:00:00.000Z",
          updatedAt: "2026-11-22T00:00:00.000Z",
        };
        stored.set(sub.endpoint, sub);
        return sub;
      }),
    [WS_METHODS.webPushUnsubscribe]: ({ endpoint }: { endpoint?: string }) =>
      Effect.sync(() => ({
        removed: endpoint !== undefined ? stored.delete(endpoint) : false,
      })),
  } as unknown as RpcSession["client"];

  const supervisor = EnvironmentSupervisor.of({
    target: { environmentId: envId, label: "WebPush Env" },
    session: yield* SubscriptionRef.make(Option.some({ client } as unknown as RpcSession)),
    state: yield* SubscriptionRef.make({
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    }),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } as unknown as EnvironmentSupervisor["Service"]);

  const registryService = EnvironmentRegistry.of({
    run: (_id, effect) =>
      effect.pipe(
        Effect.provideService(EnvironmentSupervisor, supervisor),
        Effect.provideService(RpcPermissionGuard, {
          authorize: () => Effect.void,
        }),
      ),
    followStream: (_id, stream) => Stream.provideService(stream, EnvironmentSupervisor, supervisor),
  } as Pick<
    EnvironmentRegistry["Service"],
    "run" | "followStream"
  > as EnvironmentRegistry["Service"]);

  const runtime = Atom.runtime(Layer.succeed(EnvironmentRegistry, registryService));

  return createWebPushEnvironmentAtoms(runtime);
});

describe("createWebPushEnvironmentAtoms", () => {
  it("upserts and removes subscriptions purely", () => {
    const first: WebPushSubscription = {
      id: WebPushSubscriptionId.make("sub-1"),
      endpoint: "https://push.example/1",
      keys: { p256dh: "k1", auth: "a1" },
      deviceLabel: "Phone",
      enabled: true,
      createdAt: "2026-11-22T00:00:00.000Z",
      updatedAt: "2026-11-22T00:00:00.000Z",
    };
    const updated: WebPushSubscription = {
      ...first,
      deviceLabel: "Updated Phone",
    };
    const list = upsertWebPushSubscriptionList([first], updated);
    expect(list).toHaveLength(1);
    expect(list[0]?.deviceLabel).toBe("Updated Phone");
    expect(removeWebPushSubscriptionFromList(list, { id: first.id })).toEqual([]);
  });

  it.effect("reads VAPID key and tracks subscribe/unsubscribe in session atom", () =>
    Effect.gen(function* () {
      const atoms = yield* createTestWebPushAtoms;
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (r) => Effect.sync(() => r.dispose()),
      );
      registry.mount(mockSessions(envId));
      registry.set(
        mockSessions(envId),
        AsyncResult.success({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: [],
            sessionMethods: [],
            sessionCookieName: "test",
          },
          scopes: [AuthSettingsWriteScope],
          permissions: [AuthSettingsWriteScope],
        }),
      );

      const vapidAtom = atoms.vapidPublicKey({ environmentId: envId, input: {} });
      yield* AtomRegistry.mount(registry, vapidAtom);
      const vapid = yield* awaitAtomResult(registry, vapidAtom);
      expect(vapid.subject).toBe("mailto:admin@example.com");

      const subsAtom = atoms.subscriptionsAtom(envId);
      yield* AtomRegistry.mount(registry, subsAtom);
      expect(registry.get(subsAtom)).toEqual([]);

      const subscribeExit = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.subscribe, {
          environmentId: envId,
          input: {
            endpoint: "https://push.example/device-1",
            keys: { p256dh: "p256", auth: "auth" },
            deviceLabel: "Safari PWA",
          },
        }),
      );
      expect(subscribeExit._tag).toBe("Success");
      expect(registry.get(subsAtom)).toHaveLength(1);
      expect(registry.get(subsAtom)[0]?.deviceLabel).toBe("Safari PWA");

      const unsubscribeExit = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.unsubscribe, {
          environmentId: envId,
          input: { endpoint: "https://push.example/device-1" },
        }),
      );
      expect(unsubscribeExit._tag).toBe("Success");
      expect(registry.get(subsAtom)).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
