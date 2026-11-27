import {
  EnvironmentId,
  WebPushSubscriptionId,
  type WebPushSubscription,
  type WebPushSubscriptionInput,
  type WebPushSubscriptionSummary,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const { state, subscribeRpc, unsubscribeRpc, browserUnsubscribe } = vi.hoisted(() => {
  const encodeBase64Url = (bytes: ReadonlyArray<number>) =>
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  const keyABytes = new Uint8Array([4, 1, 2, 3]);
  const keyBBytes = new Uint8Array([4, 9, 8, 7]);
  const state = {
    subscriptions: {} as Record<string, ReadonlyArray<WebPushSubscriptionSummary>>,
    vapidKeys: {} as Record<string, string>,
    browserVapidKey: encodeBase64Url([...keyABytes]) as string | null,
    keyABytes,
    keyA: encodeBase64Url([...keyABytes]),
    keyB: encodeBase64Url([...keyBBytes]),
    endpoint: "https://push.example/this-browser",
  };
  return {
    state,
    subscribeRpc: vi.fn(),
    unsubscribeRpc: vi.fn(
      async ({ environmentId, input }: { environmentId: string; input: { endpoint: string } }) => {
        state.subscriptions[environmentId] = (state.subscriptions[environmentId] ?? []).filter(
          (sub) => sub.endpoint !== input.endpoint,
        );
        return { _tag: "Success", value: { removed: true } };
      },
    ),
    browserUnsubscribe: vi.fn(async () => true),
  };
});

vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: ((atom: { kind: string; environmentId: string }) => ({
    data:
      atom.kind === "vapid"
        ? { publicKey: state.vapidKeys[atom.environmentId] ?? state.keyA }
        : (state.subscriptions[atom.environmentId] ?? []),
    isPending: false,
    isSuccess: true,
    error: null,
  })) as never,
}));

vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { kind: string }) =>
    command.kind === "subscribe" ? subscribeRpc : unsubscribeRpc) as never,
}));

vi.mock(import("../../state/webPush"), async () => {
  const { Atom } = await import("effect/reactivity");
  const Schema = await import("effect/Schema");
  const permission = Atom.make(true);
  class MockWebPushVapidKeyMismatchError extends Schema.TaggedError<MockWebPushVapidKeyMismatchError>()(
    "WebPushVapidKeyMismatchError",
    {},
  ) {
    override get message(): string {
      return "This browser already has a Web Push subscription for another environment with a different VAPID key.";
    }
  }
  const pushSubscriptionApplicationServerKey = (subscription: {
    readonly options?: {
      readonly applicationServerKey?: ArrayBuffer | ArrayBufferView | null;
    };
  }): string | null => {
    const buffer = subscription.options?.applicationServerKey;
    if (!buffer) return null;
    const bytes = ArrayBuffer.isView(buffer)
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);
    if (bytes.byteLength === 0) return null;
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  };
  return {
    WebPushVapidKeyMismatchError: MockWebPushVapidKeyMismatchError as never,
    pushSubscriptionApplicationServerKey,
    vapidPublicKeysMatch: (left: string, right: string) => left === right,
    webPushEnvironment: {
      vapidPublicKey: ({ environmentId }: { environmentId: string }) => ({
        kind: "vapid",
        environmentId,
      }),
      subscriptions: ({ environmentId }: { environmentId: string }) => ({
        kind: "subscriptions",
        environmentId,
      }),
      subscriptionsAtom: (environmentId: string) =>
        Atom.make(state.subscriptions[environmentId] ?? []),
      subscribe: { kind: "subscribe", permissionAtom: () => permission },
      unsubscribe: { kind: "unsubscribe" },
    } as never,
    detectIosSafariPwaState: () => ({
      isIos: false,
      isStandalone: false,
      needsHomeScreenInstall: false,
    }),
    getWebPushSupportStatus: () => ({
      supported: true,
      secureContext: true,
      permission: "granted",
    }),
    subscribeBrowserPush: vi.fn(async (vapidPublicKey: string) => {
      if (state.browserVapidKey !== null && state.browserVapidKey !== vapidPublicKey) {
        throw new MockWebPushVapidKeyMismatchError();
      }
      state.browserVapidKey = vapidPublicKey;
      return {
        endpoint: state.endpoint,
        keys: { p256dh: "p256dh", auth: "auth" },
      };
    }),
    unsubscribeBrowserPush: async () => {
      await browserUnsubscribe();
      return state.endpoint;
    },
    sendLocalTestPushNotification: vi.fn(),
  };
});

vi.mock(import("./settingsLayout"), () => ({
  SettingsSection: ({ children }: { children?: ReactNode }) => <section>{children}</section>,
  SettingsRow: ({ control }: { control?: ReactNode }) => <div>{control}</div>,
}));

vi.mock(import("../ui/toast"), () => ({
  stackedThreadToast: vi.fn(),
  toastManager: { add: vi.fn() } as never,
}));

import { WebPushSettingsSection } from "./WebPushSettingsSection";

const environmentA = EnvironmentId.make("environment-a");
const environmentB = EnvironmentId.make("environment-b");

function subscription(endpoint: string, enabled = true): WebPushSubscriptionSummary {
  return {
    id: WebPushSubscriptionId.make(endpoint),
    endpoint,
    deviceLabel: "Browser",
    enabled,
  };
}

function setup() {
  state.subscriptions = {
    [environmentA]: [subscription(state.endpoint)],
    [environmentB]: [],
  };
  state.vapidKeys = {
    [environmentA]: state.keyA,
    [environmentB]: state.keyA,
  };
  state.browserVapidKey = state.keyA;
  subscribeRpc.mockReset();
  subscribeRpc.mockImplementation(
    async ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: WebPushSubscriptionInput;
    }) => {
      const sub = subscription(input.endpoint);
      state.subscriptions[environmentId] = [sub];
      const value: WebPushSubscription = {
        ...sub,
        keys: input.keys,
        createdAt: "2026-11-25T00:00:00.000Z",
        updatedAt: "2026-11-25T00:00:00.000Z",
      };
      return { _tag: "Success", value };
    },
  );
  unsubscribeRpc.mockClear();
  browserUnsubscribe.mockClear();
}

describe("WebPushSettingsSection", () => {
  it("matches this device to the selected environment and disables only that registration", async () => {
    setup();
    using _registration = vi.spyOn(navigator.serviceWorker, "getRegistration").mockResolvedValue({
      pushManager: {
        getSubscription: async () => ({
          endpoint: state.endpoint,
          options: { applicationServerKey: state.keyABytes.buffer },
          unsubscribe: browserUnsubscribe,
        }),
      },
    } as unknown as ServiceWorkerRegistration);

    await using screen = await render(<WebPushSettingsSection environmentId={environmentA} />);
    await expect.element(screen.getByRole("switch")).toBeChecked();

    await screen.rerender(<WebPushSettingsSection environmentId={environmentB} />);
    await expect.element(screen.getByRole("switch")).not.toBeChecked();

    state.subscriptions[environmentB] = [
      subscription("https://push.example/another-device"),
      subscription(state.endpoint, false),
    ];
    await screen.rerender(<WebPushSettingsSection environmentId={environmentB} />);
    await expect.element(screen.getByRole("switch")).not.toBeChecked();

    state.subscriptions[environmentB] = [subscription(state.endpoint)];
    await screen.rerender(<WebPushSettingsSection environmentId={environmentB} />);
    await expect.element(screen.getByRole("switch")).toBeChecked();
    screen.getByRole("switch").element().focus();
    await userEvent.keyboard(" ");
    await expect.element(screen.getByRole("switch")).not.toBeChecked();
    expect(unsubscribeRpc).toHaveBeenCalledExactlyOnceWith({
      environmentId: environmentB,
      input: { endpoint: state.endpoint },
    });
    expect(browserUnsubscribe).not.toHaveBeenCalled();

    await screen.rerender(<WebPushSettingsSection environmentId={environmentA} />);
    await expect.element(screen.getByRole("switch")).toBeChecked();

    await screen.rerender(<WebPushSettingsSection environmentId={environmentB} />);
    await expect.element(screen.getByRole("switch")).not.toBeChecked();
    screen.getByRole("switch").element().focus();
    await userEvent.keyboard(" ");
    await expect.element(screen.getByRole("switch")).toBeChecked();
    expect(subscribeRpc).toHaveBeenCalledExactlyOnceWith({
      environmentId: environmentB,
      input: {
        endpoint: state.endpoint,
        keys: { p256dh: "p256dh", auth: "auth" },
        enabled: true,
      },
    });
  });

  it("refuses to enable a second environment with a different VAPID key and preserves the first environment", async () => {
    setup();
    state.vapidKeys[environmentB] = state.keyB;
    state.subscriptions[environmentB] = [subscription(state.endpoint)];
    using _registration = vi.spyOn(navigator.serviceWorker, "getRegistration").mockResolvedValue({
      pushManager: {
        getSubscription: async () => ({
          endpoint: state.endpoint,
          options: { applicationServerKey: state.keyABytes.buffer },
          unsubscribe: browserUnsubscribe,
        }),
      },
    } as unknown as ServiceWorkerRegistration);

    await using screen = await render(<WebPushSettingsSection environmentId={environmentA} />);
    await expect.element(screen.getByRole("switch")).toBeChecked();

    await screen.rerender(<WebPushSettingsSection environmentId={environmentB} />);
    await expect.element(screen.getByRole("switch")).not.toBeChecked();

    screen.getByRole("switch").element().focus();
    await userEvent.keyboard(" ");
    await expect.element(screen.getByText(/different VAPID key/)).toBeInTheDocument();
    await expect.element(screen.getByRole("switch")).not.toBeChecked();
    expect(subscribeRpc).not.toHaveBeenCalled();
    expect(browserUnsubscribe).not.toHaveBeenCalled();

    await screen.rerender(<WebPushSettingsSection environmentId={environmentA} />);
    await expect.element(screen.getByRole("switch")).toBeChecked();
  });
});
