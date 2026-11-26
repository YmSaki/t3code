const assert = require("node:assert/strict");
const test = require("node:test");

const {
  assertForkReleaseSigningConfiguration,
  planForkRelease,
} = require("./fork-release-policy.cjs");

const now = Date.parse("2026-11-25T12:00:00Z");
const candidate = "a".repeat(40);
const promoted = "b".repeat(40);
const repo = { owner: "YmSaki", repo: "t3codeJP" };

function release(
  tagName,
  { hoursAgo = 8, isDraft = false, isPrerelease = tagName.includes("-") } = {},
) {
  return {
    tagName,
    isDraft,
    isPrerelease,
    publishedAt: isDraft ? null : new Date(now - hoursAgo * 3_600_000).toISOString(),
  };
}

function fixture({ pages = [[]], context: overrides, compare = {}, ...options } = {}) {
  const reads = [];
  const context = {
    eventName: "workflow_dispatch",
    ref: "refs/heads/main",
    repo,
    payload: { repository: { default_branch: "main" } },
    sha: candidate,
    runId: 100,
    runNumber: 23,
    ...overrides,
  };
  const github = {
    async graphql(_query, { owner, repo: name, cursor }) {
      assert.deepEqual({ owner, repo: name }, repo);
      reads.push(["releases", cursor]);
      const index = Number(cursor ?? "0");
      const hasNextPage = index + 1 < pages.length;
      return {
        repository: {
          releases: {
            nodes: pages[index],
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(index + 1) : null },
          },
        },
      };
    },
    rest: {
      actions: {
        async getWorkflowRun({ owner, repo: name, run_id }) {
          assert.deepEqual({ owner, repo: name }, repo);
          assert.equal(run_id, 100);
          reads.push(["run", run_id]);
          return { data: { created_at: "2026-11-24T23:55:00Z" } };
        },
      },
      repos: {
        async compareCommitsWithBasehead({ owner, repo: name, basehead }) {
          assert.deepEqual({ owner, repo: name }, repo);
          reads.push(["compare", basehead]);
          return { data: { status: compare[basehead] ?? "ahead" } };
        },
        async getCommit({ owner, repo: name, ref }) {
          assert.deepEqual({ owner, repo: name }, repo);
          reads.push(["commit", ref]);
          return { data: { sha: promoted } };
        },
      },
    },
  };
  return {
    reads,
    run: () => planForkRelease({ github, context, now, ...options }),
  };
}

test("starts Nightly on the fork's 1.0.0 line and stamps the original run date", async () => {
  const { run } = fixture({
    dispatchChannel: "nightly",
    publishEnabled: true,
    pages: [[release("v0.1.9")]],
  });
  const plan = await run();
  assert.equal(plan.version, "1.0.0-nightly.20261124.23");
  assert.equal(plan.tag, "v1.0.0-nightly.20261124.23");
  assert.equal(plan.name, "T3CodeJP Nightly 1.0.0-nightly.20261124.23 (aaaaaaaaaaaa)");
  assert.equal(plan.hasUpdateFeed, true);
  assert.equal(plan.isPrerelease, true);
  assert.equal(plan.makeLatest, false);
  assert.equal(plan.publish, true);
  assert.equal(plan.requireSigning, true);
});

test("uses the highest published fork Stable core across pages and ignores drafts and prereleases", async () => {
  const { run } = fixture({
    dispatchChannel: "nightly",
    pages: [
      [
        release("v1.2.9"),
        release("v99.0.0", { isDraft: true }),
        release("v88.0.0", { isPrerelease: true }),
      ],
      [release("v1.2.10"), release("v70.0.0-preview.20261125.101")],
    ],
  });
  assert.equal((await run()).version, "1.2.11-nightly.20261124.23");
});

test("plans a branch Preview as an unsigned draft with no update feed", async () => {
  const { run, reads } = fixture({ publishEnabled: true, context: { ref: "refs/heads/feature" } });
  const plan = await run();
  assert.equal(plan.version, "1.0.0-preview.20261124.23");
  assert.equal(plan.ref, candidate);
  assert.equal(plan.draft, true);
  assert.equal(plan.isPrerelease, true);
  assert.equal(plan.hasUpdateFeed, false);
  assert.equal(plan.makeLatest, false);
  assert.equal(plan.publish, true);
  assert.equal(plan.requireSigning, false);
  assert.equal(
    reads.some(([kind]) => kind === "compare"),
    false,
  );
});

test("Nightly stays unsigned and artifact-only when publication is disabled", async () => {
  const { run } = fixture({ dispatchChannel: "nightly" });
  const plan = await run();
  assert.equal(plan.shouldBuild, true);
  assert.equal(plan.publish, false);
  assert.equal(plan.requireSigning, false);
});

test("CLI-only publication keeps desktop feeds and signing validation separate", async () => {
  const plan = await fixture({
    distribution: "cli",
    dispatchChannel: "stable",
    publishEnabled: true,
  }).run();
  assert.equal(plan.distribution, "cli");
  assert.equal(plan.publish, true);
  assert.equal(plan.requireSigning, false);
  assert.equal(plan.hasUpdateFeed, false);
  assert.equal(plan.makeLatest, false);
  assert.match(plan.name, /^T3CodeJP CLI /);
  assert.equal(plan.ref, candidate);
  assert.equal(plan.version, "1.0.0");
  for (const options of [
    { distribution: "unknown" },
    { distribution: "cli", context: { eventName: "schedule" } },
    { distribution: "cli", dispatchChannel: "nightly", validateSigning: true },
    { distribution: "cli", dispatchChannel: "nightly" },
    { distribution: "cli", dispatchChannel: "stable", context: { ref: "refs/heads/feature" } },
  ]) {
    const { run, reads } = fixture(options);
    await assert.rejects(run, /distribution|CLI-only|must be dispatched from main/);
    assert.deepEqual(reads, []);
  }
  assert.equal(
    (await fixture({ distribution: "cli", dispatchChannel: "stable" }).run()).publish,
    false,
  );
});

test("manual signing validation requires signing and creates only Actions artifacts", async () => {
  for (const publishEnabled of [false, true]) {
    const { run } = fixture({
      dispatchChannel: "nightly",
      validateSigning: true,
      publishEnabled,
    });
    const plan = await run();
    assert.equal(plan.shouldBuild, true);
    assert.equal(plan.publish, false);
    assert.equal(plan.requireSigning, true);
    assert.equal(plan.hasUpdateFeed, true);
  }
});

test("signing validation rejects Preview and branch Nightly before reading releases", async () => {
  for (const dispatchChannel of ["preview", "nightly"]) {
    const { run, reads } = fixture({
      dispatchChannel,
      validateSigning: true,
      context: { ref: "refs/heads/feature" },
    });
    await assert.rejects(
      run,
      /signing validation requires a manual Nightly|must be dispatched from main/i,
    );
    assert.deepEqual(reads, []);
  }
});

test("the production signing gate rejects incomplete Apple and Azure configuration", () => {
  const config = Object.fromEntries(
    [
      "CSC_LINK",
      "CSC_KEY_PASSWORD",
      "APPLE_API_KEY",
      "APPLE_API_KEY_ID",
      "APPLE_API_ISSUER",
      "APPLE_TEAM_ID",
      "MACOS_PROVISIONING_PROFILE",
      "CLERK_PASSKEY_RP_DOMAINS",
      "AZURE_TENANT_ID",
      "AZURE_CLIENT_ID",
      "AZURE_CLIENT_SECRET",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME",
      "AZURE_TRUSTED_SIGNING_PUBLISHER_NAME",
    ].map((key) => [key, "fixture-value"]),
  );
  assert.doesNotThrow(() => assertForkReleaseSigningConfiguration(config));
  assert.throws(() => assertForkReleaseSigningConfiguration({}), {
    message: `Missing fork release signing configuration: ${Object.keys(config).join(", ")}.`,
  });

  for (const key of Object.keys(config)) {
    assert.throws(() => assertForkReleaseSigningConfiguration({ ...config, [key]: " " }), {
      message: new RegExp(`^.+: ${key}\\.$`),
    });
  }
});

test("rejects foreign repositories before inspecting release history", async () => {
  const { run, reads } = fixture({ context: { repo: { owner: "pingdotgg", repo: "t3code" } } });
  await assert.rejects(run, /only runs in YmSaki\/t3code/);
  assert.deepEqual(reads, []);
});

test("Stable dispatch promotes the latest published eligible Nightly commit on main", async () => {
  const tag = "v1.2.11-nightly.20261125.15";
  const { run, reads } = fixture({
    dispatchChannel: "stable",
    publishEnabled: true,
    pages: [
      [
        release("v1.2.10"),
        release("v0.9.0-nightly.20261125.999", { hoursAgo: 1 }),
        release("v5.0.0-preview.20261125.9", { hoursAgo: 1 }),
      ],
      [release(tag, { hoursAgo: 2 }), release("v1.2.11-nightly.20261125.999", { isDraft: true })],
    ],
  });
  const plan = await run();
  assert.equal(plan.ref, promoted);
  assert.equal(plan.tag, "v1.2.11");
  assert.equal(plan.name, "T3CodeJP v1.2.11");
  assert.equal(plan.makeLatest, true);
  assert.equal(plan.publish, true);
  assert.equal(plan.requireSigning, true);
  assert.deepEqual(
    reads.filter(([kind]) => kind === "commit"),
    [["commit", tag]],
  );
  assert.ok(reads.some(([kind, ref]) => kind === "compare" && ref === `${promoted}...main`));
});

test("a Preview or draft Nightly cannot be promoted even with a Stable version override", async () => {
  const { run } = fixture({
    dispatchChannel: "stable",
    dispatchVersion: "1.0.0",
    pages: [
      [
        release("v1.0.0-preview.20261124.11"),
        release("v1.0.0-nightly.20261124.10", { isDraft: true }),
      ],
    ],
  });
  await assert.rejects(run, /No published fork Nightly/);
});

test("promotes the Nightly commit when an explicit Stable core is requested", async () => {
  const { run } = fixture({
    dispatchChannel: "stable",
    dispatchVersion: "v1.1.0",
    pages: [[release("v1.0.0"), release("v1.0.1-nightly.20261124.10")]],
  });
  const plan = await run();
  assert.equal(plan.tag, "v1.1.0");
  assert.equal(plan.ref, promoted);
});

test("publishing tracks reject feature-branch dispatches before reading releases", async () => {
  for (const dispatchChannel of ["stable", "nightly"]) {
    const { run, reads } = fixture({ dispatchChannel, context: { ref: "refs/heads/feature" } });
    await assert.rejects(run, /must be dispatched from main/);
    assert.deepEqual(reads, []);
  }
});

test("a Stable tag can bootstrap the fork at 1.0.0 and must be on main", async () => {
  const context = { eventName: "push", ref: "refs/tags/v1.0.0" };
  const { run } = fixture({ context });
  assert.equal((await run()).ref, candidate);
  assert.equal((await run()).tag, "v1.0.0");
  await assert.rejects(
    fixture({ context, compare: { [`${candidate}...main`]: "diverged" } }).run,
    /not contained in main/,
  );
  await assert.rejects(
    fixture({ context: { ...context, ref: "refs/tags/v0.1.9" } }).run,
    /1\.0\.0 or newer/,
  );
  await assert.rejects(
    fixture({ context, pages: [[release("v1.1.0")]] }).run,
    /newer than published Stable/,
  );
  await assert.rejects(
    fixture({ context: { ...context, ref: "refs/tags/v1.0.0-preview.20261124.10" } }).run,
    /plain Stable tag/,
  );
});

test("automatic Nightly respects the six-hour gap and requires new commits", async () => {
  const tag = "v1.0.0-nightly.20261125.14";
  const context = { eventName: "schedule" };
  const recent = fixture({ context, pages: [[release(tag, { hoursAgo: 5 })]] });
  assert.equal((await recent.run()).shouldBuild, false);
  const pages = [[release(tag, { hoursAgo: 6 })]];
  const unchanged = fixture({
    context,
    pages,
    compare: { [`${tag}...${candidate}`]: "identical" },
  });
  assert.equal((await unchanged.run()).shouldBuild, false);
  assert.equal((await fixture({ context, pages }).run()).shouldBuild, true);
});

test("pausing Nightly skips only automatic runs", async () => {
  const paused = fixture({ context: { eventName: "schedule" }, pauseNightly: true });
  assert.equal((await paused.run()).shouldBuild, false);
  assert.deepEqual(paused.reads, []);
  assert.equal(
    (await fixture({ dispatchChannel: "nightly", pauseNightly: true }).run()).shouldBuild,
    true,
  );
});
