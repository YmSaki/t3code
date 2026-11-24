import { useAtomValue } from "@effect/atom-react";
import { DEFAULT_SERVER_SETTINGS, type EnvironmentId } from "@t3tools/contracts";
import {
  evaluateSelfHostUiPolicy,
  type SelfHostUiPolicy,
} from "@t3tools/shared/selfHostUiPolicy.core";
import type { ReactNode } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { primaryServerSettingsAtom, serverEnvironment } from "~/state/server";

function useSelfHostUiPolicy(requestedEnvironmentId?: EnvironmentId | null): SelfHostUiPolicy {
  const settings =
    useAtomValue(
      requestedEnvironmentId
        ? serverEnvironment.settingsValueAtom(requestedEnvironmentId)
        : primaryServerSettingsAtom,
    ) ?? DEFAULT_SERVER_SETTINGS;
  const cloudConfigured = hasCloudPublicConfig();
  const selfHostMode =
    settings.hubConfig?.selfHostedHubMode === true ||
    settings.environmentRole === "hub" ||
    !cloudConfigured;
  const tailscaleServeUrl = settings.hubConfig?.tailscaleServeUrl ?? null;
  const tailscaleAvailable =
    settings.hubConfig?.tailscaleServeEnabled === true ||
    (tailscaleServeUrl !== null && tailscaleServeUrl.trim().length > 0);

  return evaluateSelfHostUiPolicy({
    selfHostMode,
    clerkConfigured: cloudConfigured,
    t3ConnectConfigured: cloudConfigured,
    tailscaleAvailable,
    tailscaleServeUrl,
    directPairingAvailable: true,
  });
}

export function SelfHostCloudBannerGuard({
  environmentId,
  kind = "t3_connect",
  fallback = null,
  children,
}: {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly kind?: "cloud_signin" | "t3_connect" | "cloud_billing" | undefined;
  readonly fallback?: ReactNode | undefined;
  readonly children: ReactNode;
}) {
  const policy = useSelfHostUiPolicy(environmentId);

  const suppressed =
    kind === "cloud_signin"
      ? policy.suppressCloudSignIn
      : kind === "cloud_billing"
        ? !policy.showCloudBillingUi
        : policy.suppressT3ConnectPromotion;

  if (suppressed) {
    return fallback;
  }

  return children;
}
