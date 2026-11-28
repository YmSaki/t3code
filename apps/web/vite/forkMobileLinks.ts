import { DESKTOP_APP_ID } from "@t3tools/shared/productIdentity";
import type { MobileRelease } from "@t3tools/shared/productConfig";
import type { Plugin } from "vite-plus";

export function forkMobileLinks(
  mobile: Pick<MobileRelease, "appleTeamId" | "androidCertSha256">,
): Plugin {
  const teamId = mobile.appleTeamId;
  const fingerprint = mobile.androidCertSha256;

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
