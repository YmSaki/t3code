import type { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";

const META_PROJECT_STANDARD_ROLES = [
  "frontend",
  "backend",
  "infra",
  "docs",
  "mobile",
  "shared",
  "other",
] as const;

export type MetaProjectStandardRole = (typeof META_PROJECT_STANDARD_ROLES)[number];

const META_PROJECT_THREAD_ROLES = ["pm", "cross_cutting", "standard"] as const;
export type MetaProjectThreadRole = (typeof META_PROJECT_THREAD_ROLES)[number];

const META_PROJECT_ROLE_MAX_LENGTH = 64;
const CUSTOM_ROLE_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const STANDARD_ROLE_SET: ReadonlySet<string> = new Set(META_PROJECT_STANDARD_ROLES);
const THREAD_ROLE_SET: ReadonlySet<string> = new Set(META_PROJECT_THREAD_ROLES);

export interface MetaProjectMemberForValidation {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly role: string;
  readonly label?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly addedAt?: IsoDateTime | undefined;
}

export interface MetaProjectThreadLinkForValidation {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly role: string;
  readonly projectId?: ProjectId | null | undefined;
  readonly title?: string | null | undefined;
  readonly linkedAt?: IsoDateTime | undefined;
}

export interface MetaProjectForValidation {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly instructionsMd: string;
  readonly members: ReadonlyArray<MetaProjectMemberForValidation>;
  readonly threadLinks: ReadonlyArray<MetaProjectThreadLinkForValidation>;
  readonly pinnedAt?: IsoDateTime | null | undefined;
  readonly archivedAt?: IsoDateTime | null | undefined;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt?: IsoDateTime | null | undefined;
}

export interface MetaProjectValidationOptions {
  readonly allowCustomRoles?: boolean | undefined;
}

export interface DuplicateMemberFinding {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly indices: ReadonlyArray<number>;
}

export interface DuplicateThreadLinkFinding {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly indices: ReadonlyArray<number>;
}

export interface InvalidMemberRoleFinding {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly role: string;
  readonly index: number;
}

export interface InvalidThreadRoleFinding {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly role: string;
  readonly index: number;
}

export interface MetaProjectValidationResult {
  readonly valid: boolean;
  readonly duplicateMembers: ReadonlyArray<DuplicateMemberFinding>;
  readonly duplicateThreadLinks: ReadonlyArray<DuplicateThreadLinkFinding>;
  readonly invalidMemberRoles: ReadonlyArray<InvalidMemberRoleFinding>;
  readonly invalidThreadRoles: ReadonlyArray<InvalidThreadRoleFinding>;
}

export interface MetaProjectCleanupPlan<
  TMetaProject extends MetaProjectForValidation = MetaProjectForValidation,
> {
  readonly hasChanges: boolean;
  readonly membersToRemove: ReadonlyArray<MetaProjectMemberForValidation>;
  readonly threadLinksToRemove: ReadonlyArray<MetaProjectThreadLinkForValidation>;
  readonly nextMetaProject: TMetaProject;
}

const makeScopedProjectKey = (environmentId: EnvironmentId, projectId: ProjectId): string =>
  `${environmentId}\u0000${projectId}`;

const makeScopedThreadKey = (environmentId: EnvironmentId, threadId: ThreadId): string =>
  `${environmentId}\u0000${threadId}`;

export function isValidMetaProjectRole(
  role: string,
  options?: MetaProjectValidationOptions,
): boolean {
  const trimmed = role.trim();
  if (trimmed.length === 0 || trimmed.length > META_PROJECT_ROLE_MAX_LENGTH) return false;
  if (STANDARD_ROLE_SET.has(trimmed)) return true;
  if (options?.allowCustomRoles === false) return false;
  return CUSTOM_ROLE_PATTERN.test(trimmed);
}

export function isValidMetaProjectThreadRole(role: string): role is MetaProjectThreadRole {
  return THREAD_ROLE_SET.has(role.trim());
}

export function validateMetaProject(
  metaProject: Pick<MetaProjectForValidation, "members" | "threadLinks">,
  options?: MetaProjectValidationOptions,
): MetaProjectValidationResult {
  const memberIndicesByKey = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
      readonly indices: number[];
    }
  >();
  const invalidMemberRoles: InvalidMemberRoleFinding[] = [];

  for (const [index, member] of metaProject.members.entries()) {
    const key = makeScopedProjectKey(member.environmentId, member.projectId);
    const existing = memberIndicesByKey.get(key);
    if (existing !== undefined) {
      existing.indices.push(index);
    } else {
      memberIndicesByKey.set(key, {
        environmentId: member.environmentId,
        projectId: member.projectId,
        indices: [index],
      });
    }

    if (!isValidMetaProjectRole(member.role, options)) {
      invalidMemberRoles.push({
        environmentId: member.environmentId,
        projectId: member.projectId,
        role: member.role,
        index,
      });
    }
  }

  const duplicateMembers: DuplicateMemberFinding[] = [];
  for (const entry of memberIndicesByKey.values()) {
    if (entry.indices.length > 1) {
      duplicateMembers.push(entry);
    }
  }

  const threadIndicesByKey = new Map<
    string,
    {
      readonly environmentId: EnvironmentId;
      readonly threadId: ThreadId;
      readonly indices: number[];
    }
  >();
  const invalidThreadRoles: InvalidThreadRoleFinding[] = [];

  for (const [index, link] of metaProject.threadLinks.entries()) {
    const key = makeScopedThreadKey(link.environmentId, link.threadId);
    const existing = threadIndicesByKey.get(key);
    if (existing !== undefined) {
      existing.indices.push(index);
    } else {
      threadIndicesByKey.set(key, {
        environmentId: link.environmentId,
        projectId: link.projectId,
        threadId: link.threadId,
        indices: [index],
      } as {
        readonly environmentId: EnvironmentId;
        readonly threadId: ThreadId;
        readonly indices: number[];
      });
    }

    if (!isValidMetaProjectThreadRole(link.role)) {
      invalidThreadRoles.push({
        environmentId: link.environmentId,
        threadId: link.threadId,
        role: link.role,
        index,
      });
    }
  }

  const duplicateThreadLinks: DuplicateThreadLinkFinding[] = [];
  for (const entry of threadIndicesByKey.values()) {
    if (entry.indices.length > 1) {
      duplicateThreadLinks.push({
        environmentId: entry.environmentId,
        threadId: entry.threadId,
        indices: entry.indices,
      });
    }
  }

  const valid =
    duplicateMembers.length === 0 &&
    duplicateThreadLinks.length === 0 &&
    invalidMemberRoles.length === 0 &&
    invalidThreadRoles.length === 0;

  return {
    valid,
    duplicateMembers,
    duplicateThreadLinks,
    invalidMemberRoles,
    invalidThreadRoles,
  };
}

export function extractCleanupForDeletedProject<TMetaProject extends MetaProjectForValidation>(
  metaProject: TMetaProject,
  target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly deletedThreadIds?: ReadonlyArray<ThreadId> | undefined;
  },
): MetaProjectCleanupPlan<TMetaProject> {
  const deletedThreadSet = new Set<ThreadId>(target.deletedThreadIds ?? []);

  const membersToRemove: MetaProjectMemberForValidation[] = [];
  const keptMembers: MetaProjectMemberForValidation[] = [];
  for (const member of metaProject.members) {
    if (member.environmentId === target.environmentId && member.projectId === target.projectId) {
      membersToRemove.push(member);
    } else {
      keptMembers.push(member);
    }
  }

  const threadLinksToRemove: MetaProjectThreadLinkForValidation[] = [];
  const keptThreadLinks: MetaProjectThreadLinkForValidation[] = [];
  for (const link of metaProject.threadLinks) {
    const matchesProject =
      link.environmentId === target.environmentId && link.projectId === target.projectId;
    const matchesDeletedThread =
      link.environmentId === target.environmentId && deletedThreadSet.has(link.threadId);
    if (matchesProject || matchesDeletedThread) {
      threadLinksToRemove.push(link);
    } else {
      keptThreadLinks.push(link);
    }
  }

  const hasChanges = membersToRemove.length > 0 || threadLinksToRemove.length > 0;
  return {
    hasChanges,
    membersToRemove,
    threadLinksToRemove,
    nextMetaProject: hasChanges
      ? {
          ...metaProject,
          members: keptMembers,
          threadLinks: keptThreadLinks,
        }
      : metaProject,
  };
}

export function extractCleanupForDeletedEnvironment<TMetaProject extends MetaProjectForValidation>(
  metaProject: TMetaProject,
  environmentId: EnvironmentId,
): MetaProjectCleanupPlan<TMetaProject> {
  const membersToRemove: MetaProjectMemberForValidation[] = [];
  const keptMembers: MetaProjectMemberForValidation[] = [];
  for (const member of metaProject.members) {
    if (member.environmentId === environmentId) {
      membersToRemove.push(member);
    } else {
      keptMembers.push(member);
    }
  }

  const threadLinksToRemove: MetaProjectThreadLinkForValidation[] = [];
  const keptThreadLinks: MetaProjectThreadLinkForValidation[] = [];
  for (const link of metaProject.threadLinks) {
    if (link.environmentId === environmentId) {
      threadLinksToRemove.push(link);
    } else {
      keptThreadLinks.push(link);
    }
  }

  const hasChanges = membersToRemove.length > 0 || threadLinksToRemove.length > 0;
  return {
    hasChanges,
    membersToRemove,
    threadLinksToRemove,
    nextMetaProject: hasChanges
      ? {
          ...metaProject,
          members: keptMembers,
          threadLinks: keptThreadLinks,
        }
      : metaProject,
  };
}

export function extractStaleMetaProjectReferences<TMetaProject extends MetaProjectForValidation>(
  metaProject: TMetaProject,
  activeState: {
    readonly environmentIds: ReadonlyArray<EnvironmentId>;
    readonly projects: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }>;
    readonly threads?:
      | ReadonlyArray<{
          readonly environmentId: EnvironmentId;
          readonly threadId: ThreadId;
        }>
      | undefined;
  },
): MetaProjectCleanupPlan<TMetaProject> {
  const activeEnvs = new Set<EnvironmentId>(activeState.environmentIds);
  const activeProjectKeys = new Set<string>(
    activeState.projects.map((p) => makeScopedProjectKey(p.environmentId, p.projectId)),
  );
  const activeThreadKeys =
    activeState.threads !== undefined
      ? new Set<string>(
          activeState.threads.map((t) => makeScopedThreadKey(t.environmentId, t.threadId)),
        )
      : null;

  const membersToRemove: MetaProjectMemberForValidation[] = [];
  const keptMembers: MetaProjectMemberForValidation[] = [];
  for (const member of metaProject.members) {
    const projectKey = makeScopedProjectKey(member.environmentId, member.projectId);
    if (!activeEnvs.has(member.environmentId) || !activeProjectKeys.has(projectKey)) {
      membersToRemove.push(member);
    } else {
      keptMembers.push(member);
    }
  }

  const threadLinksToRemove: MetaProjectThreadLinkForValidation[] = [];
  const keptThreadLinks: MetaProjectThreadLinkForValidation[] = [];
  for (const link of metaProject.threadLinks) {
    const envMissing = !activeEnvs.has(link.environmentId);
    const projectMissing =
      link.projectId != null &&
      !activeProjectKeys.has(makeScopedProjectKey(link.environmentId, link.projectId));
    const threadMissing =
      activeThreadKeys !== null &&
      !activeThreadKeys.has(makeScopedThreadKey(link.environmentId, link.threadId));

    if (envMissing || projectMissing || threadMissing) {
      threadLinksToRemove.push(link);
    } else {
      keptThreadLinks.push(link);
    }
  }

  const hasChanges = membersToRemove.length > 0 || threadLinksToRemove.length > 0;
  return {
    hasChanges,
    membersToRemove,
    threadLinksToRemove,
    nextMetaProject: hasChanges
      ? {
          ...metaProject,
          members: keptMembers,
          threadLinks: keptThreadLinks,
        }
      : metaProject,
  };
}
