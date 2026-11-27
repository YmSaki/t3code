import { createWebPushEnvironmentAtoms } from "@t3tools/client-runtime/state/webPush";
import type { WebPushSubscriptionKeys } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { connectionAtomRuntime } from "../connection/runtime";

export const webPushEnvironment = createWebPushEnvironmentAtoms(connectionAtomRuntime);

export interface IosSafariPwaStatus {
  readonly isIos: boolean;
  readonly isStandalone: boolean;
  readonly needsHomeScreenInstall: boolean;
}

export interface WebPushSupportStatus {
  readonly supported: boolean;
  readonly secureContext: boolean;
  readonly permission: NotificationPermission | "unsupported";
}

export interface BrowserPushSubscriptionPayload {
  readonly endpoint: string;
  readonly keys: WebPushSubscriptionKeys;
}

function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replaceAll("-", "+").replaceAll("_", "/");
  const raw = atob(base64);
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index);
  }
  return bytes;
}

function arrayBufferToBase64Url(buffer: ArrayBuffer | null): string {
  if (buffer === null) return "";
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeVapidKeyBytes(base64Url: string): Uint8Array<ArrayBuffer> | null {
  if (base64Url.length === 0) return null;
  try {
    return urlBase64ToUint8Array(base64Url);
  } catch {
    return null;
  }
}

function applicationServerKeyBytes(
  rawKey: ArrayBuffer | ArrayBufferView | null | undefined,
): Uint8Array | null {
  if (!rawKey) return null;
  if (ArrayBuffer.isView(rawKey)) {
    return new Uint8Array(rawKey.buffer, rawKey.byteOffset, rawKey.byteLength);
  }
  if (
    rawKey instanceof ArrayBuffer ||
    Object.prototype.toString.call(rawKey) === "[object ArrayBuffer]"
  ) {
    return new Uint8Array(rawKey);
  }
  return null;
}

export class WebPushVapidKeyMismatchError extends Schema.TaggedError<WebPushVapidKeyMismatchError>()(
  "WebPushVapidKeyMismatchError",
  {},
) {
  override get message(): string {
    return "This browser already has a Web Push subscription for another environment with a different VAPID key.";
  }
}

export function pushSubscriptionApplicationServerKey(subscription: {
  readonly options?: {
    readonly applicationServerKey?: ArrayBuffer | ArrayBufferView | null;
  };
}): string | null {
  const bytes = applicationServerKeyBytes(subscription.options?.applicationServerKey);
  if (!bytes || bytes.byteLength === 0) return null;
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 1) {
    binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function vapidPublicKeysMatch(left: string, right: string): boolean {
  const leftBytes = decodeVapidKeyBytes(left);
  const rightBytes = decodeVapidKeyBytes(right);
  if (
    leftBytes === null ||
    rightBytes === null ||
    leftBytes.byteLength === 0 ||
    leftBytes.byteLength !== rightBytes.byteLength
  ) {
    return false;
  }
  for (let index = 0; index < leftBytes.byteLength; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

export function detectIosSafariPwaState(): IosSafariPwaStatus {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { isIos: false, isStandalone: false, needsHomeScreenInstall: false };
  }
  const userAgent = navigator.userAgent;
  const isIos =
    /iPad|iPhone|iPod/u.test(userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const navigatorWithStandalone = navigator as Navigator & { readonly standalone?: boolean };
  const isStandalone =
    navigatorWithStandalone.standalone === true ||
    window.matchMedia("(display-mode: standalone)").matches;
  return {
    isIos,
    isStandalone,
    needsHomeScreenInstall: isIos && !isStandalone,
  };
}

export function getWebPushSupportStatus(): WebPushSupportStatus {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { supported: false, secureContext: false, permission: "unsupported" };
  }
  const secureContext = window.isSecureContext;
  const hasNotification = typeof Notification !== "undefined";
  const supported =
    secureContext && hasNotification && "serviceWorker" in navigator && "PushManager" in window;
  return {
    supported,
    secureContext,
    permission: hasNotification ? Notification.permission : "unsupported",
  };
}

async function registerWebPushServiceWorker(swUrl = "/sw.js"): Promise<ServiceWorkerRegistration> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    throw new Error("Service workers are not supported in this browser.");
  }
  await navigator.serviceWorker.register(swUrl, { scope: "/" });
  return navigator.serviceWorker.ready;
}

export async function subscribeBrowserPush(
  vapidPublicKey: string,
): Promise<BrowserPushSubscriptionPayload> {
  const support = getWebPushSupportStatus();
  if (!support.supported) {
    throw new Error("Web Push requires HTTPS and a browser with Service Worker support.");
  }
  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  const registration = await registerWebPushServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    const existingKey = pushSubscriptionApplicationServerKey(existing);
    // Replacing an existing browser subscription would silently break another environment on this origin.
    if (existingKey === null || !vapidPublicKeysMatch(existingKey, vapidPublicKey)) {
      throw new WebPushVapidKeyMismatchError();
    }
  }
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    }));

  const p256dh = arrayBufferToBase64Url(subscription.getKey("p256dh"));
  const auth = arrayBufferToBase64Url(subscription.getKey("auth"));
  if (p256dh.length === 0 || auth.length === 0) {
    throw new Error("Browser push subscription did not include encryption keys.");
  }

  return {
    endpoint: subscription.endpoint,
    keys: { p256dh, auth },
  };
}

export async function sendLocalTestPushNotification(
  title: string,
  body: string,
  url = "/settings/connections",
): Promise<void> {
  const support = getWebPushSupportStatus();
  if (!support.supported) {
    throw new Error("Web Push notifications are unavailable in this browser context.");
  }
  const permission =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }
  const registration = await registerWebPushServiceWorker();
  await registration.showNotification(title, {
    body,
    icon: "/icon-192x192.png",
    badge: "/icon-192x192.png",
    tag: "t3code-web-push-test",
    data: { url },
  });
}
