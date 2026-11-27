import { DESKTOP_APP_ID } from "@t3tools/shared/productIdentity";
import type { Plugin } from "vite-plus";

export function forkMobileLinks(env: Readonly<Record<string, string | undefined>>): Plugin {
  const teamId = env.T3CODE_MOBILE_APPLE_TEAM_ID?.trim();
  if (teamId && !/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new Error("T3CODE_MOBILE_APPLE_TEAM_ID must be a 10-character Apple team ID.");
  }
  const fingerprint = env.T3CODE_MOBILE_ANDROID_CERT_SHA256?.trim().toUpperCase();
  if (fingerprint && !/^[A-F0-9]{2}(?::[A-F0-9]{2}){31}$/.test(fingerprint)) {
    throw new Error(
      "T3CODE_MOBILE_ANDROID_CERT_SHA256 must be a colon-delimited SHA-256 fingerprint.",
    );
  }

  return {
    name: "t3code:fork-mobile-links",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: ".well-known/apple-app-site-association.json",
        source: JSON.stringify({
          applinks: {
            details: teamId
              ? [{ appIDs: [`${teamId}.${DESKTOP_APP_ID}`], components: [{ "/": "/threads/*" }] }]
              : [],
          },
        }),
      });
      this.emitFile({
        type: "asset",
        fileName: ".well-known/assetlinks.json",
        source: JSON.stringify(
          fingerprint
            ? [
                {
                  relation: ["delegate_permission/common.handle_all_urls"],
                  target: {
                    namespace: "android_app",
                    package_name: DESKTOP_APP_ID,
                    sha256_cert_fingerprints: [fingerprint],
                  },
                },
              ]
            : [],
        ),
      });
    },
  };
}
