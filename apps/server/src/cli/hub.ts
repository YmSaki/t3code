import { EnvironmentId, type EnvironmentRole, type SelfHostHubConfig } from "@t3tools/contracts";
import {
  evaluateSelfHostUiPolicy,
  type SelfHostUiPolicy,
} from "@t3tools/shared/selfHostUiPolicy.core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const DEFAULT_HUB_HOST = "127.0.0.1";
export const DEFAULT_HUB_PORT = 3773;
export const DEFAULT_HUB_TAILSCALE_SERVE_PORT = 443;

export interface ResolveSelfHostHubConfigInput {
  readonly environmentRole?: EnvironmentRole | undefined;
  readonly hubEnvironmentId?: string | null | undefined;
  readonly linkedEnvironmentsEnabled?: boolean | undefined;
  readonly selfHostedHubMode?: boolean | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly tailscaleServeEnabled?: boolean | undefined;
  readonly tailscaleServePort?: number | undefined;
  readonly tailscaleServeUrl?: string | null | undefined;
}

export interface SelfHostHubPairingGuideInput {
  readonly config: SelfHostHubConfig;
  readonly pairingToken?: string | null | undefined;
  readonly tailscaleAvailable: boolean;
  readonly clerkConfigured?: boolean | undefined;
  readonly t3ConnectConfigured?: boolean | undefined;
  readonly headscaleControlUrl?: string | null | undefined;
}

export interface SelfHostHubPairingGuide {
  readonly config: SelfHostHubConfig;
  readonly uiPolicy: SelfHostUiPolicy;
  readonly localOrigin: string;
  readonly externalOrigin: string;
  readonly pairingUrl: string;
  readonly tailscaleServeCommand: string;
  readonly lines: ReadonlyArray<string>;
}

export interface HubWorkerAuthTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly url: string;
  readonly bearerToken?: string | null | undefined;
}

export interface HubWorkerAuthProbeOutcome {
  readonly reachable: boolean;
  readonly authenticated: boolean;
  readonly latencyMs: number | null;
  readonly answeredEnvironmentId?: string | null | undefined;
  readonly errorCode?: string | null | undefined;
  readonly errorMessage?: string | null | undefined;
}

export interface HubWorkerAuthHealthItem {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly url: string;
  readonly status: "healthy" | "auth_rejected" | "wrong_environment" | "unreachable";
  readonly latencyMs: number | null;
  readonly remediation: string | null;
}

export interface HubWorkerAuthHealthReport {
  readonly hubRole: EnvironmentRole;
  readonly healthyCount: number;
  readonly failedCount: number;
  readonly items: ReadonlyArray<HubWorkerAuthHealthItem>;
}

export class SelfHostHubCliError extends Schema.TaggedError<SelfHostHubCliError>()(
  "SelfHostHubCliError",
  {
    reason: Schema.Literals(["invalid_config", "tailscale_unavailable", "probe_failed"]),
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

export interface SelfHostHubCliDependencies {
  readonly detectTailscaleServeUrl: (
    port: number,
    httpsPort: number,
  ) => Effect.Effect<
    {
      readonly available: boolean;
      readonly url: string | null;
    },
    SelfHostHubCliError
  >;
  readonly probeTarget: (
    target: HubWorkerAuthTarget,
  ) => Effect.Effect<HubWorkerAuthProbeOutcome, SelfHostHubCliError>;
}

const formatHostForHttpOrigin = (host: string): string => {
  const trimmed = host.trim();
  if (trimmed === "0.0.0.0" || trimmed === "::") {
    return DEFAULT_HUB_HOST;
  }
  return trimmed.includes(":") && !trimmed.startsWith("[") ? `[${trimmed}]` : trimmed;
};

export function resolveSelfHostHubConfig(
  input: ResolveSelfHostHubConfigInput = {},
): SelfHostHubConfig {
  const environmentRole: EnvironmentRole = input.environmentRole ?? "hub";
  const selfHostedHubMode = input.selfHostedHubMode ?? environmentRole === "hub";
  const linkedEnvironmentsEnabled = input.linkedEnvironmentsEnabled ?? true;
  const host = input.host?.trim() ? input.host.trim() : DEFAULT_HUB_HOST;
  const port = input.port ?? DEFAULT_HUB_PORT;
  const tailscaleServeEnabled = input.tailscaleServeEnabled ?? environmentRole === "hub";
  const tailscaleServePort = input.tailscaleServePort ?? DEFAULT_HUB_TAILSCALE_SERVE_PORT;
  const trimmedHubId = input.hubEnvironmentId?.trim() ?? "";
  const hubEnvironmentId = trimmedHubId.length > 0 ? EnvironmentId.make(trimmedHubId) : null;
  const trimmedTailscaleUrl = input.tailscaleServeUrl?.trim() ?? "";
  const tailscaleServeUrl = trimmedTailscaleUrl.length > 0 ? trimmedTailscaleUrl : null;

  return {
    environmentRole,
    hubEnvironmentId,
    linkedEnvironmentsEnabled,
    selfHostedHubMode,
    host,
    port,
    tailscaleServeEnabled,
    tailscaleServePort,
    tailscaleServeUrl,
  };
}

export function buildSelfHostHubPairingGuide(
  input: SelfHostHubPairingGuideInput,
): SelfHostHubPairingGuide {
  const host = formatHostForHttpOrigin(input.config.host ?? DEFAULT_HUB_HOST);
  const port = input.config.port ?? DEFAULT_HUB_PORT;
  const httpsPort = input.config.tailscaleServePort ?? DEFAULT_HUB_TAILSCALE_SERVE_PORT;
  const localOrigin = `http://${host}:${port}`;

  const uiPolicy = evaluateSelfHostUiPolicy({
    selfHostMode: input.config.selfHostedHubMode,
    clerkConfigured: input.clerkConfigured ?? false,
    t3ConnectConfigured: input.t3ConnectConfigured ?? false,
    tailscaleAvailable: input.tailscaleAvailable,
    tailscaleServeUrl: input.config.tailscaleServeUrl ?? null,
    directPairingAvailable: true,
  });

  const externalOrigin =
    uiPolicy.recommendedPairingUrl !== null
      ? uiPolicy.recommendedPairingUrl.replace(/\/+$/u, "")
      : localOrigin;
  const token = input.pairingToken?.trim() ?? "";
  const pairingUrl =
    token.length > 0 ? `${externalOrigin}/pair?token=${encodeURIComponent(token)}` : externalOrigin;
  const tailscaleServeCommand = `tailscale serve --bg --https=${httpsPort} http://127.0.0.1:${port}`;

  const lines: string[] = [
    `Role: ${input.config.environmentRole} (linked environments: ${input.config.linkedEnvironmentsEnabled ? "enabled" : "disabled"})`,
    `Local listener: ${localOrigin}`,
  ];

  if (uiPolicy.preferredPairingChannel === "tailscale" && uiPolicy.recommendedPairingUrl !== null) {
    lines.push(`Tailnet HTTPS endpoint: ${externalOrigin}`);
  } else if (input.config.tailscaleServeEnabled) {
    lines.push(`Expose on tailnet: ${tailscaleServeCommand}`);
    if (input.headscaleControlUrl) {
      lines.push(
        `Headscale login: tailscale up --login-server ${input.headscaleControlUrl.trim()}`,
      );
    }
  }

  lines.push(`Pairing URL: ${pairingUrl}`);
  return {
    config: input.config,
    uiPolicy,
    localOrigin,
    externalOrigin,
    pairingUrl,
    tailscaleServeCommand,
    lines,
  };
}

const buildRemediation = (
  target: HubWorkerAuthTarget,
  outcome: HubWorkerAuthProbeOutcome,
): { readonly status: HubWorkerAuthHealthItem["status"]; readonly remediation: string | null } => {
  if (!outcome.reachable) {
    const tlsHint =
      outcome.errorCode !== undefined &&
      outcome.errorCode !== null &&
      /CERT|SELF_SIGNED|HOSTNAME_MISMATCH/u.test(outcome.errorCode)
        ? " Verify the tailnet HTTPS certificate or Headscale MagicDNS hostname."
        : "";
    return {
      status: "unreachable",
      remediation: `Cannot reach ${target.label} at ${target.url}.${tlsHint} Confirm \`t3 serve\` and \`tailscale serve status\` on that worker.`,
    };
  }

  if (
    outcome.answeredEnvironmentId !== undefined &&
    outcome.answeredEnvironmentId !== null &&
    outcome.answeredEnvironmentId !== target.environmentId
  ) {
    return {
      status: "wrong_environment",
      remediation: `${target.url} answered as ${outcome.answeredEnvironmentId} instead of ${target.environmentId}. Re-link the worker with its current address.`,
    };
  }

  if (!outcome.authenticated) {
    return {
      status: "auth_rejected",
      remediation: `Bearer session for ${target.label} (${target.environmentId}) was rejected or expired. Mint a new pairing code with \`t3 pair\` on the worker and re-link it from the hub.`,
    };
  }

  return {
    status: "healthy",
    remediation: null,
  };
};

export class SelfHostHubCli extends Context.Service<
  SelfHostHubCli,
  {
    readonly prepareHubGuide: (
      input?: ResolveSelfHostHubConfigInput & {
        readonly pairingToken?: string | null | undefined;
        readonly headscaleControlUrl?: string | null | undefined;
      },
    ) => Effect.Effect<SelfHostHubPairingGuide, SelfHostHubCliError>;
    readonly checkWorkerAuthHealth: (
      config: SelfHostHubConfig,
      targets: ReadonlyArray<HubWorkerAuthTarget>,
    ) => Effect.Effect<HubWorkerAuthHealthReport, SelfHostHubCliError>;
  }
>()("t3/cli/hub/SelfHostHubCli") {}

export const make = (dependencies: SelfHostHubCliDependencies) =>
  Effect.sync(() => {
    const prepareHubGuide: SelfHostHubCli["Service"]["prepareHubGuide"] = Effect.fn(
      "SelfHostHubCli.prepareHubGuide",
    )(function* (input = {}) {
      const baseConfig = resolveSelfHostHubConfig(input);
      const port = baseConfig.port ?? DEFAULT_HUB_PORT;
      const httpsPort = baseConfig.tailscaleServePort ?? DEFAULT_HUB_TAILSCALE_SERVE_PORT;
      const tailscale = yield* dependencies.detectTailscaleServeUrl(port, httpsPort);
      const resolvedConfig: SelfHostHubConfig = {
        ...baseConfig,
        tailscaleServeUrl: baseConfig.tailscaleServeUrl ?? tailscale.url,
      };
      return buildSelfHostHubPairingGuide({
        config: resolvedConfig,
        pairingToken: input.pairingToken,
        tailscaleAvailable: tailscale.available,
        headscaleControlUrl: input.headscaleControlUrl,
      });
    });

    const checkWorkerAuthHealth: SelfHostHubCli["Service"]["checkWorkerAuthHealth"] = Effect.fn(
      "SelfHostHubCli.checkWorkerAuthHealth",
    )(function* (config, targets) {
      const items = yield* Effect.forEach(
        targets,
        (target) =>
          dependencies.probeTarget(target).pipe(
            Effect.map((outcome): HubWorkerAuthHealthItem => {
              const { status, remediation } = buildRemediation(target, outcome);
              return {
                environmentId: target.environmentId,
                label: target.label,
                url: target.url,
                status,
                latencyMs: outcome.latencyMs,
                remediation,
              };
            }),
          ),
        { concurrency: "unbounded" },
      );

      const healthyCount = items.filter((item) => item.status === "healthy").length;
      return {
        hubRole: config.environmentRole,
        healthyCount,
        failedCount: items.length - healthyCount,
        items,
      };
    });

    return SelfHostHubCli.of({
      prepareHubGuide,
      checkWorkerAuthHealth,
    });
  });

export const layerWithDependencies = (dependencies: SelfHostHubCliDependencies) =>
  Layer.effect(SelfHostHubCli, make(dependencies));

export const layer = layerWithDependencies({
  detectTailscaleServeUrl: () =>
    Effect.succeed({
      available: false,
      url: null,
    }),
  probeTarget: () =>
    Effect.succeed({
      reachable: false,
      authenticated: false,
      latencyMs: null,
      errorMessage: "No probe transport configured.",
    }),
});
