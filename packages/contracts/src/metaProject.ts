import * as Schema from "effect/Schema";

import {
  CommandId,
  EnvironmentId,
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const MetaProjectId = TrimmedNonEmptyString.pipe(Schema.brand("MetaProjectId"));
export type MetaProjectId = typeof MetaProjectId.Type;

export const META_PROJECT_STANDARD_ROLES = [
  "frontend",
  "backend",
  "infra",
  "docs",
  "mobile",
  "shared",
  "other",
] as const;

export const MetaProjectStandardRole = Schema.Literals(META_PROJECT_STANDARD_ROLES);
export type MetaProjectStandardRole = typeof MetaProjectStandardRole.Type;

const META_PROJECT_ROLE_MAX_LENGTH = 64;

export const MetaProjectCustomRole = TrimmedNonEmptyString.check(
  Schema.isMaxLength(META_PROJECT_ROLE_MAX_LENGTH),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
export type MetaProjectCustomRole = typeof MetaProjectCustomRole.Type;

export const MetaProjectRole = Schema.Union([MetaProjectStandardRole, MetaProjectCustomRole]);
export type MetaProjectRole = typeof MetaProjectRole.Type;

export const MetaProjectMember = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  role: MetaProjectRole,
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  sortOrder: Schema.optional(NonNegativeInt),
  addedAt: Schema.optional(IsoDateTime),
});
export type MetaProjectMember = typeof MetaProjectMember.Type;

export const META_PROJECT_THREAD_ROLES = ["pm", "cross_cutting", "standard"] as const;

export const MetaProjectThreadRole = Schema.Literals(META_PROJECT_THREAD_ROLES);
export type MetaProjectThreadRole = typeof MetaProjectThreadRole.Type;

export const MetaProjectThreadLink = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  role: MetaProjectThreadRole,
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  linkedAt: Schema.optional(IsoDateTime),
});
export type MetaProjectThreadLink = typeof MetaProjectThreadLink.Type;

export const MetaProject = Schema.Struct({
  id: MetaProjectId,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  instructionsMd: Schema.String,
  members: Schema.Array(MetaProjectMember),
  threadLinks: Schema.Array(MetaProjectThreadLink),
  pinnedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  archivedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
});
export type MetaProject = typeof MetaProject.Type;

export const MetaProjectSnapshot = Schema.Struct({
  metaProjects: ForwardCompatibleArray(MetaProject),
  updatedAt: IsoDateTime,
});
export type MetaProjectSnapshot = typeof MetaProjectSnapshot.Type;

export const MetaProjectListInput = Schema.Struct({
  includeArchived: Schema.optional(Schema.Boolean),
});
export type MetaProjectListInput = typeof MetaProjectListInput.Type;

export const MetaProjectListResult = Schema.Struct({
  metaProjects: Schema.Array(MetaProject),
  updatedAt: Schema.optional(IsoDateTime),
});
export type MetaProjectListResult = typeof MetaProjectListResult.Type;

export const MetaProjectGetInput = Schema.Struct({
  metaProjectId: MetaProjectId,
});
export type MetaProjectGetInput = typeof MetaProjectGetInput.Type;

export const MetaProjectGetResult = Schema.Struct({
  metaProject: MetaProject,
});
export type MetaProjectGetResult = typeof MetaProjectGetResult.Type;

export const MetaProjectCreateInput = Schema.Struct({
  id: Schema.optional(MetaProjectId),
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  instructionsMd: Schema.optional(Schema.String),
  members: Schema.optional(Schema.Array(MetaProjectMember)),
  threadLinks: Schema.optional(Schema.Array(MetaProjectThreadLink)),
});
export type MetaProjectCreateInput = typeof MetaProjectCreateInput.Type;

export const MetaProjectCreateResult = Schema.Struct({
  metaProject: MetaProject,
});
export type MetaProjectCreateResult = typeof MetaProjectCreateResult.Type;

export const MetaProjectUpdateInput = Schema.Struct({
  metaProjectId: MetaProjectId,
  commandId: Schema.optional(CommandId),
  title: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  instructionsMd: Schema.optional(Schema.String),
  pinned: Schema.optional(Schema.Boolean),
  archived: Schema.optional(Schema.Boolean),
});
export type MetaProjectUpdateInput = typeof MetaProjectUpdateInput.Type;

export const MetaProjectUpdateResult = Schema.Struct({
  metaProject: MetaProject,
});
export type MetaProjectUpdateResult = typeof MetaProjectUpdateResult.Type;

export const MetaProjectDeleteInput = Schema.Struct({
  metaProjectId: MetaProjectId,
  commandId: Schema.optional(CommandId),
});
export type MetaProjectDeleteInput = typeof MetaProjectDeleteInput.Type;

export const MetaProjectDeleteResult = Schema.Struct({
  metaProjectId: MetaProjectId,
  deleted: Schema.Boolean,
});
export type MetaProjectDeleteResult = typeof MetaProjectDeleteResult.Type;

export const MetaProjectAddMemberInput = Schema.Struct({
  metaProjectId: MetaProjectId,
  commandId: Schema.optional(CommandId),
  member: MetaProjectMember,
});
export type MetaProjectAddMemberInput = typeof MetaProjectAddMemberInput.Type;

export const MetaProjectAddMemberResult = Schema.Struct({
  metaProject: MetaProject,
});
export type MetaProjectAddMemberResult = typeof MetaProjectAddMemberResult.Type;

export const MetaProjectRemoveMemberInput = Schema.Struct({
  metaProjectId: MetaProjectId,
  commandId: Schema.optional(CommandId),
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type MetaProjectRemoveMemberInput = typeof MetaProjectRemoveMemberInput.Type;

export const MetaProjectRemoveMemberResult = Schema.Struct({
  metaProject: MetaProject,
  removed: Schema.Boolean,
});
export type MetaProjectRemoveMemberResult = typeof MetaProjectRemoveMemberResult.Type;

export const MetaProjectLinkThreadInput = Schema.Struct({
  metaProjectId: MetaProjectId,
  commandId: Schema.optional(CommandId),
  threadLink: MetaProjectThreadLink,
});
export type MetaProjectLinkThreadInput = typeof MetaProjectLinkThreadInput.Type;

export const MetaProjectLinkThreadResult = Schema.Struct({
  metaProject: MetaProject,
});
export type MetaProjectLinkThreadResult = typeof MetaProjectLinkThreadResult.Type;

export const MetaProjectUnlinkThreadInput = Schema.Struct({
  metaProjectId: MetaProjectId,
  commandId: Schema.optional(CommandId),
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type MetaProjectUnlinkThreadInput = typeof MetaProjectUnlinkThreadInput.Type;

export const MetaProjectUnlinkThreadResult = Schema.Struct({
  metaProject: MetaProject,
  unlinked: Schema.Boolean,
});
export type MetaProjectUnlinkThreadResult = typeof MetaProjectUnlinkThreadResult.Type;

export const MetaProjectMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("metaProject.create"),
    ...MetaProjectCreateInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("metaProject.update"),
    ...MetaProjectUpdateInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("metaProject.delete"),
    ...MetaProjectDeleteInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("metaProject.addMember"),
    ...MetaProjectAddMemberInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("metaProject.removeMember"),
    ...MetaProjectRemoveMemberInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("metaProject.linkThread"),
    ...MetaProjectLinkThreadInput.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("metaProject.unlinkThread"),
    ...MetaProjectUnlinkThreadInput.fields,
  }),
]);
export type MetaProjectMutation = typeof MetaProjectMutation.Type;

export const MetaProjectErrorReason = Schema.Literals([
  "not_found",
  "duplicate_member",
  "member_not_found",
  "duplicate_thread_link",
  "thread_link_not_found",
  "invalid_role",
  "validation_failed",
  "storage_failed",
]);
export type MetaProjectErrorReason = typeof MetaProjectErrorReason.Type;

export class MetaProjectError extends Schema.TaggedError<MetaProjectError>()("MetaProjectError", {
  reason: MetaProjectErrorReason,
  message: TrimmedNonEmptyString,
  metaProjectId: Schema.optional(MetaProjectId),
  commandId: Schema.optional(CommandId),
  cause: Schema.optional(Schema.Defect()),
}) {}
