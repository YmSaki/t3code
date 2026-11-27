import { EnvironmentId, type EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render, act } from "../../../test/render";

const { state, authListeners, setAuth, reconcileCloudState } = vi.hoisted(() => {
  const authListeners = new Set<() => void>();
  const state = {
    authSnapshot: {
      isLoaded: true,
      isSignedIn: false,
      userId: null as string | null,
    },
    linkStateData: null as EnvironmentCloudLinkStateResult | null,
  };
  return {
    state,
    authListeners,
    setAuth: (next: {
      readonly isLoaded: boolean;
      readonly isSignedIn: boolean;
      readonly userId: string | null;
    }) => {
      state.authSnapshot = next;
      for (const listener of authListeners) listener();
    },
    reconcileCloudState: vi.fn(async () => true),
  };
});

vi.mock(import("@clerk/react"), async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useAuth: (() =>
      useSyncExternalStore(
        (listener) => {
          authListeners.add(listener);
          return () => authListeners.delete(listener);
        },
        () => state.authSnapshot,
      )) as never,
  };
});

vi.mock(import("../../hooks/useSettings"), () => ({
  useUpdatePrimarySettings: () => vi.fn(),
}));

vi.mock(import("../../hostedPairing"), () => ({
  isHostedStaticApp: () => false,
}));

vi.mock(import("../../state/environments"), () => {
  const environmentId = EnvironmentId.make("env-1");
  return {
    useEnvironments: (() => ({ environments: [], isReady: true })) as never,
    usePrimaryEnvironmentId: () => environmentId,
    usePrimaryEnvironment: (() => ({
      environmentId,
      serverConfig: { settings: { requireConnectDeviceApproval: false } },
    })) as never,
  };
});

vi.mock(import("../../state/managedPolicy"), () => ({
  usePrimaryManagedPolicy: () => undefined,
}));

vi.mock(import("../../state/session"), async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const sessionAtom = Atom.make(
    AsyncResult.success({
      authenticated: true,
      authMethod: "bearer",
      role: "owner",
      scopes: ["relay:read", "relay:write"],
      clientId: "client-1",
    }),
  );
  return {
    environmentSession: { sessionStateAtom: () => sessionAtom } as never,
    readEnvironmentCanConfigureRelay: () => true,
    readEnvironmentScope: () => true,
    useEnvironmentCanConfigureRelay: () => true,
    useEnvironmentScope: () => true,
  };
});

vi.mock(import("../clerk/T3ConnectAccountPages"), () => ({
  useT3ConnectAccountPage: () => ({ open: null, portals: null }),
}));

vi.mock(import("./CloudEnvironmentConnectList"), () => ({
  CloudEnvironmentConnectRows: () => <div data-testid="devices-list" />,
}));

vi.mock(import("./TunnelUsage"), () => ({
  TunnelLimitAlert: (() => null) as never,
}));

vi.mock(import("../../cloud/managedRelayState"), () => ({
  useManagedTunnelUsage: (() => ({ upgrade: null })) as never,
}));

vi.mock(import("../../cloud/publicConfig"), () => ({
  hasCloudPublicConfig: () => true,
  resolveCloudPublicConfig: () => ({
    clerkPublishableKey: "pk_test",
    clerkJwtTemplate: "t3-relay",
    relayUrl: "https://relay.example.test/",
    relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
  }),
}));

vi.mock(import("../../cloud/useCloudLinkController"), () => ({
  useCloudLinkController: () =>
    ({
      isSignedIn: state.authSnapshot.isSignedIn,
      linkState: {
        target: { environmentId: EnvironmentId.make("env-1") },
        data: state.linkStateData,
        error: null,
        refresh: vi.fn(),
      },
      linked: state.linkStateData?.linked ?? false,
      linkRevoked: false,
      managedTunnelActive: state.linkStateData?.managedTunnelActive ?? false,
      managedTunnelOutOfSync: false,
      publishAgentActivity: state.linkStateData?.publishAgentActivity ?? false,
      holdWebhooksWhileOffline: false,
      operationError: null,
      tunnelLimit: null,
      needsRelayConfiguration: () => false,
      reconcileCloudState,
    }) as never,
}));

vi.mock(import("../ui/toast"), () => ({
  toastManager: { add: vi.fn() } as never,
}));

import { ConnectOnboardingDialog } from "./ConnectOnboardingDialog";

function setup(linkStateData: EnvironmentCloudLinkStateResult) {
  window.localStorage.clear();
  setAuth({ isLoaded: true, isSignedIn: false, userId: null });
  state.linkStateData = linkStateData;
  reconcileCloudState.mockReset();
  reconcileCloudState.mockResolvedValue(true);
}

async function signIn() {
  await act(() => {
    setAuth({ isLoaded: true, isSignedIn: true, userId: "user-1" });
  });
}

describe("ConnectOnboardingDialog", () => {
  it("defaults tunnel exposure and activity sharing off and discloses the relay host and shared fields", async () => {
    setup({
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    });
    await using _screen = await render(<ConnectOnboardingDialog />);
    await signIn();

    const publishSwitch = page.getByRole("switch", { name: "Publish this environment" });
    const activitySwitch = page.getByRole("switch", { name: "Publish agent activity" });
    await expect.element(publishSwitch).not.toBeChecked();
    await expect.element(activitySwitch).not.toBeChecked();
    await expect
      .element(
        page.getByText(
          /Expose this environment to your other devices through relay\.example\.test\./,
        ),
      )
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          /Send project and thread titles, model names, activity status, and environment and thread IDs to relay\.example\.test/,
        ),
      )
      .toBeInTheDocument();

    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    expect(reconcileCloudState).not.toHaveBeenCalled();
    await expect.element(page.getByTestId("devices-list")).toBeInTheDocument();
  });

  it("applies only tunnel exposure when only that toggle is enabled", async () => {
    setup({
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    });
    await using _screen = await render(<ConnectOnboardingDialog />);
    await signIn();

    const publishSwitch = page.getByRole("switch", { name: "Publish this environment" });
    await expect.element(publishSwitch).not.toBeChecked();
    (publishSwitch.element() as HTMLElement).focus();
    await userEvent.keyboard(" ");
    await expect.element(publishSwitch).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    expect(reconcileCloudState).toHaveBeenCalledExactlyOnceWith({
      managedTunnel: true,
      publish: false,
    });
  });

  it("applies only activity sharing when only that toggle is enabled", async () => {
    setup({
      linked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      publishAgentActivity: false,
    });
    await using _screen = await render(<ConnectOnboardingDialog />);
    await signIn();

    const activitySwitch = page.getByRole("switch", { name: "Publish agent activity" });
    await expect.element(activitySwitch).not.toBeChecked();
    (activitySwitch.element() as HTMLElement).focus();
    await userEvent.keyboard(" ");
    await expect.element(activitySwitch).toBeChecked();
    await userEvent.click(page.getByRole("button", { name: "Continue" }));
    expect(reconcileCloudState).toHaveBeenCalledExactlyOnceWith({
      managedTunnel: false,
      publish: true,
    });
  });

  it("restores existing link preferences when reopening for a linked environment", async () => {
    setup({
      linked: true,
      cloudUserId: "user-1",
      relayUrl: "https://custom-relay.example.test",
      relayIssuer: "https://custom-relay.example.test",
      managedTunnelActive: true,
      publishAgentActivity: false,
    });
    await using _screen = await render(<ConnectOnboardingDialog />);
    await signIn();

    await expect
      .element(page.getByRole("switch", { name: "Publish this environment" }))
      .toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Publish agent activity" }))
      .not.toBeChecked();
    await expect
      .element(
        page.getByText(
          /Expose this environment to your other devices through custom-relay\.example\.test\./,
        ),
      )
      .toBeInTheDocument();
  });
});
