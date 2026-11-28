import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatRelayDestination,
  resolveInitialConnectOnboardingSelection,
} from "./ConnectOnboardingDialog.logic";

function makeLinkState(
  overrides: Partial<EnvironmentCloudLinkStateResult> = {},
): EnvironmentCloudLinkStateResult {
  return {
    linked: false,
    cloudUserId: null,
    relayUrl: null,
    relayIssuer: null,
    publishAgentActivity: false,
    ...overrides,
  };
}

describe("resolveInitialConnectOnboardingSelection", () => {
  it("defaults both toggles to false when unlinked, revoked, or linked to another account", () => {
    expect(resolveInitialConnectOnboardingSelection(null, "user-1")).toEqual({
      exposeEnvironment: false,
      publishAgentActivity: false,
    });
    expect(
      resolveInitialConnectOnboardingSelection(
        makeLinkState({ linked: false, publishAgentActivity: true }),
        "user-1",
      ),
    ).toEqual({
      exposeEnvironment: false,
      publishAgentActivity: false,
    });
    expect(
      resolveInitialConnectOnboardingSelection(
        makeLinkState({
          linked: true,
          linkRevoked: true,
          cloudUserId: "user-1",
          managedTunnelActive: true,
          publishAgentActivity: true,
        }),
        "user-1",
      ),
    ).toEqual({
      exposeEnvironment: false,
      publishAgentActivity: false,
    });
    expect(
      resolveInitialConnectOnboardingSelection(
        makeLinkState({
          linked: true,
          cloudUserId: "user-other",
          managedTunnelActive: true,
          publishAgentActivity: true,
        }),
        "user-1",
      ),
    ).toEqual({
      exposeEnvironment: false,
      publishAgentActivity: false,
    });
  });

  it("restores saved exposure and activity preferences for an active matching link", () => {
    expect(
      resolveInitialConnectOnboardingSelection(
        makeLinkState({
          linked: true,
          cloudUserId: "user-1",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
        "user-1",
      ),
    ).toEqual({
      exposeEnvironment: true,
      publishAgentActivity: false,
    });
    expect(
      resolveInitialConnectOnboardingSelection(
        makeLinkState({
          linked: true,
          cloudUserId: "user-1",
          managedTunnelActive: false,
          publishAgentActivity: true,
        }),
        "user-1",
      ),
    ).toEqual({
      exposeEnvironment: false,
      publishAgentActivity: true,
    });
    expect(
      resolveInitialConnectOnboardingSelection(
        makeLinkState({
          linked: true,
          cloudUserId: "user-1",
          publishAgentActivity: false,
        }),
        "user-1",
      ),
    ).toEqual({
      exposeEnvironment: true,
      publishAgentActivity: false,
    });
  });
});

describe("formatRelayDestination", () => {
  it("returns the relay host for valid URLs and null otherwise", () => {
    expect(formatRelayDestination("https://relay.example.test/path")).toBe("relay.example.test");
    expect(formatRelayDestination(" https://relay.example.test:8443 ")).toBe(
      "relay.example.test:8443",
    );
    expect(formatRelayDestination(null)).toBeNull();
    expect(formatRelayDestination("")).toBeNull();
    expect(formatRelayDestination("not a url")).toBeNull();
  });
});
