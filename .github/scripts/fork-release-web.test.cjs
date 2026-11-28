const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { test } = require("node:test");
const { planForkWebRelease } = require("./fork-release-web.cjs");

const routing = {
  T3CODE_WEB_ROUTER_URL: "https://app.example.test",
  T3CODE_WEB_LATEST_DOMAIN: "latest.example.test",
  T3CODE_WEB_NIGHTLY_DOMAIN: "nightly.example.test",
};
const sha = "f".repeat(40);
const context = {
  repo: { owner: "YmSaki", repo: "t3codeJP" },
  payload: { repository: { default_branch: "main" } },
};

function fixture(tag, overrides = {}, status = "ahead") {
  const version = tag.slice(1);
  const assets = [
    ...[
      "darwin-arm64.tar.gz",
      "linux-x64.tar.gz",
      "linux-arm64.tar.gz",
      "win32-x64.zip",
      "win32-arm64.zip",
    ].map((platform) => `t3-${version}-${platform}`),
    "SHA256SUMS",
    "t3code-release.json",
    "install.sh",
    "install.ps1",
  ].map((name) => ({ name, state: "uploaded", size: 10 }));
  const github = {
    rest: {
      repos: {
        async getReleaseByTag(input) {
          assert.deepEqual(input, { ...context.repo, tag });
          return {
            data: {
              tag_name: tag,
              draft: false,
              prerelease: tag.includes("nightly"),
              published_at: "2026-11-27T00:00:00Z",
              assets,
              ...overrides,
            },
          };
        },
        async getCommit(input) {
          assert.deepEqual(input, { ...context.repo, ref: `tags/${tag}` });
          return { data: { sha } };
        },
        async compareCommitsWithBasehead(input) {
          assert.equal(input.basehead, `${sha}...main`);
          return { data: { status } };
        },
      },
    },
  };
  return { github, context, tag, env: routing };
}

for (const [tag, channel] of [
  ["v1.2.3", "latest"],
  ["v1.2.4-nightly.20261127.2", "nightly"],
]) {
  test(`fork hosted Web selects ${channel} for the exact release commit`, async () => {
    assert.deepEqual(await planForkWebRelease({ ...fixture(tag), expectedSha: sha }), {
      sha,
      version: tag.slice(1),
      channel,
      routerUrl: routing.T3CODE_WEB_ROUTER_URL,
      latestDomain: routing.T3CODE_WEB_LATEST_DOMAIN,
      nightlyDomain: routing.T3CODE_WEB_NIGHTLY_DOMAIN,
    });
  });
}

test("fork hosted Web requires a published Stable or Nightly tag on main", async () => {
  const tag = "v1.2.3";
  for (const input of [
    fixture("v1.2.3-preview.20261127.1"),
    fixture("update-feed"),
    fixture(tag, { draft: true }),
    fixture(tag, { published_at: null }),
    fixture(tag, { prerelease: true }),
  ]) {
    await assert.rejects(planForkWebRelease(input), /published/);
  }
  await assert.rejects(planForkWebRelease(fixture(tag, {}, "diverged")), /contained in main/);
  await assert.rejects(
    planForkWebRelease({ ...fixture(tag), expectedSha: "a".repeat(40) }),
    /does not match the source commit/,
  );
});

test("fork hosted Web requires usable release assets and independent domains", async () => {
  const tag = "v1.2.3";
  const assets = [
    { name: "SHA256SUMS", state: "uploaded", size: 0 },
    { name: "install.ps1", state: "starter", size: 10 },
  ];
  await assert.rejects(
    planForkWebRelease(fixture(tag, { assets })),
    /missing CLI release assets: .*t3-1\.2\.3-win32-arm64\.zip.*SHA256SUMS.*install\.ps1/,
  );
  await assert.rejects(
    planForkWebRelease({ ...fixture(tag), env: {} }),
    /Set the three fork hosted Web repository variables/,
  );
  await assert.rejects(
    planForkWebRelease({
      ...fixture(tag),
      env: { ...routing, T3CODE_WEB_NIGHTLY_DOMAIN: "nightly.app.t3.codes" },
    }),
    /fork-owned/,
  );
});

const deploymentUrl = "https://fork-deployment.vercel.app";

function runDeployment(channel, output, status = 0, extraEnv = {}) {
  const shell = `vp() {
    if [[ $3 == deploy ]]; then
      shift 3
      printf 'argument:%s\\n' "$@" >&2
      printf '%s\\n' "$MOCK_OUTPUT"
      return "$MOCK_STATUS"
    fi
    printf 'alias:%s:%s\\n' "$5" "$6"
  }
  source .github/scripts/deploy-fork-web.sh`;
  const result = spawnSync("bash", ["-c", shell], {
    cwd: join(__dirname, "../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      ...routing,
      APP_VERSION: "1.2.3",
      GITHUB_REPOSITORY: "YmSaki/t3codeJP",
      T3CODE_CLERK_PUBLISHABLE_KEY: "fake-publishable-key",
      T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "fake-oauth-client",
      T3CODE_RELAY_URL: "https://relay.example.test",
      VERCEL_TOKEN: "fake-token",
      VERCEL_ORG_ID: "fake-org",
      VERCEL_PROJECT_ID: "fake-project",
      VITE_HOSTED_APP_CHANNEL: channel,
      MOCK_OUTPUT: output,
      MOCK_STATUS: String(status),
      ...extraEnv,
    },
  });
  assert.ifError(result.error);
  const aliases = result.stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("alias:"))
    .map((line) => line.slice("alias:".length));
  return { ...result, aliases };
}

for (const [channel, domains] of [
  ["latest", ["latest.example.test", "app.example.test"]],
  ["nightly", ["nightly.example.test"]],
]) {
  test(`fork hosted Web promotes only the ${channel} domains after a successful staged build`, () => {
    const result = runDeployment(channel, `Lockfile warning\n${deploymentUrl}`);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /argument:--skip-domain/);
    assert.match(result.stderr, /argument:T3CODE_DESKTOP_UPDATE_REPOSITORY=YmSaki\/t3codeJP/);
    assert.match(result.stderr, /argument:T3CODE_DISTRIBUTION=fork/);
    assert.match(result.stderr, /argument:T3CODE_RELAY_URL=https:\/\/relay\.example\.test/);
    assert.match(result.stderr, /argument:T3CODE_RELAY_OBSERVABILITY_ENABLED=false/);
    assert.match(result.stderr, /argument:T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=\r?\n/);
    assert.deepEqual(
      result.aliases,
      domains.map((domain) => `${deploymentUrl}:${domain}`),
    );
  });
}

test("fork hosted Web forwards client tracing settings when monitoring is enabled", () => {
  const result = runDeployment("latest", deploymentUrl, 0, {
    T3CODE_RELAY_OBSERVABILITY_ENABLED: "true",
    T3CODE_RELAY_CLIENT_OTLP_TRACES_URL: "https://traces.fork.example.test/v1/traces",
    T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET: "fork-traces",
    T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN: "fork-token",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /argument:T3CODE_RELAY_OBSERVABILITY_ENABLED=true/);
  assert.match(
    result.stderr,
    /argument:T3CODE_RELAY_CLIENT_OTLP_TRACES_URL=https:\/\/traces\.fork\.example\.test\/v1\/traces/,
  );
  assert.match(result.stderr, /argument:T3CODE_RELAY_CLIENT_OTLP_TRACES_DATASET=fork-traces/);
  assert.match(result.stderr, /argument:T3CODE_RELAY_CLIENT_OTLP_TRACES_TOKEN=fork-token/);
});

test("fork hosted Web never promotes a failed or ambiguous build", () => {
  for (const [output, status] of [
    [deploymentUrl, 1],
    [`${deploymentUrl}\nhttps://other.vercel.app`, 0],
    ["No deployment URL", 0],
  ]) {
    const result = runDeployment("latest", output, status);
    assert.notEqual(result.status, 0);
    assert.deepEqual(result.aliases, []);
  }
});
