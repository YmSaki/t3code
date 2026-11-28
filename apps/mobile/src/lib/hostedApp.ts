import type { ScopedThreadRef } from "@t3tools/contracts";
import { hostedAppGenerateOrigin, hostedAppLinkOrigins } from "@t3tools/shared/hostedApp";
import { buildNewThreadLink, promptLinkDeepLink } from "@t3tools/shared/promptLinks";
import { createThreadLinkMatcher, hostedThreadLink } from "@t3tools/shared/threadLinks";
import Constants from "expo-constants";
import { mobileAppScheme } from "./appScheme";

const configuredUrl: unknown = Constants.expoConfig?.extra?.hostedAppUrl;
const configuredOrigins: unknown = Constants.expoConfig?.extra?.hostedAppOrigins;

export const mobileHostedAppUrl =
  configuredUrl === null || typeof configuredUrl === "string"
    ? configuredUrl?.trim() || null
    : hostedAppGenerateOrigin;

export const mobileThreadLinkMatcher = createThreadLinkMatcher([
  ...new Set([
    ...(mobileHostedAppUrl ? [mobileHostedAppUrl] : []),
    ...(Array.isArray(configuredOrigins)
      ? configuredOrigins.filter((origin): origin is string => typeof origin === "string")
      : hostedAppLinkOrigins),
  ]),
]);

// Only the path is kept; the product has no hosted Web to name.
const DEEP_LINK_ONLY_ORIGIN = "https://app.invalid";

export function mobileThreadShareUrl(ref: ScopedThreadRef): string {
  if (mobileHostedAppUrl) return hostedThreadLink(ref, mobileHostedAppUrl);
  const url = hostedThreadLink(ref, DEEP_LINK_ONLY_ORIGIN);
  return `${mobileAppScheme()}://${new URL(url).pathname.slice(1)}`;
}

export function mobilePromptShareUrl(prompt: string): string {
  if (mobileHostedAppUrl) return buildNewThreadLink({ prompt, origin: mobileHostedAppUrl });
  const url = new URL(buildNewThreadLink({ prompt, origin: DEEP_LINK_ONLY_ORIGIN }));
  return promptLinkDeepLink(url.pathname + url.search, mobileAppScheme());
}
