import {
  EnvironmentId,
  WebPushSubscriptionId,
  type WebPushSubscription,
  type WebPushSubscriptionInput,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const { state, subscribeRpc, unsubscribeRpc, browserUnsubscribe } = vi.hoisted(() => {
  const state = {
    subscriptions: {} as Record<string, ReadonlyArray<WebPushSubscription>>,
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
        ? { publicKey: "vapid-key" }
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
  const permission = Atom.make(true);
  return {
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
    subscribeBrowserPush: vi.fn(async () => ({
      endpoint: state.endpoint,
      keys: { p256dh: "p256dh", auth: "auth" },
    })),
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

function subscription(endpoint: string, enabled = true): WebPushSubscription {
  return {
    id: WebPushSubscriptionId.make(endpoint),
    endpoint,
    keys: { p256dh: "p256dh", auth: "auth" },
    deviceLabel: "Browser",
    enabled,
    createdAt: "2026-11-25T00:00:00.000Z",
    updatedAt: "2026-11-25T00:00:00.000Z",
  };
}

function setup() {
  state.subscriptions = {
    [environmentA]: [subscription(state.endpoint)],
    [environmentB]: [],
  };
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
      return { _tag: "Success", value: sub };
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
});
