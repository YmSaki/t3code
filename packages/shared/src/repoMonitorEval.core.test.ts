import { describe, expect, it } from "vite-plus/test";
import type { ProjectId } from "@t3tools/contracts";

import {
  createEmptyRepoMonitorCursor,
  evaluateRepoMonitorSnapshot,
  matchBranchGlob,
  matchesRepoMonitorFilter,
  type RepoMonitorCandidateEvent,
  type RepoMonitorCursorState,
  type RepoMonitorEvalRule,
  type RepoMonitorSnapshot,
} from "./repoMonitorEval.core.ts";

const PROJECT_ID = "proj-1" as ProjectId;

const baseCursor: RepoMonitorCursorState = {
  projectId: PROJECT_ID,
  branchHeads: {
    main: "sha-main-1",
    "feature/existing": "sha-feat-1",
  },
  knownPullRequestNumbers: [10],
  mergedPullRequestNumbers: [],
  knownPullRequestCommentIds: ["prc-1"],
  knownIssueKeys: ["100"],
  knownIssueCommentIds: ["isc-1"],
  updatedAt: "2026-11-22T10:00:00Z",
};

const sampleSnapshot: RepoMonitorSnapshot = {
  projectId: PROJECT_ID,
  observedAt: "2026-11-22T10:05:00Z",
  branches: [
    { name: "main", headSha: "sha-main-1" },
    {
      name: "feature/existing",
      headSha: "sha-feat-2",
      authorLogin: "alice",
      commitMessage: "feat: update auth flow",
    },
    {
      name: "feature/nested/ui",
      headSha: "sha-ui-1",
      authorLogin: "dependabot[bot]",
      isBot: true,
      commitMessage: "chore: bump deps",
    },
  ],
  pullRequests: [
    {
      number: 10,
      title: "Existing PR now merged",
      body: "Closes #100",
      state: "merged",
      headBranch: "feature/existing",
      baseBranch: "main",
      headSha: "sha-feat-2",
      authorLogin: "alice",
      labels: ["release", "backend"],
      createdAt: "2026-11-22T09:00:00Z",
      updatedAt: "2026-11-22T10:04:00Z",
      mergedAt: "2026-11-22T10:04:00Z",
      comments: [
        {
          id: "prc-1",
          authorLogin: "bob",
          body: "Old comment",
          createdAt: "2026-11-22T09:30:00Z",
        },
        {
          id: "prc-2",
          authorLogin: "carol",
          body: "Please fix the memory leak in worker",
          createdAt: "2026-11-22T10:03:00Z",
          path: "src/worker.ts",
        },
      ],
    },
    {
      number: 11,
      title: "New PR for feature",
      body: "Implements urgent security patch",
      state: "open",
      headBranch: "feature/security",
      baseBranch: "main",
      headSha: "sha-sec-1",
      authorLogin: "dave",
      labels: ["security", "urgent"],
      createdAt: "2026-11-22T10:02:00Z",
      updatedAt: "2026-11-22T10:02:00Z",
      comments: [],
    },
  ],
  issues: [
    {
      key: "100",
      title: "Existing issue",
      stateCategory: "open",
      authorLogin: "alice",
      labels: ["bug"],
      createdAt: "2026-11-22T08:00:00Z",
      updatedAt: "2026-11-22T10:04:00Z",
      comments: [
        {
          id: "isc-1",
          authorLogin: "alice",
          body: "Initial note",
          createdAt: "2026-11-22T08:10:00Z",
        },
        {
          id: "isc-2",
          authorLogin: "eve",
          body: "Reproduced on Windows",
          createdAt: "2026-11-22T10:04:00Z",
        },
      ],
    },
    {
      key: "101",
      title: "Crash when opening settings",
      body: "Stack trace in console",
      stateCategory: "open",
      authorLogin: "frank",
      labels: ["bug", "triage"],
      createdAt: "2026-11-22T10:01:00Z",
      updatedAt: "2026-11-22T10:01:00Z",
      comments: [],
    },
  ],
};

describe("matchBranchGlob", () => {
  it("matches exact, single-level *, multi-level **, and ? patterns", () => {
    expect(matchBranchGlob("main", "main")).toBe(true);
    expect(matchBranchGlob("main", "main-2")).toBe(false);
    expect(matchBranchGlob("feature/*", "feature/login")).toBe(true);
    expect(matchBranchGlob("feature/*", "feature/nested/login")).toBe(false);
    expect(matchBranchGlob("feature/**", "feature/nested/login")).toBe(true);
    expect(matchBranchGlob("**/release", "release")).toBe(true);
    expect(matchBranchGlob("**/release", "team/a/release")).toBe(true);
    expect(matchBranchGlob("release/v?.0", "release/v1.0")).toBe(true);
    expect(matchBranchGlob("release/v?.0", "release/v10.0")).toBe(false);
  });
});

describe("evaluateRepoMonitorSnapshot", () => {
  it("extracts only newly occurred events since previousCursor and advances nextCursor", () => {
    const catchAllRule: RepoMonitorEvalRule = {
      id: "rule-all",
      projectId: PROJECT_ID,
      enabled: true,
      eventKinds: [
        "branch_push",
        "pr_opened",
        "pr_merged",
        "pr_comment",
        "issue_opened",
        "issue_comment",
      ],
      filter: {},
    };

    const result = evaluateRepoMonitorSnapshot({
      previousCursor: baseCursor,
      snapshot: sampleSnapshot,
      rules: [catchAllRule],
    });

    expect(result.candidateEvents.map((e) => `${e.kind}:${e.branch ?? e.issueKey}`)).toEqual([
      "branch_push:feature/existing",
      "branch_push:feature/nested/ui",
      "pr_merged:main",
      "pr_comment:feature/existing",
      "pr_opened:feature/security",
      "issue_comment:100",
      "issue_opened:101",
    ]);

    expect(result.nextCursor).toEqual({
      projectId: PROJECT_ID,
      branchHeads: {
        main: "sha-main-1",
        "feature/existing": "sha-feat-2",
        "feature/nested/ui": "sha-ui-1",
      },
      knownPullRequestNumbers: [10, 11],
      mergedPullRequestNumbers: [10],
      knownPullRequestCommentIds: ["prc-1", "prc-2"],
      knownIssueKeys: ["100", "101"],
      knownIssueCommentIds: ["isc-1", "isc-2"],
      updatedAt: "2026-11-22T10:05:00Z",
    });

    const secondPass = evaluateRepoMonitorSnapshot({
      previousCursor: result.nextCursor,
      snapshot: sampleSnapshot,
      rules: [catchAllRule],
    });
    expect(secondPass.candidateEvents).toEqual([]);
    expect(secondPass.matches).toEqual([]);
  });

  it("seeds baseline cursor without emitting historical events when previousCursor is null", () => {
    const rule: RepoMonitorEvalRule = {
      id: "rule-1",
      projectId: PROJECT_ID,
      enabled: true,
      eventKinds: ["branch_push", "pr_opened", "issue_opened"],
      filter: {},
    };

    const baseline = evaluateRepoMonitorSnapshot({
      previousCursor: null,
      snapshot: sampleSnapshot,
      rules: [rule],
    });
    expect(baseline.candidateEvents).toEqual([]);
    expect(baseline.nextCursor.knownPullRequestNumbers).toEqual([10, 11]);

    const fromEmpty = evaluateRepoMonitorSnapshot({
      previousCursor: createEmptyRepoMonitorCursor(PROJECT_ID, "2026-11-22T00:00:00Z"),
      snapshot: sampleSnapshot,
      rules: [rule],
    });
    expect(fromEmpty.candidateEvents.length).toBeGreaterThan(0);
  });

  it("applies branch glob, required/excluded label, author, bot, and keyword filters", () => {
    const baseEvent: RepoMonitorCandidateEvent = {
      kind: "pr_opened",
      projectId: PROJECT_ID,
      title: "Fix memory leak in worker pool",
      body: "Resolves high memory usage under load",
      authorLogin: "Alice",
      isBot: false,
      labels: ["Bug", "Backend"],
      branch: "feature/worker-fix",
      headBranch: "feature/worker-fix",
      baseBranch: "main",
      previousCommitSha: null,
      commitSha: "sha-1",
      pullRequestNumber: 42,
      issueKey: null,
      commentId: null,
      path: null,
      url: null,
      occurredAt: "2026-11-22T10:00:00Z",
    };

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        branchGlobs: ["feature/*"],
        requiredLabels: ["bug", "backend"],
        excludedLabels: ["wontfix"],
        allowedAuthors: ["alice"],
        excludedAuthors: ["bob"],
        excludeBots: true,
        keywords: ["MEMORY LEAK"],
      }),
    ).toBe(true);

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        branchGlobs: ["release/*"],
      }),
    ).toBe(false);

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        requiredLabels: ["bug", "security"],
      }),
    ).toBe(false);

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        excludedLabels: ["backend"],
      }),
    ).toBe(false);

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        allowedAuthors: ["bob"],
      }),
    ).toBe(false);

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        excludedAuthors: ["alice"],
      }),
    ).toBe(false);

    expect(
      matchesRepoMonitorFilter(
        { ...baseEvent, authorLogin: "renovate[bot]" },
        { excludeBots: true },
      ),
    ).toBe(false);

    expect(
      matchesRepoMonitorFilter(baseEvent, {
        keywords: ["database", "migration"],
      }),
    ).toBe(false);
  });
});
