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
    expect(build({ T3CODE_CONNECT_DISTRIBUTION: "fork", ...existingAliases })).toMatchObject({
      VITE_CLERK_PUBLISHABLE_KEY: "",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "",
      VITE_T3CODE_RELAY_URL: "",
    });
    expect(
      build({ T3CODE_MOBILE_DISTRIBUTION: "fork", ...existingAliases, ...canonical }),
    ).toMatchObject({
      VITE_CLERK_PUBLISHABLE_KEY: forkKey,
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: forkKey,
      VITE_T3CODE_RELAY_URL: "https://relay.fork.example.test",
    });
    expect(() =>
      build({ T3CODE_CONNECT_DISTRIBUTION: "fork", T3CODE_RELAY_URL: canonical.T3CODE_RELAY_URL }),
    ).toThrow(/all four Connect settings/);
    expect(() =>
      build({
        T3CODE_MOBILE_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_CLERK_PUBLISHABLE_KEY: upstreamKey,
      }),
    ).toThrow(/fork-owned Clerk/);
    expect(() =>
      build({
        T3CODE_CONNECT_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_RELAY_URL: "https://relay.t3.codes.",
      }),
    ).toThrow(/fork-owned HTTPS relay/);
    expect(() =>
      build({
        T3CODE_CONNECT_DISTRIBUTION: "fork",
        ...canonical,
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "accounts.fork.example.test, clerk.t3.codes",
      }),
    ).toThrow(/T3CODE_CLERK_PASSKEY_RP_DOMAINS must use fork-owned domains/);
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
