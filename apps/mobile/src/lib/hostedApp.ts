import type { ScopedThreadRef } from "@t3tools/contracts";
import { hostedAppLinkOrigins, hostedAppRouting } from "@t3tools/shared/hostedApp";
import { buildNewThreadLink, promptLinkDeepLink } from "@t3tools/shared/promptLinks";
import { createThreadLinkMatcher, hostedThreadLink } from "@t3tools/shared/threadLinks";
import Constants from "expo-constants";
import { mobileAppScheme } from "./appScheme";

const configuredUrl: unknown = Constants.expoConfig?.extra?.hostedAppUrl;
const configuredOrigins: unknown = Constants.expoConfig?.extra?.hostedAppOrigins;

export const mobileHostedAppUrl =
  configuredUrl === null || typeof configuredUrl === "string"
    ? configuredUrl?.trim() || null
    : hostedAppRouting.router;

export const mobileThreadLinkMatcher = createThreadLinkMatcher([
  ...new Set([
    ...(mobileHostedAppUrl ? [mobileHostedAppUrl] : []),
    ...(Array.isArray(configuredOrigins)
      ? configuredOrigins.filter((origin): origin is string => typeof origin === "string")
      : []),
    ...hostedAppLinkOrigins,
  ]),
]);

export function mobileThreadShareUrl(ref: ScopedThreadRef): string {
  const url = hostedThreadLink(ref, mobileHostedAppUrl ?? undefined);
  if (mobileHostedAppUrl) return url;
  return `${mobileAppScheme()}://${new URL(url).pathname.slice(1)}`;
}

export function mobilePromptShareUrl(prompt: string): string {
  if (mobileHostedAppUrl) return buildNewThreadLink({ prompt, origin: mobileHostedAppUrl });
  const url = new URL(buildNewThreadLink({ prompt }));
  return promptLinkDeepLink(url.pathname + url.search, mobileAppScheme());
}
