import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: {},
}));

vi.mock("@t3tools/client-runtime/state/webPush", () => ({
  createWebPushEnvironmentAtoms: () => ({}),
}));

import {
  pushSubscriptionApplicationServerKey,
  subscribeBrowserPush,
  vapidPublicKeysMatch,
  WebPushVapidKeyMismatchError,
} from "./webPush";

function base64UrlFromBytes(bytes: ReadonlyArray<number>): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

const KEY_A_BYTES = new Uint8Array([4, 1, 2, 3, 4, 5, 6, 7]);
const KEY_B_BYTES = new Uint8Array([4, 9, 8, 7, 6, 5, 4, 3]);
const KEY_A = base64UrlFromBytes([...KEY_A_BYTES]);
const KEY_B = base64UrlFromBytes([...KEY_B_BYTES]);

function makePushSubscription(
  endpoint: string,
  applicationServerKey: ArrayBuffer | Uint8Array | null,
  unsubscribe = vi.fn(async () => true),
) {
  return {
    endpoint,
    options: { applicationServerKey },
    unsubscribe,
    getKey: (name: "p256dh" | "auth") =>
      name === "p256dh" ? new Uint8Array([1, 2, 3]).buffer : new Uint8Array([4, 5, 6]).buffer,
  };
}

function setupBrowserPush(existing: ReturnType<typeof makePushSubscription> | null) {
  const subscribe = vi.fn(async () =>
    makePushSubscription("https://push.example/new", KEY_B_BYTES),
  );
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => existing),
      subscribe,
    },
  };
  vi.stubGlobal("window", {
    isSecureContext: true,
    PushManager: {},
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("Notification", {
    permission: "granted",
    requestPermission: vi.fn(async () => "granted"),
  });
  vi.stubGlobal("navigator", {
    userAgent: "Chrome",
    platform: "Win32",
    maxTouchPoints: 0,
    serviceWorker: {
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  });
  return { subscribe };
}

describe("vapidPublicKeysMatch", () => {
  it("matches equivalent base64url keys regardless of padding and rejects different or invalid keys", () => {
    expect(vapidPublicKeysMatch(KEY_A, `${KEY_A}=`)).toBe(true);
    expect(vapidPublicKeysMatch(KEY_A, KEY_B)).toBe(false);
    expect(vapidPublicKeysMatch("", KEY_A)).toBe(false);
    expect(vapidPublicKeysMatch("not-valid-base64!", KEY_A)).toBe(false);
  });
});

describe("subscribeBrowserPush", () => {
  it("reuses an existing subscription whose applicationServerKey matches the target VAPID key", async () => {
    const unsubscribe = vi.fn(async () => true);
    const existing = makePushSubscription(
      "https://push.example/env-a",
      KEY_A_BYTES.buffer,
      unsubscribe,
    );
    const { subscribe } = setupBrowserPush(existing);

    const result = await subscribeBrowserPush(KEY_A);
    expect(result).toEqual({
      endpoint: "https://push.example/env-a",
      keys: {
        p256dh: base64UrlFromBytes([1, 2, 3]),
        auth: base64UrlFromBytes([4, 5, 6]),
      },
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(unsubscribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects without unsubscribing when the existing browser subscription uses a different VAPID key", async () => {
    const unsubscribe = vi.fn(async () => true);
    const existing = makePushSubscription(
      "https://push.example/env-a",
      KEY_A_BYTES.buffer,
      unsubscribe,
    );
    const { subscribe } = setupBrowserPush(existing);

    await expect(subscribeBrowserPush(KEY_B)).rejects.toBeInstanceOf(WebPushVapidKeyMismatchError);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("rejects when the existing browser subscription exposes no applicationServerKey", async () => {
    const unsubscribe = vi.fn(async () => true);
    const existing = makePushSubscription("https://push.example/env-a", null, unsubscribe);
    const { subscribe } = setupBrowserPush(existing);

    await expect(subscribeBrowserPush(KEY_B)).rejects.toBeInstanceOf(WebPushVapidKeyMismatchError);
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("creates a new subscription with the decoded VAPID key when none exists", async () => {
    const { subscribe } = setupBrowserPush(null);

    const result = await subscribeBrowserPush(KEY_B);
    expect(result.endpoint).toBe("https://push.example/new");
    expect(subscribe).toHaveBeenCalledExactlyOnceWith({
      userVisibleOnly: true,
      applicationServerKey: KEY_B_BYTES,
    });
    expect(
      pushSubscriptionApplicationServerKey({
        options: { applicationServerKey: KEY_B_BYTES.buffer },
      }),
    ).toBe(KEY_B);
    vi.unstubAllGlobals();
  });
});
