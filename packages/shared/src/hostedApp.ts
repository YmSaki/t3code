export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

const defaultRouting = {
  router: DEFAULT_HOSTED_APP_URL,
  stable: "https://latest.app.t3.codes",
  nightly: "https://nightly.app.t3.codes",
};

declare const __T3CODE_BUILD_HOSTED_APP_ROUTING__: typeof defaultRouting | null | undefined;

const buildRouting =
  typeof __T3CODE_BUILD_HOSTED_APP_ROUTING__ === "undefined"
    ? null
    : __T3CODE_BUILD_HOSTED_APP_ROUTING__;

export const hostedAppRouting = buildRouting ?? defaultRouting;
export const hostedAppAuthOrigins = buildRouting
  ? Object.values(buildRouting)
  : [DEFAULT_HOSTED_APP_URL];
export const hostedAppLinkOrigins = [...new Set([...hostedAppAuthOrigins, DEFAULT_HOSTED_APP_URL])];

function normalizeHttpsOrigin(value: string | undefined): URL | undefined {
  const url = value && URL.parse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.href !== `${url.origin}/`
  ) {
    return undefined;
  }
  return url;
}

export function hostedAppRoutingFromEnv(env: Readonly<Record<string, string | undefined>>) {
  const routerUrl = env.T3CODE_WEB_ROUTER_URL?.trim();
  const stableDomain = env.T3CODE_WEB_LATEST_DOMAIN?.trim();
  const nightlyDomain = env.T3CODE_WEB_NIGHTLY_DOMAIN?.trim();
  if (!routerUrl && !stableDomain && !nightlyDomain) return null;

  const router = normalizeHttpsOrigin(routerUrl);
  if (!router || !/^[a-z0-9.-]+$/i.test(router.hostname)) {
    throw new Error("T3CODE_WEB_ROUTER_URL must be an HTTPS domain origin.");
  }
  function channelOrigin(name: string, domain: string | undefined) {
    if (!domain || !/^[a-z0-9.-]+$/i.test(domain)) {
      throw new Error(`${name} must be a domain name.`);
    }
    const url = normalizeHttpsOrigin(`https://${domain}`);
    if (!url) throw new Error(`${name} must be a domain name.`);
    return url.origin;
  }
  const stable = channelOrigin("T3CODE_WEB_LATEST_DOMAIN", stableDomain);
  const nightly = channelOrigin("T3CODE_WEB_NIGHTLY_DOMAIN", nightlyDomain);
  if (new Set([router.origin, stable, nightly]).size !== 3) {
    throw new Error("The hosted Web router, Stable, and Nightly must use distinct domains.");
  }
  return { router: router.origin, stable, nightly };
}
