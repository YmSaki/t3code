import type { EnvironmentCloudLinkStateResult } from "@t3tools/contracts";

export interface ConnectOnboardingSelection {
  readonly exposeEnvironment: boolean;
  readonly publishAgentActivity: boolean;
}

export function resolveInitialConnectOnboardingSelection(
  linkState: EnvironmentCloudLinkStateResult | null,
  accountId: string | null,
): ConnectOnboardingSelection {
  if (
    linkState !== null &&
    linkState.linked &&
    linkState.linkRevoked !== true &&
    accountId !== null &&
    linkState.cloudUserId === accountId
  ) {
    return {
      exposeEnvironment: linkState.managedTunnelActive ?? linkState.linked,
      publishAgentActivity: linkState.publishAgentActivity,
    };
  }
  return {
    exposeEnvironment: false,
    publishAgentActivity: false,
  };
}

export function formatRelayDestination(relayUrl: string | null | undefined): string | null {
  const trimmed = relayUrl?.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).host || null;
  } catch {
    return null;
  }
}
