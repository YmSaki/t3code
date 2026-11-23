import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { MetaProjectHierarchyTree } from "@t3tools/shared/metaProjectTree.core";
import { describe, expect, it } from "vite-plus/test";

import {
  canDropProjectIntoMetaProject,
  computeProjectDropAssignment,
  DEFAULT_SIDEBAR_META_PROJECT_EXPANSION,
  filterMetaProjectTree,
  formatEnvironmentBadgeLabel,
  isMetaProjectExpanded,
  makeMetaProjectDropId,
  makeSidebarProjectDragId,
  parseMetaProjectDropId,
  parseSidebarProjectDragPayload,
  summarizeMetaProjectCounts,
  toggleMetaProjectExpanded,
  toggleUncategorizedExpanded,
} from "./sidebarMetaProject.logic.ts";

const envLocal = "env-local" as EnvironmentId;
const envRemote = "env-remote" as EnvironmentId;
const projWeb = "proj-web" as ProjectId;
const projApi = "proj-api" as ProjectId;
const projSolo = "proj-solo" as ProjectId;
const thPm = "th-pm" as ThreadId;

const sampleTree: MetaProjectHierarchyTree = {
  metaProjects: [
    {
      metaProjectId: "mp-core",
      title: "Core Platform",
      description: "Main stack",
      pinned: true,
      archived: false,
      pmThreads: [
        {
          environmentId: envLocal,
          projectId: projWeb,
          threadId: thPm,
          title: "Release PM",
          role: "pm",
          environmentBadge: {
            environmentId: envLocal,
            label: "MacBook",
            isLocal: true,
            online: true,
          },
          updatedAt: "2026-03-01T10:00:00.000Z",
          isActive: true,
          missing: false,
        },
      ],
      crossCuttingThreads: [],
      repositories: [
        {
          environmentId: envLocal,
          projectId: projWeb,
          title: "Web App",
          workspaceRoot: "/work/web",
          role: "frontend",
          environmentBadge: {
            environmentId: envLocal,
            label: "MacBook",
            isLocal: true,
            online: true,
          },
          threads: [],
          missing: false,
        },
      ],
    },
    {
      metaProjectId: "mp-mobile",
      title: "Mobile Suite",
      description: null,
      pinned: false,
      archived: false,
      pmThreads: [],
      crossCuttingThreads: [],
      repositories: [],
    },
  ],
  uncategorizedRepositories: [
    {
      environmentId: envRemote,
      projectId: projSolo,
      title: "Sandbox CLI",
      workspaceRoot: "/srv/sandbox",
      environmentBadge: {
        environmentId: envRemote,
        label: "Build Box",
        isLocal: false,
        online: false,
      },
      threads: [],
    },
  ],
};

describe("sidebarMetaProject.logic", () => {
  it("toggles MetaProject and uncategorized expansion states purely", () => {
    const expanded = toggleMetaProjectExpanded(DEFAULT_SIDEBAR_META_PROJECT_EXPANSION, "mp-core");
    expect(isMetaProjectExpanded(expanded, "mp-core")).toBe(true);

    const collapsed = toggleMetaProjectExpanded(expanded, "mp-core");
    expect(isMetaProjectExpanded(collapsed, "mp-core")).toBe(false);

    const toggledUncat = toggleUncategorizedExpanded(collapsed);
    expect(toggledUncat.uncategorizedExpanded).toBe(false);
  });

  it("validates @dnd-kit drag payloads and computes project drop assignments", () => {
    const dragId = makeSidebarProjectDragId(envRemote, projApi);
    expect(dragId).toBe("meta-project-drag:env-remote:proj-api");

    const dropId = makeMetaProjectDropId("mp-mobile");
    expect(parseMetaProjectDropId(dropId)).toBe("mp-mobile");
    expect(parseMetaProjectDropId("other-id")).toBeNull();

    const parsed = parseSidebarProjectDragPayload({
      kind: "physical_project",
      environmentId: envLocal,
      projectId: projWeb,
      sourceMetaProjectId: "mp-core",
    });
    expect(parsed).not.toBeNull();

    expect(canDropProjectIntoMetaProject(parsed!, sampleTree.metaProjects[0]!)).toEqual({
      allowed: false,
      reason: "same_meta_project",
    });

    const dupInTarget = parseSidebarProjectDragPayload({
      kind: "physical_project",
      environmentId: envLocal,
      projectId: projWeb,
      sourceMetaProjectId: null,
    });
    expect(canDropProjectIntoMetaProject(dupInTarget!, sampleTree.metaProjects[0]!)).toEqual({
      allowed: false,
      reason: "already_member",
    });

    const assignment = computeProjectDropAssignment(parsed!, sampleTree.metaProjects[1]!, "mobile");
    expect(assignment).toEqual({
      shouldAdd: true,
      shouldRemoveFromSource: true,
      sourceMetaProjectId: "mp-core",
      targetMetaProjectId: "mp-mobile",
      environmentId: envLocal,
      projectId: projWeb,
      role: "mobile",
    });
  });

  it("summarizes counts, formats environment badges, and filters the hierarchy tree", () => {
    expect(summarizeMetaProjectCounts(sampleTree)).toEqual({
      metaProjectCount: 2,
      categorizedRepositoryCount: 1,
      uncategorizedRepositoryCount: 1,
      activePmThreadCount: 1,
      activeCrossCuttingThreadCount: 0,
    });

    expect(
      formatEnvironmentBadgeLabel(sampleTree.uncategorizedRepositories[0]!.environmentBadge, {
        offlineSuffix: "offline",
      }),
    ).toBe("Build Box (offline)");

    const filtered = filterMetaProjectTree(sampleTree, "sandbox");
    expect(filtered.metaProjects).toEqual([]);
    expect(filtered.uncategorizedRepositories.map((r) => r.projectId)).toEqual(["proj-solo"]);
  });
});
