import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PortSchema,
  PositiveInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";

export const ENVIRONMENT_ROLES = ["standalone", "hub", "worker"] as const;

export const EnvironmentRole = Schema.Literals(ENVIRONMENT_ROLES);
export type EnvironmentRole = typeof EnvironmentRole.Type;

export const SelfHostHubConfig = Schema.Struct({
  environmentRole: EnvironmentRole,
  hubEnvironmentId: Schema.optional(Schema.NullOr(EnvironmentId)),
  linkedEnvironmentsEnabled: Schema.Boolean,
  selfHostedHubMode: Schema.Boolean,
  host: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PortSchema),
  tailscaleServeEnabled: Schema.optional(Schema.Boolean),
  tailscaleServePort: Schema.optional(PortSchema),
  tailscaleServeUrl: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type SelfHostHubConfig = typeof SelfHostHubConfig.Type;

const PEER_NODE_HEALTH_GRADES = ["healthy", "degraded", "offline"] as const;

export const PeerNodeHealthGrade = Schema.Literals(PEER_NODE_HEALTH_GRADES);
export type PeerNodeHealthGrade = typeof PeerNodeHealthGrade.Type;

const PEER_NODE_HEALTH_DEGRADATION_REASONS = [
  "offline",
  "stale_heartbeat",
  "high_latency",
  "high_cpu",
  "high_memory",
  "worker_capacity_saturated",
] as const;

export const PeerNodeHealthDegradationReason = Schema.Literals(
  PEER_NODE_HEALTH_DEGRADATION_REASONS,
);
export type PeerNodeHealthDegradationReason = typeof PeerNodeHealthDegradationReason.Type;

export const PeerNodeScore = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));
export type PeerNodeScore = typeof PeerNodeScore.Type;

export const PeerNodeUsagePercent = Schema.Number.check(
  Schema.isBetween({ minimum: 0, maximum: 100 }),
);
export type PeerNodeUsagePercent = typeof PeerNodeUsagePercent.Type;

export const PeerNodeHealthSnapshot = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  online: Schema.Boolean,
  grade: PeerNodeHealthGrade,
  recommendedScore: PeerNodeScore,
  reasons: Schema.Array(PeerNodeHealthDegradationReason),
  latencyMs: Schema.NullOr(NonNegativeInt),
  cpuUsagePercent: Schema.optional(Schema.NullOr(PeerNodeUsagePercent)),
  memoryUsagePercent: Schema.optional(Schema.NullOr(PeerNodeUsagePercent)),
  activeWorkers: NonNegativeInt,
  maxWorkers: PositiveInt,
  availableProviders: Schema.optional(Schema.Array(ProviderDriverKind)),
  checkedAt: IsoDateTime,
  lastError: Schema.optional(Schema.NullOr(Schema.String)),
});
export type PeerNodeHealthSnapshot = typeof PeerNodeHealthSnapshot.Type;

export const PeerNodeHealthListResult = Schema.Struct({
  nodes: Schema.Array(PeerNodeHealthSnapshot),
  recommendedEnvironmentId: Schema.NullOr(EnvironmentId),
  checkedAt: IsoDateTime,
});
export type PeerNodeHealthListResult = typeof PeerNodeHealthListResult.Type;

export const WebPushSubscriptionId = TrimmedNonEmptyString.pipe(
  Schema.brand("WebPushSubscriptionId"),
);
export type WebPushSubscriptionId = typeof WebPushSubscriptionId.Type;

export const WebPushSubscriptionKeys = Schema.Struct({
  p256dh: TrimmedNonEmptyString,
  auth: TrimmedNonEmptyString,
});
export type WebPushSubscriptionKeys = typeof WebPushSubscriptionKeys.Type;

export const WebPushSubscription = Schema.Struct({
  id: WebPushSubscriptionId,
  endpoint: TrimmedNonEmptyString,
  keys: WebPushSubscriptionKeys,
  deviceLabel: Schema.NullOr(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type WebPushSubscription = typeof WebPushSubscription.Type;

export const WebPushSubscriptionInput = Schema.Struct({
  id: Schema.optional(WebPushSubscriptionId),
  endpoint: TrimmedNonEmptyString,
  keys: WebPushSubscriptionKeys,
  deviceLabel: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  enabled: Schema.optional(Schema.Boolean),
});
export type WebPushSubscriptionInput = typeof WebPushSubscriptionInput.Type;

export const WebPushSubscriptionDeleteInput = Schema.Struct({
  id: Schema.optional(WebPushSubscriptionId),
  endpoint: Schema.optional(TrimmedNonEmptyString),
});
export type WebPushSubscriptionDeleteInput = typeof WebPushSubscriptionDeleteInput.Type;

export const WEB_PUSH_EVENT_KINDS = [
  "approval_requested",
  "question_requested",
  "pm_completed",
  "repo_monitor_triggered",
  "run_failed",
] as const;

export const WebPushEventKind = Schema.Literals(WEB_PUSH_EVENT_KINDS);
export type WebPushEventKind = typeof WebPushEventKind.Type;

export const WebPushTimeOfDay = TrimmedNonEmptyString.check(
  Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
);
export type WebPushTimeOfDay = typeof WebPushTimeOfDay.Type;

export const WebPushQuietHours = Schema.Struct({
  enabled: Schema.Boolean,
  startTime: WebPushTimeOfDay,
  endTime: WebPushTimeOfDay,
  timeZone: Schema.optional(TrimmedNonEmptyString),
  allowUrgent: Schema.optional(Schema.Boolean),
});
export type WebPushQuietHours = typeof WebPushQuietHours.Type;

export const WebPushPreferences = Schema.Struct({
  enabled: Schema.Boolean,
  enabledKinds: Schema.Array(WebPushEventKind),
  quietHours: Schema.optional(WebPushQuietHours),
  debounceWindowMs: Schema.optional(NonNegativeInt),
});
export type WebPushPreferences = typeof WebPushPreferences.Type;

export const WebPushVapidPublicKeyResult = Schema.Struct({
  publicKey: TrimmedNonEmptyString,
  subject: TrimmedNonEmptyString,
});
export type WebPushVapidPublicKeyResult = typeof WebPushVapidPublicKeyResult.Type;

const WEB_PUSH_ERROR_REASONS = [
  "invalid_subscription",
  "subscription_not_found",
  "vapid_error",
  "delivery_failed",
  "storage",
] as const;

export const WebPushErrorReason = Schema.Literals(WEB_PUSH_ERROR_REASONS);
export type WebPushErrorReason = typeof WebPushErrorReason.Type;

export class WebPushError extends Schema.TaggedError<WebPushError>()("WebPushError", {
  reason: WebPushErrorReason,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
