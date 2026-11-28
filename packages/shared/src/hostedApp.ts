import { UPSTREAM_PUBLIC_PRODUCT_CONFIG, type PublicProductConfig } from "./productConfig.ts";

declare const __T3CODE_BUILD_PRODUCT_CONFIG__: PublicProductConfig | undefined;

/** Builds define the resolved config; an unbuilt source tree is the upstream distribution. */
const publicProductConfig: PublicProductConfig =
  typeof __T3CODE_BUILD_PRODUCT_CONFIG__ === "undefined"
    ? UPSTREAM_PUBLIC_PRODUCT_CONFIG
    : __T3CODE_BUILD_PRODUCT_CONFIG__;

export const hostedWeb = publicProductConfig.hostedWeb;
export const hostedAppGenerateOrigin = publicProductConfig.links.generate;
export const hostedAppLinkOrigins = publicProductConfig.links.accept;
export const hostedAppAuthOrigins = publicProductConfig.links.authReturn;
