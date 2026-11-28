// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("uses only canonical Connect settings for a fork distribution", () => {
    const repoRoot = makeTemporaryDirectory();
    const upstreamKey = `pk_live_${btoa("clerk.t3.codes$")}`;
    const forkKey = `pk_live_${btoa("accounts.fork.example.test$")}`;
    const build = (baseEnv: Record<string, string>) => loadRepoEnv({ baseEnv, repoRoot });
    const canonical = {
      T3CODE_CLERK_PUBLISHABLE_KEY: forkKey,
      T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_fork",
      T3CODE_RELAY_URL: "https://relay.fork.example.test/",
    };
    const existingAliases = {
      VITE_CLERK_PUBLISHABLE_KEY: upstreamKey,
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: upstreamKey,
      VITE_T3CODE_RELAY_URL: "https://relay.t3.codes",
    };
    expect(build({ T3CODE_DISTRIBUTION: "fork", ...existingAliases })).toMatchObject({
      VITE_CLERK_PUBLISHABLE_KEY: "",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      VITE_T3CODE_RELAY_URL: "",
    });
    expect(build({ T3CODE_DISTRIBUTION: "fork", ...existingAliases, ...canonical })).toMatchObject({
      VITE_CLERK_PUBLISHABLE_KEY: forkKey,
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: forkKey,
      VITE_T3CODE_RELAY_URL: "https://relay.fork.example.test",
    });
    expect(() =>
      build({ T3CODE_DISTRIBUTION: "fork", T3CODE_RELAY_URL: canonical.T3CODE_RELAY_URL }),
    ).toThrow(/all four Connect settings/);
    expect(() =>
      build({
        T3CODE_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_CLERK_PUBLISHABLE_KEY: upstreamKey,
      }),
    ).toThrow(/fork-owned Clerk/);
    expect(() =>
      build({
        T3CODE_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_RELAY_URL: "https://relay.t3.codes.",
      }),
    ).toThrow(/fork-owned HTTPS/);
    expect(() =>
      build({
        T3CODE_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "accounts.fork.example.test, clerk.t3.codes",
      }),
    ).toThrow(/T3CODE_CLERK_PASSKEY_RP_DOMAINS must use fork-owned domains/);
  });

  it("clears leaked tracing variables when fork monitoring is disabled and validates when enabled", () => {
    const repoRoot = makeTemporaryDirectory();
    const forkKey = `pk_live_${btoa("accounts.fork.example.test$")}`;
    const canonical = {
      T3CODE_CLERK_PUBLISHABLE_KEY: forkKey,
      T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_fork",
      T3CODE_RELAY_URL: "https://relay.fork.example.test",
    };
    const leaked = {
      VITE_RELAY_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "upstream-dataset",
      VITE_RELAY_OTLP_TRACES_TOKEN: "upstream-token",
      EXPO_PUBLIC_OTLP_TRACES_URL: "https://api.axiom.co/v1/traces",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "upstream-mobile",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "upstream-mobile-token",
    };
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https://stale.example.test/v1/traces\n" +
        "T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=stale-dataset\n" +
        "T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=stale-token\n",
    );

    const build = (baseEnv: Record<string, string>) => loadRepoEnv({ baseEnv, repoRoot });

    expect(
      build({
        T3CODE_DISTRIBUTION: "fork",
        T3CODE_RELAY_OBSERVABILITY_ENABLED: "false",
        ...canonical,
        ...leaked,
      }),
    ).toMatchObject({
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "",
      VITE_RELAY_OTLP_TRACES_URL: "",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "",
      VITE_RELAY_OTLP_TRACES_DATASET: "",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "",
      VITE_RELAY_OTLP_TRACES_TOKEN: "",
      T3CODE_MOBILE_OTLP_TRACES_URL: "",
      EXPO_PUBLIC_OTLP_TRACES_URL: "",
      T3CODE_MOBILE_OTLP_TRACES_DATASET: "",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "",
      T3CODE_MOBILE_OTLP_TRACES_TOKEN: "",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "",
    });

    const cleanRoot = makeTemporaryDirectory();
    const buildClean = (baseEnv: Record<string, string>) =>
      loadRepoEnv({ baseEnv, repoRoot: cleanRoot });

    expect(buildClean({ T3CODE_DISTRIBUTION: "fork", ...leaked })).toMatchObject({
      VITE_RELAY_OTLP_TRACES_URL: "",
      VITE_RELAY_OTLP_TRACES_DATASET: "",
      VITE_RELAY_OTLP_TRACES_TOKEN: "",
      EXPO_PUBLIC_OTLP_TRACES_URL: "",
      EXPO_PUBLIC_OTLP_TRACES_DATASET: "",
      EXPO_PUBLIC_OTLP_TRACES_TOKEN: "",
    });

    expect(() =>
      buildClean({
        T3CODE_DISTRIBUTION: "fork",
        T3CODE_RELAY_OBSERVABILITY_ENABLED: "maybe",
      }),
    ).toThrow(/T3CODE_RELAY_OBSERVABILITY_ENABLED must be true or false/);

    expect(() =>
      buildClean({
        T3CODE_DISTRIBUTION: "fork",
        T3CODE_RELAY_OBSERVABILITY_ENABLED: "true",
      }),
    ).toThrow(/Configure fork Connect settings before enabling relay monitoring/);

    expect(() =>
      buildClean({
        T3CODE_DISTRIBUTION: "fork",
        T3CODE_RELAY_OBSERVABILITY_ENABLED: "true",
        ...canonical,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
      }),
    ).toThrow(
      /Missing fork tracing configuration: T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET, T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN/,
    );

    expect(() =>
      buildClean({
        T3CODE_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "http://traces.fork.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "fork-traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "fork-token",
      }),
    ).toThrow(/T3CODE_RELAY_CLIENT_OTLP_TRACES_URL must be a non-upstream HTTPS URL/);

    expect(() =>
      buildClean({
        T3CODE_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_MOBILE_OTLP_TRACES_URL: "https://traces.t3.codes/v1/traces",
        T3CODE_MOBILE_OTLP_TRACES_DATASET: "mobile-traces",
        T3CODE_MOBILE_OTLP_TRACES_TOKEN: "mobile-token",
      }),
    ).toThrow(/T3CODE_MOBILE_OTLP_TRACES_URL must be a non-upstream HTTPS URL/);

    expect(
      buildClean({
        T3CODE_DISTRIBUTION: "fork",
        T3CODE_RELAY_OBSERVABILITY_ENABLED: "true",
        ...canonical,
        T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "fork-traces",
        T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "fork-token",
      }),
    ).toMatchObject({
      T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
      VITE_RELAY_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "fork-traces",
      VITE_RELAY_OTLP_TRACES_DATASET: "fork-traces",
      T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "fork-token",
      VITE_RELAY_OTLP_TRACES_TOKEN: "fork-token",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
