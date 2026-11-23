export type SelfHostPairingChannel = "tailscale" | "direct" | "t3_connect";

export interface SelfHostUiPolicyInput {
  readonly selfHostMode: boolean;
  readonly clerkConfigured: boolean;
  readonly t3ConnectConfigured: boolean;
  readonly tailscaleAvailable: boolean;
  readonly tailscaleServeUrl?: string | null | undefined;
  readonly directPairingAvailable?: boolean | undefined;
}

export interface SelfHostUiPolicy {
  readonly isSelfHosted: boolean;
  readonly suppressCloudSignIn: boolean;
  readonly suppressT3ConnectPromotion: boolean;
  readonly showCloudBillingUi: boolean;
  readonly preferredPairingChannel: SelfHostPairingChannel;
  readonly availablePairingChannels: ReadonlyArray<SelfHostPairingChannel>;
  readonly recommendedPairingUrl: string | null;
}

export function evaluateSelfHostUiPolicy(input: SelfHostUiPolicyInput): SelfHostUiPolicy {
  const isSelfHosted = input.selfHostMode || (!input.clerkConfigured && !input.t3ConnectConfigured);
  const suppressCloudSignIn = input.selfHostMode || !input.clerkConfigured;
  const suppressT3ConnectPromotion = input.selfHostMode || !input.t3ConnectConfigured;
  const showCloudBillingUi = !isSelfHosted && input.clerkConfigured && input.t3ConnectConfigured;
  const directAvailable = input.directPairingAvailable ?? true;

  const availablePairingChannels: SelfHostPairingChannel[] = [];
  if (suppressT3ConnectPromotion) {
    if (input.tailscaleAvailable) {
      availablePairingChannels.push("tailscale");
    }
    if (directAvailable) {
      availablePairingChannels.push("direct");
    }
  } else {
    if (input.tailscaleAvailable) {
      availablePairingChannels.push("tailscale");
    }
    availablePairingChannels.push("t3_connect");
    if (directAvailable) {
      availablePairingChannels.push("direct");
    }
  }

  if (availablePairingChannels.length === 0) {
    availablePairingChannels.push("direct");
  }

  const preferredPairingChannel: SelfHostPairingChannel = suppressT3ConnectPromotion
    ? input.tailscaleAvailable
      ? "tailscale"
      : "direct"
    : "t3_connect";

  const trimmedTailscaleUrl = input.tailscaleServeUrl?.trim() ?? "";
  const recommendedPairingUrl =
    input.tailscaleAvailable && trimmedTailscaleUrl.length > 0 ? trimmedTailscaleUrl : null;

  return {
    isSelfHosted,
    suppressCloudSignIn,
    suppressT3ConnectPromotion,
    showCloudBillingUi,
    preferredPairingChannel,
    availablePairingChannels,
    recommendedPairingUrl,
  };
}

export function shouldSuppressCloudUi(input: SelfHostUiPolicyInput): boolean {
  const policy = evaluateSelfHostUiPolicy(input);
  return policy.suppressCloudSignIn && policy.suppressT3ConnectPromotion;
}
