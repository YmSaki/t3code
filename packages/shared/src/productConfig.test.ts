import { describe, expect, it } from "vite-plus/test";

import { resolveProductConfig } from "./productConfig.ts";

const forkKey = `pk_live_${btoa("accounts.fork.example.test$")}`;
const web = {
  T3CODE_WEB_ROUTER_URL: "https://app.fork.example.test",
  T3CODE_WEB_LATEST_DOMAIN: "latest.fork.example.test",
  T3CODE_WEB_NIGHTLY_DOMAIN: "nightly.fork.example.test",
};
const connect = {
  T3CODE_CLERK_PUBLISHABLE_KEY: forkKey,
  T3CODE_CLERK_JWT_TEMPLATE: "template",
  T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "client",
  T3CODE_RELAY_URL: "https://relay.fork.example.test",
};
const fork = { T3CODE_DISTRIBUTION: "fork" };

describe("resolveProductConfig", () => {
  it("resolves upstream by default with upstream links", () => {
    const config = resolveProductConfig({});
    expect(config.distribution).toBe("upstream");
    expect(config.connect.kind).toBe("unmanaged");
    expect(config.links.generate).toBe("https://app.t3.codes");
    expect(config.links.authReturn).toContain("https://nightly.app.t3.codes");
  });

  it("treats an unconfigured fork as disabled services, never upstream", () => {
    const config = resolveProductConfig(fork);
    expect(config.hostedWeb).toEqual({ kind: "disabled" });
    expect(config.connect).toEqual({ kind: "disabled" });
    expect(config.links.generate).toBeNull();
    expect(config.links.authReturn).toEqual([]);
    expect(config.mobile).toMatchObject({ projectId: undefined, updatesEnabled: false });
  });

  it("generates fork links only and accepts upstream links as compatibility", () => {
    const config = resolveProductConfig({ ...fork, ...web });
    expect(config.links.generate).toBe("https://app.fork.example.test");
    expect(config.links.authReturn).not.toContain("https://app.t3.codes");
    expect(config.links.accept).toEqual(
      expect.arrayContaining([
        "https://app.fork.example.test",
        "https://latest.fork.example.test",
        "https://app.t3.codes",
      ]),
    );
  });

  it.each([
    [{ T3CODE_WEB_ROUTER_URL: web.T3CODE_WEB_ROUTER_URL }, "all three"],
    [{ ...web, T3CODE_WEB_ROUTER_URL: "https://app.t3.codes" }, "fork-owned"],
    [{ ...web, T3CODE_WEB_LATEST_DOMAIN: "latest.t3.codes" }, "fork-owned"],
    [{ ...web, T3CODE_WEB_NIGHTLY_DOMAIN: "latest.fork.example.test" }, "distinct"],
    [{ ...web, T3CODE_WEB_ROUTER_URL: "http://app.fork.example.test" }, "HTTPS"],
  ])("rejects invalid hosted Web settings %#", (settings, message) => {
    expect(() => resolveProductConfig({ ...fork, ...settings })).toThrow(message);
  });

  it("rejects fork-only settings that leak into an upstream build", () => {
    expect(() => resolveProductConfig(web)).toThrow("T3CODE_DISTRIBUTION=fork");
    expect(() => resolveProductConfig({ T3CODE_MOBILE_APPLE_TEAM_ID: "ABCDE12345" })).toThrow(
      "T3CODE_DISTRIBUTION=fork",
    );
    expect(() => resolveProductConfig({ T3CODE_DISTRIBUTION: "other" })).toThrow(
      "upstream or fork",
    );
  });

  it("enables Connect only when complete and fork-owned", () => {
    expect(resolveProductConfig({ ...fork, ...connect }).connect).toMatchObject({
      kind: "enabled",
      relayUrl: "https://relay.fork.example.test",
    });
    expect(() => resolveProductConfig({ ...fork, ...connect, T3CODE_RELAY_URL: "" })).toThrow(
      "all four",
    );
    expect(() =>
      resolveProductConfig({
        ...fork,
        ...connect,
        T3CODE_CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("clerk.t3.codes$")}`,
      }),
    ).toThrow("fork-owned Clerk");
    expect(() =>
      resolveProductConfig({ ...fork, ...connect, T3CODE_RELAY_URL: "https://relay.t3.codes" }),
    ).toThrow("fork-owned");
    expect(() =>
      resolveProductConfig({
        ...fork,
        ...connect,
        T3CODE_CLERK_PASSKEY_RP_DOMAINS: "app.t3.codes",
      }),
    ).toThrow("fork-owned domains");
  });

  it("rejects upstream mobile identities for a fork", () => {
    const project = "11111111-2222-4333-8444-555555555555";
    expect(
      resolveProductConfig({
        ...fork,
        T3CODE_MOBILE_EAS_OWNER: "me",
        T3CODE_MOBILE_EAS_PROJECT_ID: project,
      }).mobile,
    ).toMatchObject({ owner: "me", projectId: project, updatesEnabled: true });
    for (const settings of [
      { T3CODE_MOBILE_EAS_OWNER: "me" },
      { T3CODE_MOBILE_EAS_OWNER: "pingdotgg", T3CODE_MOBILE_EAS_PROJECT_ID: project },
      { T3CODE_MOBILE_EAS_OWNER: "me", T3CODE_MOBILE_EAS_PROJECT_ID: "not-a-uuid" },
      { T3CODE_MOBILE_UPDATES_ENABLED: "1" },
      { T3CODE_MOBILE_APPLE_TEAM_ID: "ARK85ZXQ4Z" },
      { T3CODE_MOBILE_CLERK_DOMAIN: "clerk.t3.codes" },
    ]) {
      expect(() => resolveProductConfig({ ...fork, ...settings })).toThrow();
    }
  });
});
