import { matchers, type Transform, type VercelConfig } from "@vercel/config/v1";
import { resolveProductConfig } from "@t3tools/shared/productConfig";

const { hostedWeb: routing } = resolveProductConfig(process.env);
if (routing.kind === "disabled") {
  throw new Error("Hosted Web deployment requires the three hosted Web settings.");
}
const routerHost = new URL(routing.router).hostname;
const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    {
      src: "/__t3code/channel",
      has: [matchers.query("channel", "nightly")],
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("nightly"),
      },
      status: 302,
    },
    {
      src: "/__t3code/channel",
      transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
      headers: {
        Location: "/",
        "Set-Cookie": channelCookie("latest"),
      },
      status: 302,
    },
    {
      src: "/(.*)",
      has: [matchers.host(routerHost), matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly")],
      dest: `${routing.nightly}/$1`,
    },
    {
      src: "/(.*)",
      has: [matchers.host(routerHost)],
      dest: `${routing.stable}/$1`,
    },
    // Apple fetches it without an extension; the .json file is served as application/json.
    {
      src: "^/\\.well-known/apple-app-site-association$",
      dest: "/.well-known/apple-app-site-association.json",
    },
    { handle: "filesystem" },
    { src: "/(.*)", dest: "/index.html" },
  ],
};
