import {
  type EnvironmentId,
  WS_METHODS,
  type WebPushSubscription,
  type WebPushSubscriptionDeleteInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function upsertWebPushSubscriptionList(
  current: ReadonlyArray<WebPushSubscription>,
  next: WebPushSubscription,
): ReadonlyArray<WebPushSubscription> {
  const filtered = current.filter(
    (entry) => entry.id !== next.id && entry.endpoint !== next.endpoint,
  );
  return [next, ...filtered];
}

export function removeWebPushSubscriptionFromList(
  current: ReadonlyArray<WebPushSubscription>,
  target: WebPushSubscriptionDeleteInput,
): ReadonlyArray<WebPushSubscription> {
  return current.filter((entry) => {
    if (target.id !== undefined && entry.id === target.id) return false;
    if (target.endpoint !== undefined && entry.endpoint === target.endpoint) return false;
    return true;
  });
}

export function createWebPushEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const vapidPublicKey = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:web-push:vapid-public-key",
    tag: WS_METHODS.webPushGetVapidPublicKey,
    staleTimeMs: 60_000,
  });

  const subscriptionsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<WebPushSubscription>>([]).pipe(
      Atom.withLabel(`environment-data:web-push:subscriptions:${environmentId}`),
    ),
  );

  const subscribe = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:web-push:subscribe",
    tag: WS_METHODS.webPushSubscribe,
    onSuccess: ({ environmentId }, registry, subscription) =>
      Effect.sync(() => {
        registry.update(subscriptionsAtom(environmentId), (current) =>
          upsertWebPushSubscriptionList(current, subscription),
        );
      }),
  });

  const unsubscribe = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:web-push:unsubscribe",
    tag: WS_METHODS.webPushUnsubscribe,
    onSuccess: ({ environmentId, input }, registry, result) =>
      Effect.sync(() => {
        if (!result.removed) return;
        registry.update(subscriptionsAtom(environmentId), (current) =>
          removeWebPushSubscriptionFromList(current, input),
        );
      }),
  });

  return {
    vapidPublicKey,
    subscriptionsAtom,
    subscribe,
    unsubscribe,
  };
}
