import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  META_PROJECT_STANDARD_ROLES,
  META_PROJECT_THREAD_ROLES,
  MetaProject,
  MetaProjectAddMemberInput,
  MetaProjectCreateInput,
  MetaProjectDeleteInput,
  MetaProjectError,
  MetaProjectId,
  MetaProjectLinkThreadInput,
  MetaProjectMember,
  MetaProjectMutation,
  MetaProjectRemoveMemberInput,
  MetaProjectRole,
  MetaProjectSnapshot,
  MetaProjectThreadLink,
  MetaProjectThreadRole,
  MetaProjectUnlinkThreadInput,
  MetaProjectUpdateInput,
} from "./metaProject.ts";

const decodeMetaProjectId = Schema.decodeUnknownSync(MetaProjectId);
const decodeMetaProjectRole = Schema.decodeUnknownSync(MetaProjectRole);
const decodeMetaProjectThreadRole = Schema.decodeUnknownSync(MetaProjectThreadRole);
const decodeMetaProjectMember = Schema.decodeUnknownSync(MetaProjectMember);
const decodeMetaProjectThreadLink = Schema.decodeUnknownSync(MetaProjectThreadLink);
const decodeMetaProject = Schema.decodeUnknownSync(MetaProject);
const decodeMetaProjectSnapshot = Schema.decodeUnknownSync(MetaProjectSnapshot);
const decodeMetaProjectMutation = Schema.decodeUnknownSync(MetaProjectMutation);
const decodeMetaProjectCreateInput = Schema.decodeUnknownSync(MetaProjectCreateInput);
const decodeMetaProjectUpdateInput = Schema.decodeUnknownSync(MetaProjectUpdateInput);
const decodeMetaProjectDeleteInput = Schema.decodeUnknownSync(MetaProjectDeleteInput);
const decodeMetaProjectAddMemberInput = Schema.decodeUnknownSync(MetaProjectAddMemberInput);
const decodeMetaProjectRemoveMemberInput = Schema.decodeUnknownSync(MetaProjectRemoveMemberInput);
const decodeMetaProjectLinkThreadInput = Schema.decodeUnknownSync(MetaProjectLinkThreadInput);
const decodeMetaProjectUnlinkThreadInput = Schema.decodeUnknownSync(MetaProjectUnlinkThreadInput);
const encodeMetaProjectError = Schema.encodeSync(MetaProjectError);
const decodeMetaProjectError = Schema.decodeUnknownSync(MetaProjectError);

describe("metaProject contracts", () => {
  it("trims and brands MetaProjectId while rejecting blank strings", () => {
    expect(decodeMetaProjectId("  mp-core-1  ")).toBe("mp-core-1");
    expect(() => decodeMetaProjectId("")).toThrow();
    expect(() => decodeMetaProjectId("   ")).toThrow();
  });

  it("validates standard and custom MetaProjectRole values", () => {
    for (const role of META_PROJECT_STANDARD_ROLES) {
      expect(decodeMetaProjectRole(role)).toBe(role);
    }
    expect(decodeMetaProjectRole("  billing-service_v2  ")).toBe("billing-service_v2");
    expect(() => decodeMetaProjectRole("")).toThrow();
    expect(() => decodeMetaProjectRole("invalid role with spaces")).toThrow();
    expect(() => decodeMetaProjectRole("-leading-dash")).toThrow();
    expect(() => decodeMetaProjectRole("a".repeat(65))).toThrow();
  });

  it("validates MetaProjectThreadRole literals", () => {
    for (const role of META_PROJECT_THREAD_ROLES) {
      expect(decodeMetaProjectThreadRole(role)).toBe(role);
    }
    expect(() => decodeMetaProjectThreadRole("unknown_role")).toThrow();
  });

  it("decodes MetaProject with members and thread links", () => {
    const member = decodeMetaProjectMember({
      environmentId: " env-local ",
      projectId: " proj-web ",
      role: "frontend",
      label: " Web UI ",
      sortOrder: 0,
      addedAt: "2026-01-10T00:00:00.000Z",
    });
    expect(member).toEqual({
      environmentId: "env-local",
      projectId: "proj-web",
      role: "frontend",
      label: "Web UI",
      sortOrder: 0,
      addedAt: "2026-01-10T00:00:00.000Z",
    });

    const threadLink = decodeMetaProjectThreadLink({
      environmentId: " env-remote ",
      threadId: " thread-pm-1 ",
      role: "pm",
      projectId: " proj-api ",
      title: " Release Planning ",
      linkedAt: "2026-01-10T01:00:00.000Z",
    });
    expect(threadLink).toEqual({
      environmentId: "env-remote",
      threadId: "thread-pm-1",
      role: "pm",
      projectId: "proj-api",
      title: "Release Planning",
      linkedAt: "2026-01-10T01:00:00.000Z",
    });

    const metaProject = decodeMetaProject({
      id: " mp-1 ",
      title: " Platform V2 ",
      description: "Cross-repository architecture",
      instructionsMd: "# Shared Rules\n- Keep contracts pure",
      members: [member],
      threadLinks: [threadLink],
      pinnedAt: "2026-01-10T00:00:00.000Z",
      archivedAt: null,
      createdAt: "2026-01-10T00:00:00.000Z",
      updatedAt: "2026-01-10T02:00:00.000Z",
      deletedAt: null,
    });

    expect(metaProject.id).toBe("mp-1");
    expect(metaProject.title).toBe("Platform V2");
    expect(metaProject.members).toHaveLength(1);
    expect(metaProject.threadLinks).toHaveLength(1);

    const snapshot = decodeMetaProjectSnapshot({
      metaProjects: [metaProject, { invalid: true }],
      updatedAt: "2026-01-10T02:00:00.000Z",
    });
    expect(snapshot.metaProjects).toEqual([metaProject]);
  });

  it("decodes CRUD, member, and thread link mutations and payloads", () => {
    const createInput = decodeMetaProjectCreateInput({
      title: " Core Platform ",
      instructionsMd: "Follow functional core rules.",
    });
    expect(createInput.title).toBe("Core Platform");

    const updateInput = decodeMetaProjectUpdateInput({
      metaProjectId: "mp-1",
      pinned: true,
      archived: false,
    });
    expect(updateInput.pinned).toBe(true);

    const deleteInput = decodeMetaProjectDeleteInput({
      metaProjectId: "mp-1",
      commandId: "cmd-del",
    });
    expect(deleteInput.commandId).toBe("cmd-del");

    const addMember = decodeMetaProjectAddMemberInput({
      metaProjectId: "mp-1",
      member: {
        environmentId: "env-1",
        projectId: "proj-1",
        role: "backend",
      },
    });
    expect(addMember.member.role).toBe("backend");

    const removeMember = decodeMetaProjectRemoveMemberInput({
      metaProjectId: "mp-1",
      environmentId: "env-1",
      projectId: "proj-1",
    });
    expect(removeMember.projectId).toBe("proj-1");

    const linkThread = decodeMetaProjectLinkThreadInput({
      metaProjectId: "mp-1",
      threadLink: {
        environmentId: "env-1",
        threadId: "thread-1",
        role: "cross_cutting",
      },
    });
    expect(linkThread.threadLink.role).toBe("cross_cutting");

    const unlinkThread = decodeMetaProjectUnlinkThreadInput({
      metaProjectId: "mp-1",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(unlinkThread.threadId).toBe("thread-1");

    expect(
      decodeMetaProjectMutation({
        type: "metaProject.addMember",
        metaProjectId: "mp-1",
        member: {
          environmentId: "env-1",
          projectId: "proj-1",
          role: "infra",
        },
      }),
    ).toEqual({
      type: "metaProject.addMember",
      metaProjectId: "mp-1",
      member: {
        environmentId: "env-1",
        projectId: "proj-1",
        role: "infra",
      },
    });
  });

  it("constructs and round-trips MetaProjectError", () => {
    const error = new MetaProjectError({
      reason: "duplicate_member",
      message: "Project proj-1 in env-1 is already a member.",
      metaProjectId: decodeMetaProjectId("mp-1"),
    });

    expect(error._tag).toBe("MetaProjectError");
    expect(error.reason).toBe("duplicate_member");
    expect(error.message).toBe("Project proj-1 in env-1 is already a member.");

    const encoded = encodeMetaProjectError(error);
    const decoded = decodeMetaProjectError(encoded);
    expect(decoded.reason).toBe("duplicate_member");
    expect(decoded.metaProjectId).toBe("mp-1");
  });
});
