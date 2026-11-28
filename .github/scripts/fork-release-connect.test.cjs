const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  resolveForkClientObservability,
  resolveForkRelayDeployConfig,
} = require("./fork-release-connect.cjs");

const forkClerkKey = `pk_live_${btoa("clerk.fork.example.test$")}`;
const connectEnv = {
  T3CODE_CLERK_PUBLISHABLE_KEY: forkClerkKey,
  T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_fork",
  T3CODE_RELAY_URL: "https://relay.fork.example.test",
};

const deployBase = {
  ...connectEnv,
  CLERK_JWT_AUDIENCE: "t3-code-relay",
  RELAY_API_ZONE_NAME: "fork.example.test",
  RELAY_TUNNEL_ZONE_NAME: "tunnels.fork.example.test",
};

test("fork relay deploy succeeds without Axiom configuration when observability is disabled", () => {
  assert.deepEqual(
    resolveForkRelayDeployConfig({ ...deployBase, RELAY_OBSERVABILITY_ENABLED: "false" }),
    {
      domain: "relay.fork.example.test",
      apiZone: "fork.example.test",
      tunnelZone: "tunnels.fork.example.test",
      clerkPublishableKey: forkClerkKey,
      observabilityEnabled: false,
    },
  );
});

test("fork relay deploy rejects missing Axiom credentials when observability is enabled", () => {
  assert.throws(
    () => resolveForkRelayDeployConfig({ ...deployBase, RELAY_OBSERVABILITY_ENABLED: "true" }),
    /Missing fork relay Axiom configuration: AXIOM_ORG_ID, AXIOM_TOKEN/,
  );
  assert.deepEqual(
    resolveForkRelayDeployConfig({
      ...deployBase,
      RELAY_OBSERVABILITY_ENABLED: "true",
      AXIOM_ORG_ID: "org-fork",
      AXIOM_TOKEN_CONFIGURED: "true",
    }),
    {
      domain: "relay.fork.example.test",
      apiZone: "fork.example.test",
      tunnelZone: "tunnels.fork.example.test",
      clerkPublishableKey: forkClerkKey,
      observabilityEnabled: true,
    },
  );
});

test("fork relay deploy rejects upstream DNS zones and hosts", () => {
  assert.throws(
    () =>
      resolveForkRelayDeployConfig({
        ...deployBase,
        RELAY_TUNNEL_ZONE_NAME: "tunnels.t3.codes",
      }),
    /fork-owned Cloudflare zones/,
  );
});

test("fork client observability stays disabled without tracing configuration", () => {
  assert.deepEqual(resolveForkClientObservability(connectEnv), {
    enabled: false,
    tracesUrl: "",
    tracesDataset: "",
    tracesToken: "",
  });
});

test("fork client observability requires Connect and all tracing settings when enabled", () => {
  assert.throws(
    () => resolveForkClientObservability({ T3CODE_RELAY_OBSERVABILITY_ENABLED: "true" }),
    /Configure fork Connect settings before enabling relay monitoring/,
  );
  assert.throws(
    () =>
      resolveForkClientObservability({
        ...connectEnv,
        T3CODE_RELAY_OBSERVABILITY_ENABLED: "true",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
      }),
    /Missing fork tracing configuration: T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET, T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN/,
  );
  assert.deepEqual(
    resolveForkClientObservability({
      ...connectEnv,
      T3CODE_RELAY_OBSERVABILITY_ENABLED: "true",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "fork-traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN_CONFIGURED: "true",
    }),
    {
      enabled: true,
      tracesUrl: "https://traces.fork.example.test/v1/traces",
      tracesDataset: "fork-traces",
      tracesToken: "",
    },
  );
});
