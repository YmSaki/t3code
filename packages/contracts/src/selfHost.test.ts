import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ENVIRONMENT_ROLES,
  EnvironmentRole,
  PeerNodeHealthListResult,
  PeerNodeHealthSnapshot,
  SelfHostHubConfig,
  WEB_PUSH_EVENT_KINDS,
  WebPushError,
  WebPushPreferences,
  WebPushSubscription,
  WebPushSubscriptionDeleteInput,
  WebPushSubscriptionId,
  WebPushSubscriptionInput,
  WebPushVapidPublicKeyResult,
} from "./selfHost.ts";

const decodeEnvironmentRole = Schema.decodeUnknownSync(EnvironmentRole);
const decodeSelfHostHubConfig = Schema.decodeUnknownSync(SelfHostHubConfig);
const decodePeerNodeHealthSnapshot = Schema.decodeUnknownSync(PeerNodeHealthSnapshot);
const decodePeerNodeHealthListResult = Schema.decodeUnknownSync(PeerNodeHealthListResult);
const decodeWebPushSubscriptionId = Schema.decodeUnknownSync(WebPushSubscriptionId);
const decodeWebPushSubscription = Schema.decodeUnknownSync(WebPushSubscription);
const decodeWebPushSubscriptionInput = Schema.decodeUnknownSync(WebPushSubscriptionInput);
const decodeWebPushSubscriptionDeleteInput = Schema.decodeUnknownSync(
  WebPushSubscriptionDeleteInput,
);
const decodeWebPushPreferences = Schema.decodeUnknownSync(WebPushPreferences);
const decodeWebPushVapidPublicKeyResult = Schema.decodeUnknownSync(WebPushVapidPublicKeyResult);
const encodeWebPushError = Schema.encodeSync(WebPushError);
const decodeWebPushError = Schema.decodeUnknownSync(WebPushError);

describe("selfHost contracts", () => {
  it("validates EnvironmentRole literals", () => {
    for (const role of ENVIRONMENT_ROLES) {
      expect(decodeEnvironmentRole(role)).toBe(role);
    }
    expect(() => decodeEnvironmentRole("invalid_role")).toThrow();
  });

  it("decodes SelfHostHubConfig for hub and worker profiles", () => {
    const hub = decodeSelfHostHubConfig({
      environmentRole: "hub",
      hubEnvironmentId: null,
      linkedEnvironmentsEnabled: true,
      selfHostedHubMode: true,
      host: " 127.0.0.1 ",
      port: 3773,
      tailscaleServeEnabled: true,
      tailscaleServePort: 443,
      tailscaleServeUrl: " https://hub.tailnet.ts.net ",
    });
    expect(hub.host).toBe("127.0.0.1");
    expect(hub.tailscaleServeUrl).toBe("https://hub.tailnet.ts.net");

    const worker = decodeSelfHostHubConfig({
      environmentRole: "worker",
      hubEnvironmentId: " env-hub-1 ",
      linkedEnvironmentsEnabled: true,
      selfHostedHubMode: false,
    });
    expect(worker.hubEnvironmentId).toBe("env-hub-1");
    expect(() =>
      decodeSelfHostHubConfig({
        environmentRole: "hub",
        linkedEnvironmentsEnabled: true,
        selfHostedHubMode: true,
        port: 70000,
      }),
    ).toThrow();
  });

  it("decodes PeerNodeHealthSnapshot and PeerNodeHealthListResult", () => {
    const snapshot = decodePeerNodeHealthSnapshot({
      environmentId: " env-worker-1 ",
      label: "Linux Worker 1",
      online: true,
      grade: "healthy",
      recommendedScore: 88,
      reasons: [],
      latencyMs: 42,
      cpuUsagePercent: 25.5,
      memoryUsagePercent: 40,
      activeWorkers: 1,
      maxWorkers: 8,
      availableProviders: ["codex", "claudeAgent"],
      checkedAt: "2026-11-22T12:00:00.000Z",
      lastError: null,
    });
    expect(snapshot.environmentId).toBe("env-worker-1");
    expect(snapshot.recommendedScore).toBe(88);

    const list = decodePeerNodeHealthListResult({
      nodes: [snapshot],
      recommendedEnvironmentId: " env-worker-1 ",
      checkedAt: "2026-11-22T12:00:00.000Z",
    });
    expect(list.nodes).toHaveLength(1);
    expect(list.recommendedEnvironmentId).toBe("env-worker-1");

    expect(() =>
      decodePeerNodeHealthSnapshot({
        ...snapshot,
        recommendedScore: 105,
      }),
    ).toThrow();
  });

  it("decodes WebPushSubscription, inputs, preferences, VAPID key, and WebPushError", () => {
    expect(decodeWebPushSubscriptionId(" sub-1 ")).toBe("sub-1");
    expect(() => decodeWebPushSubscriptionId("   ")).toThrow();

    const sub = decodeWebPushSubscription({
      id: " sub-1 ",
      endpoint: " https://fcm.googleapis.com/fcm/send/abc ",
      keys: {
        p256dh: " key-p256dh ",
        auth: " key-auth ",
      },
      deviceLabel: " Pixel 9 ",
      enabled: true,
      createdAt: "2026-11-22T12:00:00.000Z",
      updatedAt: "2026-11-22T12:00:00.000Z",
    });
    expect(sub.id).toBe("sub-1");
    expect(sub.endpoint).toBe("https://fcm.googleapis.com/fcm/send/abc");
    expect(sub.deviceLabel).toBe("Pixel 9");

    const input = decodeWebPushSubscriptionInput({
      endpoint: " https://push.example.com/sub/1 ",
      keys: { p256dh: "p256", auth: "auth" },
    });
    expect(input.endpoint).toBe("https://push.example.com/sub/1");

    const del = decodeWebPushSubscriptionDeleteInput({
      id: " sub-1 ",
    });
    expect(del.id).toBe("sub-1");

    const prefs = decodeWebPushPreferences({
      enabled: true,
      enabledKinds: [...WEB_PUSH_EVENT_KINDS],
      quietHours: {
        enabled: true,
        startTime: "22:00",
        endTime: "07:00",
        timeZone: "Asia/Tokyo",
        allowUrgent: true,
      },
      debounceWindowMs: 60_000,
    });
    expect(prefs.enabledKinds).toHaveLength(5);

    expect(() =>
      decodeWebPushPreferences({
        enabled: true,
        enabledKinds: ["approval_requested"],
        quietHours: {
          enabled: true,
          startTime: "25:00",
          endTime: "07:00",
        },
      }),
    ).toThrow();

    const vapid = decodeWebPushVapidPublicKeyResult({
      publicKey:
        " BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM ",
      subject: " mailto:admin@example.com ",
    });
    expect(vapid.subject).toBe("mailto:admin@example.com");

    const err = new WebPushError({
      reason: "delivery_failed",
      message: "Push endpoint returned 410 Gone",
    });
    const encoded = encodeWebPushError(err);
    const decoded = decodeWebPushError(encoded);
    expect(decoded.reason).toBe("delivery_failed");
    expect(decoded.message).toBe("Push endpoint returned 410 Gone");
  });
});
