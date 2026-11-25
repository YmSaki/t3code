import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createWebPushEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const vapidPublicKey = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:web-push:vapid-public-key",
    tag: WS_METHODS.webPushGetVapidPublicKey,
    staleTimeMs: 60_000,
  });

  const subscriptions = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:web-push:subscriptions",
    tag: WS_METHODS.webPushListSubscriptions,
    staleTimeMs: 0,
  });

  const subscribe = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:web-push:subscribe",
    tag: WS_METHODS.webPushSubscribe,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.refresh(subscriptions({ environmentId, input: {} }));
      }),
  });

  const unsubscribe = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:web-push:unsubscribe",
    tag: WS_METHODS.webPushUnsubscribe,
    onSuccess: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.refresh(subscriptions({ environmentId, input: {} }));
      }),
  });

  return {
    vapidPublicKey,
    subscriptions,
    subscribe,
    unsubscribe,
  };
}
