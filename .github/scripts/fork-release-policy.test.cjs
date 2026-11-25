const assert = require("node:assert/strict");
const test = require("node:test");

const { planForkRelease } = require("./fork-release-policy.cjs");

const now = Date.parse("2026-11-25T12:00:00Z");
const candidate = "a".repeat(40);
const promoted = "b".repeat(40);
const repo = { owner: "YmSaki", repo: "t3code" };

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
  const { run } = fixture({ dispatchChannel: "nightly", pages: [[release("v0.1.9")]] });
  const plan = await run();
  assert.equal(plan.version, "1.0.0-nightly.20261124.23");
  assert.equal(plan.tag, "v1.0.0-nightly.20261124.23");
  assert.equal(plan.name, "T3CodeJP Nightly 1.0.0-nightly.20261124.23 (aaaaaaaaaaaa)");
  assert.equal(plan.hasUpdateFeed, true);
  assert.equal(plan.isPrerelease, true);
  assert.equal(plan.makeLatest, false);
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

test("plans a branch Preview as a draft with no update feed", async () => {
  const { run, reads } = fixture({ context: { ref: "refs/heads/feature" } });
  const plan = await run();
  assert.equal(plan.version, "1.0.0-preview.20261124.23");
  assert.equal(plan.ref, candidate);
  assert.equal(plan.draft, true);
  assert.equal(plan.isPrerelease, true);
  assert.equal(plan.hasUpdateFeed, false);
  assert.equal(plan.makeLatest, false);
  assert.equal(
    reads.some(([kind]) => kind === "compare"),
    false,
  );
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
