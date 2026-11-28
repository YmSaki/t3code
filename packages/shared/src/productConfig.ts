/**
 * Single owner of how a build or release resolves its product configuration.
 * Raw environment input is read and validated here once; every platform consumes the result.
 * Optional services are an explicit `disabled` state and never fall back to upstream values.
 */
export type Distribution = "upstream" | "fork";

export type HostedWeb =
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly router: string;
      readonly stable: string;
      readonly nightly: string;
    };

export type Connect =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly clerkPublishableKey: string;
      readonly clerkJwtTemplate: string;
      readonly clerkCliOAuthClientId: string;
      readonly relayUrl: string;
    };

export interface OtlpTraces {
  readonly tracesUrl: string;
  readonly tracesDataset: string;
  /** Empty only when the caller states the secret exists but is not available (preflight). */
  readonly tracesToken: string;
}

export type TelemetrySurface = "relayClient" | "mobile";

/** Relay monitoring. Each surface is configured completely or not at all. */
export type Telemetry =
  | { readonly kind: "unmanaged" }
  | { readonly kind: "disabled" }
  | {
      readonly kind: "enabled";
      readonly relayClient: OtlpTraces | null;
      readonly mobile: OtlpTraces | null;
    };

export interface MobileRelease {
  readonly owner: string | undefined;
  readonly projectId: string | undefined;
  readonly appleTeamId: string | undefined;
  readonly clerkDomain: string | undefined;
  readonly androidCertSha256: string | undefined;
  readonly updatesEnabled: boolean;
}

export interface ProductLinks {
  /** Origin for newly generated links, or null when this product cannot generate hosted links. */
  readonly generate: string | null;
  /** Origins recognised in pasted links. Compatibility origins are listed here and nowhere else. */
  readonly accept: readonly string[];
  /** Origins trusted as provider-auth return targets. Never includes compatibility origins. */
  readonly authReturn: readonly string[];
}

export interface ProductConfig {
  readonly distribution: Distribution;
  readonly hostedWeb: HostedWeb;
  readonly connect: Connect;
  readonly telemetry: Telemetry;
  readonly mobile: MobileRelease;
  readonly links: ProductLinks;
}

/** The part of the configuration that is safe to bake into client bundles. */
export type PublicProductConfig = Pick<ProductConfig, "distribution" | "hostedWeb" | "links">;

type Environment = Readonly<Record<string, string | undefined>>;

const UPSTREAM_HOSTED_WEB = {
  kind: "enabled",
  router: "https://app.t3.codes",
  stable: "https://latest.app.t3.codes",
  nightly: "https://nightly.app.t3.codes",
} as const satisfies HostedWeb;

/** Fork builds still open links shared from upstream clients. They are accepted, never generated. */
const UPSTREAM_LINK_COMPATIBILITY_ORIGINS = [
  UPSTREAM_HOSTED_WEB.router,
  UPSTREAM_HOSTED_WEB.stable,
  UPSTREAM_HOSTED_WEB.nightly,
] as const;

const UPSTREAM_MOBILE = {
  owner: "pingdotgg",
  projectId: "d763fcb8-d37c-41ea-a773-b54a0ab4a454",
  appleTeamId: "ARK85ZXQ4Z",
  clerkDomain: "clerk.t3.codes",
} as const;

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const DOMAIN = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;

function isUpstreamHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "t3.codes" || host.endsWith(".t3.codes");
}

function value(env: Environment, name: string): string {
  return env[name]?.trim() ?? "";
}

function httpsOrigin(name: string, input: string): URL {
  const url = URL.parse(input);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.href !== `${url.origin}/`
  ) {
    throw new Error(`${name} must be an HTTPS domain origin.`);
  }
  return url;
}

function forkOwnedOrigin(name: string, input: string): string {
  const url = httpsOrigin(name, input);
  if (isUpstreamHost(url.hostname) || !DOMAIN.test(url.hostname)) {
    throw new Error(`${name} must be a fork-owned HTTPS domain origin.`);
  }
  return url.origin;
}

function resolveDistribution(env: Environment): Distribution {
  const distribution = value(env, "T3CODE_DISTRIBUTION") || "upstream";
  if (distribution !== "upstream" && distribution !== "fork") {
    throw new Error("T3CODE_DISTRIBUTION must be upstream or fork.");
  }
  return distribution;
}

const HOSTED_WEB_VARIABLES = [
  "T3CODE_WEB_ROUTER_URL",
  "T3CODE_WEB_LATEST_DOMAIN",
  "T3CODE_WEB_NIGHTLY_DOMAIN",
] as const;

function resolveForkHostedWeb(env: Environment): HostedWeb {
  const [routerUrl, latest, nightly] = HOSTED_WEB_VARIABLES.map((name) => value(env, name));
  if (!routerUrl && !latest && !nightly) return { kind: "disabled" };
  if (!routerUrl || !latest || !nightly) {
    throw new Error("Set all three hosted Web settings for the fork together.");
  }
  const router = forkOwnedOrigin("T3CODE_WEB_ROUTER_URL", routerUrl);
  const stable = forkOwnedOrigin("T3CODE_WEB_LATEST_DOMAIN", `https://${latest}`);
  const nightlyOrigin = forkOwnedOrigin("T3CODE_WEB_NIGHTLY_DOMAIN", `https://${nightly}`);
  if (new Set([router, stable, nightlyOrigin]).size !== 3) {
    throw new Error("The hosted Web router, Stable, and Nightly must use distinct domains.");
  }
  return { kind: "enabled", router, stable, nightly: nightlyOrigin };
}

function forkClerkHostname(key: string): string | undefined {
  const encoded = /^pk_(?:live|test)_(.+)$/.exec(key)?.[1];
  if (!encoded) return undefined;
  try {
    return /^([a-z0-9-]+(?:\.[a-z0-9-]+)+)\$$/i.exec(atob(encoded))?.[1];
  } catch {
    return undefined;
  }
}

function resolveForkConnect(env: Environment): Connect {
  const passkeyDomains = value(env, "T3CODE_CLERK_PASSKEY_RP_DOMAINS").split(",");
  if (passkeyDomains.some((domain) => isUpstreamHost(domain.trim()))) {
    throw new Error("T3CODE_CLERK_PASSKEY_RP_DOMAINS must use fork-owned domains.");
  }
  const clerkPublishableKey = value(env, "T3CODE_CLERK_PUBLISHABLE_KEY");
  const clerkJwtTemplate = value(env, "T3CODE_CLERK_JWT_TEMPLATE");
  const clerkCliOAuthClientId = value(env, "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID");
  const relay = value(env, "T3CODE_RELAY_URL");
  if (!clerkPublishableKey && !clerkJwtTemplate && !clerkCliOAuthClientId && !relay) {
    return { kind: "disabled" };
  }
  if (!clerkPublishableKey || !clerkJwtTemplate || !clerkCliOAuthClientId || !relay) {
    throw new Error("Set all four Connect settings for the fork together.");
  }
  const clerkHost = forkClerkHostname(clerkPublishableKey);
  if (!clerkHost || isUpstreamHost(clerkHost)) {
    throw new Error("T3CODE_CLERK_PUBLISHABLE_KEY must be from the fork-owned Clerk instance.");
  }
  return {
    kind: "enabled",
    clerkPublishableKey,
    clerkJwtTemplate,
    clerkCliOAuthClientId,
    relayUrl: forkOwnedOrigin("T3CODE_RELAY_URL", relay),
  };
}

const TELEMETRY_KEYS = {
  relayClient: {
    url: "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL",
    dataset: "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET",
    token: "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN",
    tokenConfigured: "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN_CONFIGURED",
  },
  mobile: {
    url: "T3CODE_MOBILE_OTLP_TRACES_URL",
    dataset: "T3CODE_MOBILE_OTLP_TRACES_DATASET",
    token: "T3CODE_MOBILE_OTLP_TRACES_TOKEN",
    tokenConfigured: undefined,
  },
} as const;

function resolveOtlpSurface(env: Environment, surface: TelemetrySurface): OtlpTraces | null {
  const keys = TELEMETRY_KEYS[surface];
  const tracesUrl = value(env, keys.url);
  const tracesDataset = value(env, keys.dataset);
  const tracesToken = value(env, keys.token);
  const tokenConfigured =
    Boolean(tracesToken) ||
    (keys.tokenConfigured !== undefined && value(env, keys.tokenConfigured) === "true");
  if (!tracesUrl && !tracesDataset && !tokenConfigured) return null;
  const missing = [
    ...(tracesUrl ? [] : [keys.url]),
    ...(tracesDataset ? [] : [keys.dataset]),
    ...(tokenConfigured ? [] : [keys.token]),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing fork tracing configuration: ${missing.join(", ")}.`);
  }
  const parsed = URL.parse(tracesUrl);
  if (
    !parsed ||
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    isUpstreamHost(parsed.hostname)
  ) {
    throw new Error(`${keys.url} must be a non-upstream HTTPS URL.`);
  }
  return { tracesUrl: parsed.toString(), tracesDataset, tracesToken };
}

function resolveForkTelemetry(env: Environment, connect: Connect): Telemetry {
  const flag = value(env, "T3CODE_RELAY_OBSERVABILITY_ENABLED");
  if (flag !== "" && flag !== "true" && flag !== "false") {
    throw new Error("T3CODE_RELAY_OBSERVABILITY_ENABLED must be true or false.");
  }
  if (flag === "false") return { kind: "disabled" };
  // Supplied settings are validated even while monitoring is off, so a bad value never ships.
  const relayClient = resolveOtlpSurface(env, "relayClient");
  const mobile = resolveOtlpSurface(env, "mobile");
  if (flag !== "true") return { kind: "disabled" };
  if (connect.kind !== "enabled") {
    throw new Error("Configure fork Connect settings before enabling relay monitoring.");
  }
  return { kind: "enabled", relayClient, mobile };
}

/** A surface that ships monitoring calls this to fail when enabled monitoring lacks its settings. */
export function requireTelemetrySurface(
  telemetry: Telemetry,
  surface: TelemetrySurface,
): OtlpTraces | null {
  if (telemetry.kind !== "enabled") return null;
  const configured = telemetry[surface];
  if (configured === null) {
    const keys = TELEMETRY_KEYS[surface];
    throw new Error(
      `Missing fork tracing configuration: ${keys.url}, ${keys.dataset}, ${keys.token}.`,
    );
  }
  return configured;
}

function resolveForkMobile(env: Environment): MobileRelease {
  const updates = env.T3CODE_MOBILE_UPDATES_ENABLED;
  const owner = value(env, "T3CODE_MOBILE_EAS_OWNER") || undefined;
  const projectId = value(env, "T3CODE_MOBILE_EAS_PROJECT_ID").toLowerCase() || undefined;
  if (Boolean(owner) !== Boolean(projectId)) {
    throw new Error("Set both T3CODE_MOBILE_EAS_OWNER and T3CODE_MOBILE_EAS_PROJECT_ID.");
  }
  if (owner?.toLowerCase() === UPSTREAM_MOBILE.owner || projectId === UPSTREAM_MOBILE.projectId) {
    throw new Error("The fork must use its own Expo account and EAS project.");
  }
  if (projectId && !UUID.test(projectId)) {
    throw new Error("T3CODE_MOBILE_EAS_PROJECT_ID must be a UUID.");
  }
  if (updates === "1" && !projectId) {
    throw new Error("Fork OTA updates require a fork EAS project.");
  }
  const appleTeamId = value(env, "T3CODE_MOBILE_APPLE_TEAM_ID") || undefined;
  if (
    appleTeamId &&
    (!/^[A-Z0-9]{10}$/.test(appleTeamId) || appleTeamId === UPSTREAM_MOBILE.appleTeamId)
  ) {
    throw new Error("T3CODE_MOBILE_APPLE_TEAM_ID must be the fork's 10-character Apple team ID.");
  }
  const clerkDomain = value(env, "T3CODE_MOBILE_CLERK_DOMAIN").toLowerCase() || undefined;
  if (clerkDomain && (!DOMAIN.test(clerkDomain) || isUpstreamHost(clerkDomain))) {
    throw new Error("T3CODE_MOBILE_CLERK_DOMAIN must be a fork-owned hostname.");
  }
  const androidCertSha256 =
    value(env, "T3CODE_MOBILE_ANDROID_CERT_SHA256").toUpperCase() || undefined;
  if (androidCertSha256 && !/^[A-F0-9]{2}(?::[A-F0-9]{2}){31}$/.test(androidCertSha256)) {
    throw new Error(
      "T3CODE_MOBILE_ANDROID_CERT_SHA256 must be a colon-delimited SHA-256 fingerprint.",
    );
  }
  return {
    owner,
    projectId,
    appleTeamId,
    clerkDomain,
    androidCertSha256,
    updatesEnabled: Boolean(projectId) && updates !== "0",
  };
}

function hostedWebOrigins(hostedWeb: HostedWeb): readonly string[] {
  return hostedWeb.kind === "enabled"
    ? [hostedWeb.router, hostedWeb.stable, hostedWeb.nightly]
    : [];
}

function forkOnlyVariables(env: Environment): string[] {
  return Object.keys(env).filter(
    (name) =>
      (name.startsWith("T3CODE_MOBILE_EAS_") ||
        name === "T3CODE_MOBILE_APPLE_TEAM_ID" ||
        name === "T3CODE_MOBILE_ANDROID_CERT_SHA256" ||
        name === "T3CODE_MOBILE_CLERK_DOMAIN" ||
        (HOSTED_WEB_VARIABLES as readonly string[]).includes(name)) &&
      value(env, name) !== "",
  );
}

export function resolveProductConfig(env: Environment): ProductConfig {
  const distribution = resolveDistribution(env);
  if (distribution === "upstream") {
    const mixed = forkOnlyVariables(env);
    if (mixed.length > 0) {
      throw new Error(
        `Fork-only settings require T3CODE_DISTRIBUTION=fork: ${[...mixed].sort().join(", ")}.`,
      );
    }
    return {
      distribution,
      hostedWeb: UPSTREAM_HOSTED_WEB,
      connect: { kind: "unmanaged" },
      telemetry: { kind: "unmanaged" },
      mobile: {
        ...UPSTREAM_MOBILE,
        androidCertSha256: undefined,
        updatesEnabled: env.T3CODE_MOBILE_UPDATES_ENABLED !== "0",
      },
      links: {
        generate: UPSTREAM_HOSTED_WEB.router,
        accept: hostedWebOrigins(UPSTREAM_HOSTED_WEB),
        authReturn: hostedWebOrigins(UPSTREAM_HOSTED_WEB),
      },
    };
  }

  const hostedWeb = resolveForkHostedWeb(env);
  const own = hostedWebOrigins(hostedWeb);
  const connect = resolveForkConnect(env);
  return {
    distribution,
    hostedWeb,
    connect,
    telemetry: resolveForkTelemetry(env, connect),
    mobile: resolveForkMobile(env),
    links: {
      generate: hostedWeb.kind === "enabled" ? hostedWeb.router : null,
      accept: [...new Set([...own, ...UPSTREAM_LINK_COMPATIBILITY_ORIGINS])],
      authReturn: own,
    },
  };
}

export function toPublicProductConfig(config: ProductConfig): PublicProductConfig {
  return { distribution: config.distribution, hostedWeb: config.hostedWeb, links: config.links };
}

export const UPSTREAM_PUBLIC_PRODUCT_CONFIG: PublicProductConfig = toPublicProductConfig(
  resolveProductConfig({}),
);
