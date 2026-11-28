import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";
import eas from "./eas.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () =>
    Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          key === "APP_VARIANT" ||
          key.startsWith("T3CODE_WEB_") ||
          key.startsWith("T3CODE_MOBILE_") ||
          key.startsWith("T3CODE_RELAY_") ||
          key.startsWith("EXPO_PUBLIC_OTLP_") ||
          key.startsWith("T3CODE_IOS_PERSONAL_TEAM"),
      ),
    ),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

it("uses the fork router in native associations and the link settings sent to JavaScript", async () => {
  vi.stubEnv("T3CODE_WEB_ROUTER_URL", "https://fork.example.test");
  vi.stubEnv("T3CODE_WEB_LATEST_DOMAIN", "stable.fork.example.test");
  vi.stubEnv("T3CODE_WEB_NIGHTLY_DOMAIN", "nightly.fork.example.test");
  const config = await loadConfig("production");
  expect(config.ios?.associatedDomains).toContain("applinks:fork.example.test");
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host: "fork.example.test", pathPrefix: "/threads/" },
  ]);
  expect(config.extra).toMatchObject({
    hostedAppUrl: "https://fork.example.test",
    hostedAppOrigins: [
      "https://fork.example.test",
      "https://stable.fork.example.test",
      "https://nightly.fork.example.test",
    ],
  });
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it.each([
  ["production", "io.github.ymsaki.t3codejp", "t3codejp"],
  ["development", "io.github.ymsaki.t3codejp.dev", "t3codejp-dev"],
  ["preview", "io.github.ymsaki.t3codejp.preview", "t3codejp-preview"],
])(
  "isolates the fork's %s app and disables OTA without a fork project",
  async (appVariant, id, scheme) => {
    vi.stubEnv("T3CODE_MOBILE_DISTRIBUTION", "fork");
    const config = await loadConfig(appVariant);
    expect(config.ios?.bundleIdentifier).toBe(id);
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.ios?.associatedDomains).toEqual([]);
    expect(config.android?.package).toBe(id);
    expect(config.android?.intentFilters).toEqual([]);
    expect(config.scheme).toBe(scheme);
    expect(config.owner).toBeUndefined();
    expect(config.updates).toMatchObject({ enabled: false });
    expect(config.updates?.url).toBeUndefined();
    expect(config.extra?.eas.projectId).toBeUndefined();
    expect(config.extra?.hostedAppUrl).toBe("");
    expect(config.extra?.observability).toEqual({
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    });
    expect(config.extra?.eas?.observe?.endpointUrl).toBe("https://observe.invalid");
  },
);

it("does not fall back to upstream Axiom or enable Observe when fork monitoring is disabled", async () => {
  vi.stubEnv("T3CODE_MOBILE_DISTRIBUTION", "fork");
  vi.stubEnv("T3CODE_RELAY_URL", "https://relay.fork.example.test");
  const config = await loadConfig("production");
  expect(config.extra?.observability).toEqual({
    tracesUrl: null,
    tracesDataset: null,
    tracesToken: null,
  });
  expect(config.extra?.eas?.observe?.endpointUrl).toBe("https://observe.invalid");
});

it("wires fork OTLP tracing and Observe when fork monitoring is explicitly enabled", async () => {
  vi.stubEnv("T3CODE_MOBILE_DISTRIBUTION", "fork");
  vi.stubEnv("T3CODE_RELAY_URL", "https://relay.fork.example.test");
  vi.stubEnv("T3CODE_RELAY_OBSERVABILITY_ENABLED", "true");
  vi.stubEnv("EXPO_PUBLIC_OTLP_TRACES_URL", "https://traces.fork.example.test/v1/traces");
  vi.stubEnv("EXPO_PUBLIC_OTLP_TRACES_DATASET", "fork-mobile-traces");
  vi.stubEnv("EXPO_PUBLIC_OTLP_TRACES_TOKEN", "fork-mobile-token");
  const config = await loadConfig("production");
  expect(config.extra?.observability).toEqual({
    tracesUrl: "https://traces.fork.example.test/v1/traces",
    tracesDataset: "fork-mobile-traces",
    tracesToken: "fork-mobile-token",
  });
  expect(config.extra?.eas?.observe?.endpointUrl).toBe(
    "https://relay.fork.example.test/v1/mobile/observe",
  );
});

it.each(["fork-android", "fork-ios"] as const)(
  "binds %s to the fork's EAS project",
  async (profile) => {
    const projectId = "11223344-aabb-4cdd-8eff-123456789abc";
    for (const [key, value] of Object.entries(eas.build[profile].env)) vi.stubEnv(key, value);
    vi.stubEnv("T3CODE_MOBILE_EAS_OWNER", "fork-publisher");
    vi.stubEnv("T3CODE_MOBILE_EAS_PROJECT_ID", projectId);
    vi.stubEnv("T3CODE_MOBILE_APPLE_TEAM_ID", "FORKTEAM12");
    const config = await loadConfig("production");
    expect(config.owner).toBe("fork-publisher");
    expect(config.extra?.eas.projectId).toBe(projectId);
    expect(config.updates).toMatchObject({ enabled: true, url: `https://u.expo.dev/${projectId}` });
    expect(config.runtimeVersion).toEqual({ policy: "fingerprint" });
    expect(config.ios?.appleTeamId).toBe("FORKTEAM12");
  },
);

it.each([
  ["pingdotgg", "11223344-aabb-4cdd-8eff-123456789abc", "own Expo account and EAS project"],
  ["fork-publisher", "d763fcb8-d37c-41ea-a773-b54a0ab4a454", "own Expo account and EAS project"],
  [undefined, undefined, "OTA updates require a fork EAS project"],
])("rejects an incomplete or upstream fork OTA configuration", async (owner, project, error) => {
  vi.stubEnv("T3CODE_MOBILE_DISTRIBUTION", "fork");
  vi.stubEnv("T3CODE_MOBILE_EAS_OWNER", owner);
  vi.stubEnv("T3CODE_MOBILE_EAS_PROJECT_ID", project);
  vi.stubEnv("T3CODE_MOBILE_UPDATES_ENABLED", "1");
  await expect(loadConfig("production")).rejects.toThrow(error);
});
