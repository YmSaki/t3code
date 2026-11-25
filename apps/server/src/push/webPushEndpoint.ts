import { WebPushError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { isLocalIpLiteral } from "../utils/publicAddresses.ts";

// URL.parse normalizes away empty userinfo and accepts HTTPS URLs with missing slashes.
const HTTPS_AUTHORITY_WITHOUT_USERINFO = /^https:\/\/[^\s/@\\?#]+(?:[/?#]|$)/i;

export const parseWebPushEndpoint = Effect.fn("WebPushEndpoint.parse")(function* (
  endpoint: string,
) {
  const url = URL.parse(endpoint);
  if (!url || !HTTPS_AUTHORITY_WITHOUT_USERINFO.test(endpoint)) {
    return yield* new WebPushError({
      reason: "invalid_subscription",
      message:
        endpoint.length === 0
          ? "Web Push subscription endpoint must not be empty."
          : "Web Push subscription endpoint must be an HTTPS URL without userinfo.",
    });
  }
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  if (isLocalIpLiteral(host)) {
    return yield* new WebPushError({
      reason: "invalid_subscription",
      message: "Web Push subscription endpoint must use a public address.",
    });
  }
  return url;
});
