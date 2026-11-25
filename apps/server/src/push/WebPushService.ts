import {
  WEB_PUSH_EVENT_KINDS,
  type WebPushError,
  type WebPushPreferences,
  type WebPushSubscription,
  type WebPushSubscriptionDeleteInput,
  type WebPushSubscriptionId,
  type WebPushSubscriptionInput,
  type WebPushSubscriptionSummary,
  type WebPushVapidPublicKeyResult,
} from "@t3tools/contracts";
import {
  evaluatePushNotificationPolicy,
  type PushNotificationCandidateEvent,
  type PushNotificationDecision,
  type PushNotificationHistoryRecord,
  type PushNotificationPolicySettings,
} from "@t3tools/shared/pushNotificationPolicy.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";

import * as WebPushStore from "./WebPushStore.ts";
import { makeHttpTransport } from "./WebPushTransport.ts";

const MAX_HISTORY_RECORDS = 256;

const DEFAULT_WEB_PUSH_PREFERENCES: WebPushPreferences = {
  enabled: true,
  enabledKinds: [...WEB_PUSH_EVENT_KINDS],
  debounceWindowMs: 60_000,
};

export interface WebPushPayloadMessage {
  readonly title: string;
  readonly body: string;
  readonly priority: "high" | "normal";
  readonly dedupeKey: string;
  readonly kind: PushNotificationCandidateEvent["kind"];
  readonly occurredAt: string;
  readonly environmentId?: string | undefined;
  readonly projectId?: string | null | undefined;
  readonly threadId?: string | null | undefined;
}

export interface WebPushDeliveryOutcome {
  readonly status: "delivered" | "gone" | "failed";
  readonly statusCode?: number | undefined;
  readonly errorMessage?: string | undefined;
}

export type WebPushDeliveryTransport = (params: {
  readonly subscription: WebPushSubscription;
  readonly payload: WebPushPayloadMessage;
  readonly vapid: WebPushStore.VapidKeyRecord;
}) => Effect.Effect<WebPushDeliveryOutcome, WebPushError>;

export interface WebPushDispatchReport {
  readonly decision: PushNotificationDecision;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly prunedSubscriptionIds: ReadonlyArray<WebPushSubscriptionId>;
}

export type WebPushEventInput = Omit<PushNotificationCandidateEvent, "occurredAt"> & {
  readonly occurredAt?: string | number | undefined;
};

export interface WebPushServiceOptions {
  readonly initialPreferences?: WebPushPreferences | undefined;
  readonly vapidSubject?: string | undefined;
  readonly transport?: WebPushDeliveryTransport | undefined;
}

export class WebPushService extends Context.Service<
  WebPushService,
  {
    readonly getVapidPublicKey: Effect.Effect<WebPushVapidPublicKeyResult, WebPushError>;
    readonly subscribe: (
      input: WebPushSubscriptionInput,
    ) => Effect.Effect<WebPushSubscription, WebPushError>;
    readonly unsubscribe: (
      input: WebPushSubscriptionDeleteInput,
    ) => Effect.Effect<boolean, WebPushError>;
    readonly listSubscriptions: Effect.Effect<
      ReadonlyArray<WebPushSubscriptionSummary>,
      WebPushError
    >;
    readonly getPreferences: Effect.Effect<WebPushPreferences>;
    readonly setPreferences: (preferences: WebPushPreferences) => Effect.Effect<WebPushPreferences>;
    readonly notifyEvent: (
      event: WebPushEventInput,
    ) => Effect.Effect<WebPushDispatchReport, WebPushError>;
  }
>()("t3/push/WebPushService") {}

const toPolicySettings = (preferences: WebPushPreferences): PushNotificationPolicySettings => ({
  enabled: preferences.enabled,
  enabledKinds: preferences.enabledKinds,
  ...(preferences.quietHours !== undefined
    ? {
        quietHours: {
          enabled: preferences.quietHours.enabled,
          startTime: preferences.quietHours.startTime,
          endTime: preferences.quietHours.endTime,
          ...(preferences.quietHours.timeZone !== undefined
            ? { timeZone: preferences.quietHours.timeZone }
            : {}),
          ...(preferences.quietHours.allowUrgent !== undefined
            ? { allowUrgent: preferences.quietHours.allowUrgent }
            : {}),
        },
      }
    : {}),
  ...(preferences.debounceWindowMs !== undefined
    ? { debounceWindowMs: preferences.debounceWindowMs }
    : {}),
});

/** @public */
export const make = Effect.fn("WebPushService.make")(function* (
  options: WebPushServiceOptions = {},
) {
  const store = yield* WebPushStore.WebPushStore;
  const transport =
    options.transport ?? (yield* makeHttpTransport().pipe(Effect.provide(FetchHttpClient.layer)));
  let currentPreferences: WebPushPreferences =
    options.initialPreferences ?? DEFAULT_WEB_PUSH_PREFERENCES;
  const history: PushNotificationHistoryRecord[] = [];

  const recordHistory = (entry: PushNotificationHistoryRecord) => {
    history.push(entry);
    if (history.length > MAX_HISTORY_RECORDS) {
      history.splice(0, history.length - MAX_HISTORY_RECORDS);
    }
  };

  const getVapidPublicKey: WebPushService["Service"]["getVapidPublicKey"] = store.getVapidPublicKey(
    options.vapidSubject,
  );

  const subscribe: WebPushService["Service"]["subscribe"] = Effect.fn("WebPushService.subscribe")(
    function* (input) {
      return yield* store.upsertSubscription(input);
    },
  );

  const unsubscribe: WebPushService["Service"]["unsubscribe"] = Effect.fn(
    "WebPushService.unsubscribe",
  )(function* (input) {
    return yield* store.deleteSubscription(input);
  });

  const listSubscriptions: WebPushService["Service"]["listSubscriptions"] = store
    .listSubscriptions()
    .pipe(
      Effect.map((subscriptions) =>
        subscriptions.map(({ id, endpoint, deviceLabel, enabled }) => ({
          id,
          endpoint,
          deviceLabel,
          enabled,
        })),
      ),
    );

  const getPreferences: WebPushService["Service"]["getPreferences"] = Effect.sync(
    () => currentPreferences,
  );

  const setPreferences: WebPushService["Service"]["setPreferences"] = (preferences) =>
    Effect.sync(() => {
      currentPreferences = preferences;
      return currentPreferences;
    });

  const notifyEvent: WebPushService["Service"]["notifyEvent"] = Effect.fn(
    "WebPushService.notifyEvent",
  )(function* (eventInput) {
    const nowIso = DateTime.formatIso(yield* DateTime.now);
    const occurredAtIso =
      typeof eventInput.occurredAt === "string"
        ? eventInput.occurredAt
        : typeof eventInput.occurredAt === "number"
          ? DateTime.formatIso(DateTime.makeUnsafe(eventInput.occurredAt))
          : nowIso;
    const candidate: PushNotificationCandidateEvent = {
      ...eventInput,
      occurredAt: eventInput.occurredAt ?? occurredAtIso,
    };

    const decision = evaluatePushNotificationPolicy({
      event: candidate,
      settings: toPolicySettings(currentPreferences),
      history,
    });

    if (!decision.shouldSend) {
      return {
        decision,
        deliveredCount: 0,
        failedCount: 0,
        prunedSubscriptionIds: [],
      };
    }

    const subscriptions = yield* store.listSubscriptions({ enabledOnly: true });
    recordHistory({
      dedupeKey: decision.dedupeKey,
      sentAt: candidate.occurredAt,
    });

    if (subscriptions.length === 0) {
      return {
        decision,
        deliveredCount: 0,
        failedCount: 0,
        prunedSubscriptionIds: [],
      };
    }

    const vapid = yield* store.ensureVapidKeys(options.vapidSubject);
    const payload: WebPushPayloadMessage = {
      title: decision.title,
      body: decision.body,
      priority: decision.priority,
      dedupeKey: decision.dedupeKey,
      kind: candidate.kind,
      occurredAt: occurredAtIso,
      ...(candidate.environmentId !== undefined ? { environmentId: candidate.environmentId } : {}),
      ...(candidate.projectId !== undefined ? { projectId: candidate.projectId } : {}),
      ...(candidate.threadId !== undefined ? { threadId: candidate.threadId } : {}),
    };

    let deliveredCount = 0;
    let failedCount = 0;
    const prunedSubscriptionIds: WebPushSubscriptionId[] = [];

    for (const subscription of subscriptions) {
      const outcome = yield* transport({ subscription, payload, vapid }).pipe(
        Effect.catchTags({
          WebPushError: (error) =>
            Effect.succeed<WebPushDeliveryOutcome>({
              status: "failed",
              errorMessage: error.message,
            }),
        }),
      );

      if (outcome.status === "delivered") {
        deliveredCount += 1;
      } else if (outcome.status === "gone") {
        failedCount += 1;
        prunedSubscriptionIds.push(subscription.id);
        yield* store.deleteSubscription({ id: subscription.id });
      } else {
        failedCount += 1;
      }
    }

    return {
      decision,
      deliveredCount,
      failedCount,
      prunedSubscriptionIds,
    };
  });

  return WebPushService.of({
    getVapidPublicKey,
    subscribe,
    unsubscribe,
    listSubscriptions,
    getPreferences,
    setPreferences,
    notifyEvent,
  });
});

export const layer = Layer.effect(WebPushService, make());

export const layerWithOptions = (options: WebPushServiceOptions) =>
  Layer.effect(WebPushService, make(options));
