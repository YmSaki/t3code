import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  buildSelfHostHubPairingGuide,
  layerWithDependencies,
  resolveSelfHostHubConfig,
  SelfHostHubCli,
} from "./hub.ts";

it("resolves hub defaults and formats tailnet pairing guidance with cloud UI suppressed", () => {
  const config = resolveSelfHostHubConfig({
    environmentRole: "hub",
    host: "0.0.0.0",
    port: 3773,
    tailscaleServeUrl: "https://hub.tailnet.ts.net/",
  });

  expect(config.linkedEnvironmentsEnabled).toBe(true);
  expect(config.selfHostedHubMode).toBe(true);

  const guide = buildSelfHostHubPairingGuide({
    config,
    pairingToken: "pair-secret-123",
    tailscaleAvailable: true,
  });

  expect(guide.uiPolicy.isSelfHosted).toBe(true);
  expect(guide.uiPolicy.suppressCloudSignIn).toBe(true);
  expect(guide.uiPolicy.suppressT3ConnectPromotion).toBe(true);
  expect(guide.uiPolicy.preferredPairingChannel).toBe("tailscale");
  expect(guide.localOrigin).toBe("http://127.0.0.1:3773");
  expect(guide.externalOrigin).toBe("https://hub.tailnet.ts.net");
  expect(guide.pairingUrl).toBe("https://hub.tailnet.ts.net/pair?token=pair-secret-123");
});

it.effect(
  "prepares hub guide with injected tailscale detection and diagnoses worker auth issues",
  () =>
    Effect.gen(function* () {
      const cli = yield* SelfHostHubCli.pipe(
        Effect.provide(
          layerWithDependencies({
            detectTailscaleServeUrl: () =>
              Effect.succeed({
                available: false,
                url: null,
              }),
            probeTarget: (target) => {
              if (target.environmentId === "env-ok") {
                return Effect.succeed({
                  reachable: true,
                  authenticated: true,
                  latencyMs: 18,
                  answeredEnvironmentId: "env-ok",
                });
              }
              if (target.environmentId === "env-expired") {
                return Effect.succeed({
                  reachable: true,
                  authenticated: false,
                  latencyMs: 25,
                  answeredEnvironmentId: "env-expired",
                });
              }
              if (target.environmentId === "env-mismatch") {
                return Effect.succeed({
                  reachable: true,
                  authenticated: true,
                  latencyMs: 30,
                  answeredEnvironmentId: "env-other",
                });
              }
              return Effect.succeed({
                reachable: false,
                authenticated: false,
                latencyMs: null,
                errorCode: "DEPTH_ZERO_SELF_SIGNED_CERT",
                errorMessage: "self signed certificate",
              });
            },
          }),
        ),
      );

      const guide = yield* cli.prepareHubGuide({
        environmentRole: "hub",
        headscaleControlUrl: "https://headscale.example.com",
      });
      expect(guide.uiPolicy.preferredPairingChannel).toBe("direct");
      expect(guide.lines.some((line) => line.includes("Headscale login:"))).toBe(true);

      const report = yield* cli.checkWorkerAuthHealth(guide.config, [
        {
          environmentId: EnvironmentId.make("env-ok"),
          label: "Worker OK",
          url: "https://ok.tailnet.ts.net",
        },
        {
          environmentId: EnvironmentId.make("env-expired"),
          label: "Worker Expired",
          url: "https://expired.tailnet.ts.net",
        },
        {
          environmentId: EnvironmentId.make("env-mismatch"),
          label: "Worker Mismatch",
          url: "https://mismatch.tailnet.ts.net",
        },
        {
          environmentId: EnvironmentId.make("env-tls"),
          label: "Worker TLS",
          url: "https://tls.tailnet.ts.net",
        },
      ]);

      expect(report.healthyCount).toBe(1);
      expect(report.failedCount).toBe(3);
      expect(report.items.map((item) => item.status)).toEqual([
        "healthy",
        "auth_rejected",
        "wrong_environment",
        "unreachable",
      ]);
      expect(report.items[1]?.remediation).toContain("t3 pair");
      expect(report.items[2]?.remediation).toContain("env-other");
      expect(report.items[3]?.remediation).toContain("Headscale MagicDNS");
    }),
);
