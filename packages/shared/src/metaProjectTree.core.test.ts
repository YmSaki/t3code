import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMetaProjectHierarchyTree } from "./metaProjectTree.core.ts";

const envId = (id: string) => id as EnvironmentId;
const projId = (id: string) => id as ProjectId;
const threadId = (id: string) => id as ThreadId;

describe("metaProjectTree.core", () => {
  it("builds metaProject hierarchy with PM threads, cross-cutting threads, badged repos, and uncategorized repos", () => {
    const tree = buildMetaProjectHierarchyTree({
      environments: [
        { environmentId: envId("env-local"), label: "MacBook Pro", isLocal: true, online: true },
        {
          environmentId: envId("env-remote"),
          label: "Linux Build Box",
          isLocal: false,
          online: true,
        },
      ],
      physicalProjects: [
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web"),
          title: "Web App",
          workspaceRoot: "/Users/dev/web",
        },
        {
          environmentId: envId("env-remote"),
          projectId: projId("proj-api"),
          title: "Backend API",
          workspaceRoot: "/srv/api",
        },
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-scratch"),
          title: "Scratch Notes",
          workspaceRoot: "/Users/dev/scratch",
        },
      ],
      threads: [
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web"),
          threadId: threadId("th-pm"),
          title: "Q2 Roadmap PM",
          updatedAt: "2026-02-01T10:00:00.000Z",
          isActive: true,
        },
        {
          environmentId: envId("env-remote"),
          projectId: projId("proj-api"),
          threadId: threadId("th-cross"),
          title: "Auth Contract Sync",
          updatedAt: "2026-02-01T11:00:00.000Z",
        },
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web"),
          threadId: threadId("th-web-1"),
          title: "Fix Button Focus",
          updatedAt: "2026-02-01T12:00:00.000Z",
        },
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-scratch"),
          threadId: threadId("th-scratch-1"),
          title: "Draft Ideas",
          updatedAt: "2026-02-01T09:00:00.000Z",
        },
      ],
      metaProjects: [
        {
          id: "mp-core",
          title: "Core Product",
          description: "Full-stack product",
          instructionsMd: "Use strict schemas",
          members: [
            {
              environmentId: envId("env-remote"),
              projectId: projId("proj-api"),
              role: "backend",
              sortOrder: 2,
            },
            {
              environmentId: envId("env-local"),
              projectId: projId("proj-web"),
              role: "frontend",
              sortOrder: 1,
            },
          ],
          threadLinks: [
            {
              environmentId: envId("env-local"),
              threadId: threadId("th-pm"),
              role: "pm",
            },
            {
              environmentId: envId("env-remote"),
              threadId: threadId("th-cross"),
              role: "cross_cutting",
            },
          ],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-02-01T12:00:00.000Z",
        },
      ],
    });

    expect(tree.metaProjects).toHaveLength(1);
    const mp = tree.metaProjects[0]!;
    expect(mp.title).toBe("Core Product");
    expect(mp.pmThreads.map((t) => t.threadId)).toEqual(["th-pm"]);
    expect(mp.pmThreads[0]?.environmentBadge.label).toBe("MacBook Pro");
    expect(mp.crossCuttingThreads.map((t) => t.threadId)).toEqual(["th-cross"]);
    expect(mp.crossCuttingThreads[0]?.environmentBadge.label).toBe("Linux Build Box");

    expect(mp.repositories.map((r) => r.projectId)).toEqual(["proj-web", "proj-api"]);
    expect(mp.repositories[0]?.environmentBadge.isLocal).toBe(true);
    expect(mp.repositories[0]?.threads.map((t) => t.threadId)).toEqual(["th-web-1"]);
    expect(mp.repositories[1]?.threads).toEqual([]);

    expect(tree.uncategorizedRepositories.map((r) => r.projectId)).toEqual(["proj-scratch"]);
    expect(tree.uncategorizedRepositories[0]?.threads.map((t) => t.threadId)).toEqual([
      "th-scratch-1",
    ]);
  });

  it("marks missing physical projects and excludes archived/deleted items by default", () => {
    const tree = buildMetaProjectHierarchyTree({
      environments: [],
      physicalProjects: [
        {
          environmentId: envId("env-1"),
          projectId: projId("proj-deleted"),
          title: "Deleted",
          workspaceRoot: "/deleted",
          deletedAt: "2026-01-05T00:00:00.000Z",
        },
      ],
      threads: [],
      metaProjects: [
        {
          id: "mp-1",
          title: "Active Meta",
          instructionsMd: "",
          members: [
            {
              environmentId: envId("env-1"),
              projectId: projId("proj-missing"),
              role: "infra",
            },
          ],
          threadLinks: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "mp-archived",
          title: "Archived Meta",
          instructionsMd: "",
          members: [],
          threadLinks: [],
          archivedAt: "2026-01-03T00:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });

    expect(tree.metaProjects.map((m) => m.metaProjectId)).toEqual(["mp-1"]);
    expect(tree.metaProjects[0]?.repositories[0]?.missing).toBe(true);
    expect(tree.metaProjects[0]?.repositories[0]?.environmentBadge.online).toBe(false);
    expect(tree.uncategorizedRepositories).toEqual([]);
  });
});
