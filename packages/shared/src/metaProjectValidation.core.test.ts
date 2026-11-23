import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  extractCleanupForDeletedEnvironment,
  extractCleanupForDeletedProject,
  extractStaleMetaProjectReferences,
  isValidMetaProjectRole,
  validateMetaProject,
} from "./metaProjectValidation.core.ts";

const envId = (id: string) => id as EnvironmentId;
const projId = (id: string) => id as ProjectId;
const threadId = (id: string) => id as ThreadId;

describe("metaProjectValidation.core", () => {
  it("detects duplicate members, duplicate thread links, and invalid roles", () => {
    const validation = validateMetaProject(
      {
        members: [
          { environmentId: envId("env-1"), projectId: projId("proj-a"), role: "frontend" },
          { environmentId: envId("env-1"), projectId: projId("proj-a"), role: "backend" },
          { environmentId: envId("env-1"), projectId: projId("proj-b"), role: "bad role!" },
          { environmentId: envId("env-1"), projectId: projId("proj-c"), role: "custom-service" },
        ],
        threadLinks: [
          { environmentId: envId("env-1"), threadId: threadId("th-1"), role: "pm" },
          { environmentId: envId("env-1"), threadId: threadId("th-1"), role: "cross_cutting" },
          {
            environmentId: envId("env-1"),
            threadId: threadId("th-2"),
            role: "invalid_thread_role",
          },
        ],
      },
      { allowCustomRoles: false },
    );

    expect(validation.valid).toBe(false);
    expect(validation.duplicateMembers).toEqual([
      {
        environmentId: envId("env-1"),
        projectId: projId("proj-a"),
        indices: [0, 1],
      },
    ]);
    expect(validation.duplicateThreadLinks).toEqual([
      {
        environmentId: envId("env-1"),
        threadId: threadId("th-1"),
        indices: [0, 1],
      },
    ]);
    expect(validation.invalidMemberRoles.map((item) => item.role)).toEqual([
      "bad role!",
      "custom-service",
    ]);
    expect(validation.invalidThreadRoles.map((item) => item.role)).toEqual(["invalid_thread_role"]);
    expect(isValidMetaProjectRole("custom-service")).toBe(true);
    expect(isValidMetaProjectRole("custom-service", { allowCustomRoles: false })).toBe(false);
  });

  it("extracts members and thread links to clean up when a physical project or environment is deleted", () => {
    const sampleMeta = {
      id: "mp-1",
      title: "Platform",
      instructionsMd: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      members: [
        { environmentId: envId("env-1"), projectId: projId("proj-1"), role: "frontend" },
        { environmentId: envId("env-1"), projectId: projId("proj-2"), role: "backend" },
        { environmentId: envId("env-2"), projectId: projId("proj-3"), role: "infra" },
      ],
      threadLinks: [
        {
          environmentId: envId("env-1"),
          projectId: projId("proj-1"),
          threadId: threadId("th-1"),
          role: "pm",
        },
        {
          environmentId: envId("env-1"),
          threadId: threadId("th-2"),
          role: "cross_cutting",
        },
        {
          environmentId: envId("env-2"),
          projectId: projId("proj-3"),
          threadId: threadId("th-3"),
          role: "standard",
        },
      ],
    };

    const projectCleanup = extractCleanupForDeletedProject(sampleMeta, {
      environmentId: envId("env-1"),
      projectId: projId("proj-1"),
      deletedThreadIds: [threadId("th-2")],
    });
    expect(projectCleanup.hasChanges).toBe(true);
    expect(projectCleanup.membersToRemove).toHaveLength(1);
    expect(projectCleanup.threadLinksToRemove.map((l) => l.threadId)).toEqual(["th-1", "th-2"]);
    expect(projectCleanup.nextMetaProject.members.map((m) => m.projectId)).toEqual([
      "proj-2",
      "proj-3",
    ]);

    const envCleanup = extractCleanupForDeletedEnvironment(sampleMeta, envId("env-1"));
    expect(envCleanup.hasChanges).toBe(true);
    expect(envCleanup.membersToRemove.map((m) => m.projectId)).toEqual(["proj-1", "proj-2"]);
    expect(envCleanup.threadLinksToRemove.map((l) => l.threadId)).toEqual(["th-1", "th-2"]);
    expect(envCleanup.nextMetaProject.members.map((m) => m.projectId)).toEqual(["proj-3"]);
  });

  it("extracts all stale references against active environments, projects, and threads", () => {
    const sampleMeta = {
      id: "mp-1",
      title: "Platform",
      instructionsMd: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      members: [
        { environmentId: envId("env-1"), projectId: projId("proj-1"), role: "frontend" },
        { environmentId: envId("env-dead"), projectId: projId("proj-2"), role: "backend" },
      ],
      threadLinks: [
        { environmentId: envId("env-1"), threadId: threadId("th-alive"), role: "pm" },
        { environmentId: envId("env-1"), threadId: threadId("th-gone"), role: "cross_cutting" },
      ],
    };

    const stale = extractStaleMetaProjectReferences(sampleMeta, {
      environmentIds: [envId("env-1")],
      projects: [{ environmentId: envId("env-1"), projectId: projId("proj-1") }],
      threads: [{ environmentId: envId("env-1"), threadId: threadId("th-alive") }],
    });

    expect(stale.hasChanges).toBe(true);
    expect(stale.membersToRemove.map((m) => m.environmentId)).toEqual(["env-dead"]);
    expect(stale.threadLinksToRemove.map((l) => l.threadId)).toEqual(["th-gone"]);
    expect(stale.nextMetaProject.members).toHaveLength(1);
    expect(stale.nextMetaProject.threadLinks).toHaveLength(1);
  });
});
