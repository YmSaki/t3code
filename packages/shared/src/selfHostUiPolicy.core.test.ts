import { describe, expect, it } from "vite-plus/test";

import { evaluateSelfHostUiPolicy, shouldSuppressCloudUi } from "./selfHostUiPolicy.core.ts";

describe("selfHostUiPolicy.core", () => {
  it("suppresses cloud sign-in and T3 Connect when selfHostMode is enabled and prefers Tailscale", () => {
    const policy = evaluateSelfHostUiPolicy({
      selfHostMode: true,
      clerkConfigured: true,
      t3ConnectConfigured: true,
      tailscaleAvailable: true,
      tailscaleServeUrl: " https://hub.tailnet.ts.net ",
    });

    expect(policy.isSelfHosted).toBe(true);
    expect(policy.suppressCloudSignIn).toBe(true);
    expect(policy.suppressT3ConnectPromotion).toBe(true);
    expect(policy.showCloudBillingUi).toBe(false);
    expect(policy.preferredPairingChannel).toBe("tailscale");
    expect(policy.availablePairingChannels).toEqual(["tailscale", "direct"]);
    expect(policy.recommendedPairingUrl).toBe("https://hub.tailnet.ts.net");
    expect(
      shouldSuppressCloudUi({
        selfHostMode: true,
        clerkConfigured: true,
        t3ConnectConfigured: true,
        tailscaleAvailable: true,
      }),
    ).toBe(true);
  });

  it("falls back to direct pairing when Clerk and T3 Connect are unconfigured and Tailscale is unavailable", () => {
    const policy = evaluateSelfHostUiPolicy({
      selfHostMode: false,
      clerkConfigured: false,
      t3ConnectConfigured: false,
      tailscaleAvailable: false,
      tailscaleServeUrl: "https://unused.ts.net",
    });

    expect(policy.isSelfHosted).toBe(true);
    expect(policy.suppressCloudSignIn).toBe(true);
    expect(policy.suppressT3ConnectPromotion).toBe(true);
    expect(policy.preferredPairingChannel).toBe("direct");
    expect(policy.availablePairingChannels).toEqual(["direct"]);
    expect(policy.recommendedPairingUrl).toBeNull();
  });

  it("enables cloud UI and T3 Connect when hosted services are configured and selfHostMode is false", () => {
    const policy = evaluateSelfHostUiPolicy({
      selfHostMode: false,
      clerkConfigured: true,
      t3ConnectConfigured: true,
      tailscaleAvailable: true,
      tailscaleServeUrl: "https://node.tailnet.ts.net",
    });

    expect(policy.isSelfHosted).toBe(false);
    expect(policy.suppressCloudSignIn).toBe(false);
    expect(policy.suppressT3ConnectPromotion).toBe(false);
    expect(policy.showCloudBillingUi).toBe(true);
    expect(policy.preferredPairingChannel).toBe("t3_connect");
    expect(policy.availablePairingChannels).toEqual(["tailscale", "t3_connect", "direct"]);
    expect(
      shouldSuppressCloudUi({
        selfHostMode: false,
        clerkConfigured: true,
        t3ConnectConfigured: true,
        tailscaleAvailable: true,
      }),
    ).toBe(false);
  });
});
