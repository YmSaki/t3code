const {
  resolveForkConnectConfig,
  resolveForkRelayClientTracingConfig,
} = require("../../scripts/lib/public-config.ts");

function resolveForkRelayDeployConfig(env) {
  const connect = resolveForkConnectConfig(env);
  if (!connect.relayUrl || !env.CLERK_JWT_AUDIENCE?.trim()) {
    throw new Error(
      "Configure the fork Connect client settings and Clerk JWT audience before deploying.",
    );
  }
  const host = new URL(connect.relayUrl).hostname;
  const [apiZone, tunnelZone] = ["RELAY_API_ZONE_NAME", "RELAY_TUNNEL_ZONE_NAME"].map(
    (name) => env[name]?.trim().toLowerCase() ?? "",
  );
  for (const zone of [apiZone, tunnelZone]) {
    if (
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(zone) ||
      zone === "t3.codes" ||
      zone.endsWith(".t3.codes")
    ) {
      throw new Error("Set both relay DNS zones to fork-owned Cloudflare zones.");
    }
  }
  if (
    connect.relayUrl !== `https://${host}` ||
    (host !== apiZone && !host.endsWith(`.${apiZone}`))
  ) {
    throw new Error(
      "The fork relay origin must use standard HTTPS on a hostname in the relay API zone.",
    );
  }

  const observabilityEnabled = env.RELAY_OBSERVABILITY_ENABLED?.trim() === "true";
  if (observabilityEnabled) {
    const missing = [];
    if (!env.AXIOM_ORG_ID?.trim()) missing.push("AXIOM_ORG_ID");
    if (!env.AXIOM_TOKEN?.trim() && env.AXIOM_TOKEN_CONFIGURED?.trim() !== "true") {
      missing.push("AXIOM_TOKEN");
    }
    if (missing.length > 0) {
      throw new Error(`Missing fork relay Axiom configuration: ${missing.join(", ")}.`);
    }
  }

  return {
    domain: host,
    apiZone,
    tunnelZone,
    clerkPublishableKey: connect.clerkPublishableKey,
    observabilityEnabled,
  };
}

function resolveForkClientObservability(env) {
  const enabled = env.T3CODE_RELAY_OBSERVABILITY_ENABLED?.trim() === "true";
  const connect = resolveForkConnectConfig(env);
  if (!enabled) {
    return {
      enabled: false,
      tracesUrl: "",
      tracesDataset: "",
      tracesToken: "",
    };
  }
  if (!connect.relayUrl) {
    throw new Error("Configure fork Connect settings before enabling relay monitoring.");
  }
  const tracing = resolveForkRelayClientTracingConfig(env, { requireConfigured: true });
  return {
    enabled: true,
    ...tracing,
  };
}

module.exports = {
  resolveForkClientObservability,
  resolveForkRelayDeployConfig,
};
