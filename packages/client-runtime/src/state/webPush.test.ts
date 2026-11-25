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
import { createWebPushEnvironmentAtoms } from "./webPush.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: mockSessions }),
}));

const mockSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);

const envId = EnvironmentId.make("env-web-push");
const otherEnvId = EnvironmentId.make("env-other");
const persistedSubscription: WebPushSubscription = {
  id: WebPushSubscriptionId.make("sub-persisted"),
  endpoint: "https://push.example/persisted",
  keys: { p256dh: "p256-persisted", auth: "auth-persisted" },
  deviceLabel: "Existing browser",
  enabled: true,
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
};

const createTestWebPushAtoms = Effect.gen(function* () {
  const stored = new Map([[persistedSubscription.endpoint, persistedSubscription]]);
  const client = {
    [WS_METHODS.webPushListSubscriptions]: () => Effect.sync(() => [...stored.values()]),
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

  const otherSession = yield* SubscriptionRef.make(
    Option.some({
      client: {
        [WS_METHODS.webPushListSubscriptions]: () => Effect.succeed([]),
      },
    } as unknown as RpcSession),
  );
  const registryService = EnvironmentRegistry.of({
    run: (id, effect) =>
      effect.pipe(
        Effect.provideService(
          EnvironmentSupervisor,
          id === otherEnvId
            ? {
                ...supervisor,
                target: { environmentId: otherEnvId, label: "Other Env" },
                session: otherSession,
              }
            : supervisor,
        ),
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
  it.effect("loads persisted subscriptions per environment and refreshes after changes", () =>
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

      const subsAtom = atoms.subscriptions({ environmentId: envId, input: {} });
      yield* AtomRegistry.mount(registry, subsAtom);
      expect(yield* awaitAtomResult(registry, subsAtom)).toEqual([persistedSubscription]);
      const otherSubsAtom = atoms.subscriptions({ environmentId: otherEnvId, input: {} });
      yield* AtomRegistry.mount(registry, otherSubsAtom);
      expect(yield* awaitAtomResult(registry, otherSubsAtom)).toEqual([]);

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
      const subscriptions = yield* awaitAtomResult(registry, subsAtom);
      expect(subscriptions).toHaveLength(2);
      expect(subscriptions.find((sub) => sub.deviceLabel === "Safari PWA")).toBeDefined();
      expect(yield* awaitAtomResult(registry, otherSubsAtom)).toEqual([]);

      const reloadedRegistry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (r) => Effect.sync(() => r.dispose()),
      );
      expect(yield* awaitAtomResult(reloadedRegistry, subsAtom)).toEqual(subscriptions);

      const unsubscribeExit = yield* Effect.promise(() =>
        runAtomCommand(registry, atoms.unsubscribe, {
          environmentId: envId,
          input: { endpoint: "https://push.example/device-1" },
        }),
      );
      expect(unsubscribeExit._tag).toBe("Success");
      expect(yield* awaitAtomResult(registry, subsAtom)).toEqual([persistedSubscription]);
    }).pipe(Effect.scoped),
  );
});
