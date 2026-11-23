import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMetaProjectRollup } from "./metaProjectRollup.core.ts";

const envId = (id: string) => id as EnvironmentId;
const projId = (id: string) => id as ProjectId;
const threadId = (id: string) => id as ThreadId;

describe("metaProjectRollup.core", () => {
  it("deduplicates PRs, issues, and threads across multiple environments and sorts by priority", () => {
    const rollup = buildMetaProjectRollup({
      pullRequests: [
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web-local"),
          host: "github.com",
          repository: "acme/web",
          number: 42,
          title: "Feat: Dashboard (older snapshot)",
          url: "https://github.com/acme/web/pull/42",
          state: "open",
          checksState: "passing",
          reviewDecision: "approved",
          updatedAt: "2026-02-01T10:00:00.000Z",
        },
        {
          environmentId: envId("env-remote"),
          projectId: projId("proj-web-remote"),
          host: "GitHub.com",
          repository: "ACME/WEB",
          number: 42,
          title: "Feat: Dashboard (newer snapshot)",
          url: "https://github.com/acme/web/pull/42",
          state: "open",
          checksState: "passing",
          reviewDecision: "approved",
          viewerReviewRequested: true,
          updatedAt: "2026-02-01T12:00:00.000Z",
        },
        {
          environmentId: envId("env-remote"),
          projectId: projId("proj-api"),
          host: "github.com",
          repository: "acme/api",
          number: 99,
          title: "Fix: Auth Token Crash",
          url: "https://github.com/acme/api/pull/99",
          state: "open",
          checksState: "failing",
          mergeability: "conflicting",
          updatedAt: "2026-02-01T09:00:00.000Z",
        },
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web-local"),
          host: "github.com",
          repository: "acme/web",
          number: 10,
          title: "Chore: Old Merged PR",
          url: "https://github.com/acme/web/pull/10",
          state: "merged",
          updatedAt: "2026-02-01T15:00:00.000Z",
        },
      ],
      issues: [
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web-local"),
          tracker: "linear",
          host: "linear.app",
          scope: "ACME",
          key: "ACME-101",
          displayKey: "ACME-101",
          title: "General backlog item",
          url: "https://linear.app/acme/issue/ACME-101",
          stateCategory: "open",
          updatedAt: "2026-02-01T14:00:00.000Z",
        },
        {
          environmentId: envId("env-remote"),
          projectId: projId("proj-web-remote"),
          tracker: "LINEAR",
          host: "linear.app",
          scope: "acme",
          key: "ACME-101",
          displayKey: "ACME-101",
          title: "General backlog item",
          url: "https://linear.app/acme/issue/ACME-101",
          stateCategory: "open",
          isMentioned: true,
          updatedAt: "2026-02-01T13:00:00.000Z",
        },
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-api"),
          tracker: "github",
          host: "github.com",
          scope: "acme/api",
          key: "55",
          displayKey: "#55",
          title: "Assigned urgent bug",
          url: "https://github.com/acme/api/issues/55",
          stateCategory: "open",
          isAssignedToViewer: true,
          updatedAt: "2026-02-01T08:00:00.000Z",
        },
      ],
      threads: [
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web-local"),
          threadId: threadId("th-1"),
          title: "Standard feature work",
          role: "standard",
          status: "running",
          updatedAt: "2026-02-01T12:00:00.000Z",
        },
        {
          environmentId: envId("env-remote"),
          projectId: projId("proj-api"),
          threadId: threadId("th-pm"),
          title: "Release Coordinator PM",
          role: "pm",
          status: "waiting_approval",
          updatedAt: "2026-02-01T11:00:00.000Z",
        },
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web-local"),
          threadId: threadId("th-settled"),
          title: "Completed thread",
          role: "standard",
          status: "settled",
          updatedAt: "2026-02-01T15:00:00.000Z",
        },
      ],
    });

    expect(rollup.pullRequests).toHaveLength(3);
    expect(rollup.pullRequests.map((pr) => pr.number)).toEqual([99, 42, 10]);
    expect(rollup.pullRequests[1]?.title).toBe("Feat: Dashboard (newer snapshot)");
    expect(rollup.pullRequests[1]?.sources).toHaveLength(2);

    expect(rollup.issues).toHaveLength(2);
    expect(rollup.issues.map((i) => i.key)).toEqual(["55", "ACME-101"]);
    expect(rollup.issues[1]?.isMentioned).toBe(true);
    expect(rollup.issues[1]?.sources).toHaveLength(2);

    expect(rollup.activeThreads.map((t) => t.threadId)).toEqual(["th-pm", "th-1"]);

    expect(rollup.counts).toEqual({
      pullRequests: {
        total: 3,
        open: 2,
        draft: 0,
        failingChecks: 1,
        conflicting: 1,
        reviewRequested: 1,
        changesRequested: 0,
        approved: 1,
        merged: 1,
        closed: 0,
      },
      issues: {
        total: 2,
        open: 2,
        closed: 0,
        assignedToViewer: 1,
        mentioned: 1,
      },
      threads: {
        total: 3,
        active: 2,
        running: 1,
        needsAttention: 1,
        pm: 1,
        crossCutting: 0,
        standard: 1,
        settled: 1,
      },
    });
  });
});
