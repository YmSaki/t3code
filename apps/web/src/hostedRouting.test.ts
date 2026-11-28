import { expect, it, vi } from "vite-plus/test";

const fork = {
  T3CODE_DISTRIBUTION: "fork",
  T3CODE_WEB_ROUTER_URL: "https://fork.example.test",
  T3CODE_WEB_LATEST_DOMAIN: "stable.fork.example.test",
  T3CODE_WEB_NIGHTLY_DOMAIN: "nightly.fork.example.test",
};

it("uses fork channel origins in the hosted Web router", async () => {
  vi.resetModules();
  for (const [key, value] of Object.entries(fork)) vi.stubEnv(key, value);
  try {
    const { config } = await import("../vercel.ts");
    expect(config.rewrites).toBeUndefined();
    const rewrites = config.routes?.filter((route) => "dest" in route && "has" in route);
    expect(rewrites).toMatchObject([
      {
        has: [
          { type: "host", value: "fork.example.test" },
          { type: "cookie", key: "t3code_web_channel", value: "nightly" },
        ],
        dest: "https://nightly.fork.example.test/$1",
      },
      {
        has: [{ type: "host", value: "fork.example.test" }],
        dest: "https://stable.fork.example.test/$1",
      },
    ]);
    expect(config.routes?.slice(-3)).toMatchObject([
      {
        src: "^/\\.well-known/apple-app-site-association$",
        dest: "/.well-known/apple-app-site-association.json",
      },
      { handle: "filesystem" },
      { src: "/(.*)", dest: "/index.html" },
    ]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("refuses to deploy hosted Web without fork routing", async () => {
  vi.resetModules();
  vi.stubEnv("T3CODE_DISTRIBUTION", "fork");
  try {
    await expect(import("../vercel.ts")).rejects.toThrow("hosted Web settings");
  } finally {
    vi.unstubAllEnvs();
  }
});
