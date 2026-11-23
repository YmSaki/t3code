import type { EnvironmentId, IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";

export type MetaProjectThreadRole = "pm" | "cross_cutting" | "standard";

export interface MetaProjectMemberRecord {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly role: string;
  readonly label?: string | null | undefined;
  readonly description?: string | null | undefined;
  readonly sortOrder?: number | undefined;
  readonly addedAt?: IsoDateTime | undefined;
}

export interface MetaProjectThreadLinkRecord {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly role: MetaProjectThreadRole;
  readonly projectId?: ProjectId | null | undefined;
  readonly title?: string | null | undefined;
  readonly linkedAt?: IsoDateTime | undefined;
}

export interface MetaProjectRecord {
  readonly id: string;
  readonly title: string;
  readonly description?: string | null | undefined;
  readonly instructionsMd: string;
  readonly members: ReadonlyArray<MetaProjectMemberRecord>;
  readonly threadLinks: ReadonlyArray<MetaProjectThreadLinkRecord>;
  readonly pinnedAt?: IsoDateTime | null | undefined;
  readonly archivedAt?: IsoDateTime | null | undefined;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt?: IsoDateTime | null | undefined;
}

export interface MetaProjectEnvironmentInput {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal?: boolean | undefined;
  readonly online?: boolean | undefined;
}

export interface MetaProjectPhysicalProjectInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly pinnedAt?: IsoDateTime | null | undefined;
  readonly archivedAt?: IsoDateTime | null | undefined;
  readonly deletedAt?: IsoDateTime | null | undefined;
}

export interface MetaProjectThreadInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly updatedAt: IsoDateTime;
  readonly archivedAt?: IsoDateTime | null | undefined;
  readonly isActive?: boolean | undefined;
}

export interface MetaProjectEnvironmentBadge {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isLocal: boolean;
  readonly online: boolean;
}

export interface MetaProjectThreadNode {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly role: MetaProjectThreadRole;
  readonly environmentBadge: MetaProjectEnvironmentBadge;
  readonly updatedAt: IsoDateTime | null;
  readonly isActive: boolean;
  readonly missing: boolean;
}

export interface MetaProjectRepositoryNode {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string | null;
  readonly role: string;
  readonly environmentBadge: MetaProjectEnvironmentBadge;
  readonly threads: ReadonlyArray<MetaProjectThreadNode>;
  readonly missing: boolean;
}

export interface MetaProjectTreeNode {
  readonly metaProjectId: string;
  readonly title: string;
  readonly description: string | null;
  readonly pinned: boolean;
  readonly archived: boolean;
  readonly pmThreads: ReadonlyArray<MetaProjectThreadNode>;
  readonly crossCuttingThreads: ReadonlyArray<MetaProjectThreadNode>;
  readonly repositories: ReadonlyArray<MetaProjectRepositoryNode>;
}

export interface UncategorizedRepositoryNode {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly environmentBadge: MetaProjectEnvironmentBadge;
  readonly threads: ReadonlyArray<MetaProjectThreadNode>;
}

export interface MetaProjectHierarchyTree {
  readonly metaProjects: ReadonlyArray<MetaProjectTreeNode>;
  readonly uncategorizedRepositories: ReadonlyArray<UncategorizedRepositoryNode>;
}

export interface BuildMetaProjectTreeInput {
  readonly environments: ReadonlyArray<MetaProjectEnvironmentInput>;
  readonly physicalProjects: ReadonlyArray<MetaProjectPhysicalProjectInput>;
  readonly threads: ReadonlyArray<MetaProjectThreadInput>;
  readonly metaProjects: ReadonlyArray<MetaProjectRecord>;
  readonly includeArchived?: boolean | undefined;
}

const makeScopedProjectKey = (environmentId: EnvironmentId, projectId: ProjectId): string =>
  `${environmentId}\u0000${projectId}`;

const makeScopedThreadKey = (environmentId: EnvironmentId, threadId: ThreadId): string =>
  `${environmentId}\u0000${threadId}`;

const compareThreadNodes = (left: MetaProjectThreadNode, right: MetaProjectThreadNode): number => {
  if (left.updatedAt !== null && right.updatedAt !== null) {
    const timeDiff = right.updatedAt.localeCompare(left.updatedAt);
    if (timeDiff !== 0) return timeDiff;
  } else if (left.updatedAt !== null) {
    return -1;
  } else if (right.updatedAt !== null) {
    return 1;
  }
  return left.threadId.localeCompare(right.threadId);
};

export function buildMetaProjectHierarchyTree(
  input: BuildMetaProjectTreeInput,
): MetaProjectHierarchyTree {
  const includeArchived = input.includeArchived ?? false;

  const badgeByEnv = new Map<EnvironmentId, MetaProjectEnvironmentBadge>();
  for (const env of input.environments) {
    badgeByEnv.set(env.environmentId, {
      environmentId: env.environmentId,
      label: env.label,
      isLocal: env.isLocal ?? false,
      online: env.online ?? true,
    });
  }

  const resolveBadge = (environmentId: EnvironmentId): MetaProjectEnvironmentBadge =>
    badgeByEnv.get(environmentId) ?? {
      environmentId,
      label: environmentId,
      isLocal: false,
      online: false,
    };

  const activePhysicalProjects = input.physicalProjects.filter(
    (project) => project.deletedAt == null && (includeArchived || project.archivedAt == null),
  );
  const physicalProjectByKey = new Map<string, MetaProjectPhysicalProjectInput>();
  for (const project of activePhysicalProjects) {
    physicalProjectByKey.set(
      makeScopedProjectKey(project.environmentId, project.projectId),
      project,
    );
  }

  const visibleThreads = input.threads.filter(
    (thread) => includeArchived || thread.archivedAt == null,
  );
  const threadByKey = new Map<string, MetaProjectThreadInput>();
  const threadsByProjectKey = new Map<string, MetaProjectThreadInput[]>();
  for (const thread of visibleThreads) {
    threadByKey.set(makeScopedThreadKey(thread.environmentId, thread.threadId), thread);
    const projectKey = makeScopedProjectKey(thread.environmentId, thread.projectId);
    const list = threadsByProjectKey.get(projectKey);
    if (list !== undefined) {
      list.push(thread);
    } else {
      threadsByProjectKey.set(projectKey, [thread]);
    }
  }

  const visibleMetaProjects = input.metaProjects
    .filter((mp) => mp.deletedAt == null && (includeArchived || mp.archivedAt == null))
    .sort((left, right) => {
      const leftPinned = left.pinnedAt != null ? 0 : 1;
      const rightPinned = right.pinnedAt != null ? 0 : 1;
      if (leftPinned !== rightPinned) return leftPinned - rightPinned;
      const titleDiff = left.title.localeCompare(right.title);
      if (titleDiff !== 0) return titleDiff;
      return left.id.localeCompare(right.id);
    });

  const categorizedProjectKeys = new Set<string>();

  const toThreadNodeFromLink = (link: MetaProjectThreadLinkRecord): MetaProjectThreadNode => {
    const resolved = threadByKey.get(makeScopedThreadKey(link.environmentId, link.threadId));
    return {
      environmentId: link.environmentId,
      projectId: resolved?.projectId ?? link.projectId ?? null,
      threadId: link.threadId,
      title: link.title ?? resolved?.title ?? link.threadId,
      role: link.role,
      environmentBadge: resolveBadge(link.environmentId),
      updatedAt: resolved?.updatedAt ?? link.linkedAt ?? null,
      isActive: resolved?.isActive ?? false,
      missing: resolved === undefined,
    };
  };

  const toStandardThreadNode = (thread: MetaProjectThreadInput): MetaProjectThreadNode => ({
    environmentId: thread.environmentId,
    projectId: thread.projectId,
    threadId: thread.threadId,
    title: thread.title,
    role: "standard",
    environmentBadge: resolveBadge(thread.environmentId),
    updatedAt: thread.updatedAt,
    isActive: thread.isActive ?? false,
    missing: false,
  });

  const metaProjectNodes: MetaProjectTreeNode[] = visibleMetaProjects.map((mp) => {
    const pmThreads: MetaProjectThreadNode[] = [];
    const crossCuttingThreads: MetaProjectThreadNode[] = [];
    const elevatedThreadKeys = new Set<string>();
    const standardLinksByProjectKey = new Map<string, MetaProjectThreadLinkRecord[]>();

    for (const link of mp.threadLinks) {
      const threadKey = makeScopedThreadKey(link.environmentId, link.threadId);
      if (link.role === "pm") {
        if (!elevatedThreadKeys.has(threadKey)) {
          elevatedThreadKeys.add(threadKey);
          pmThreads.push(toThreadNodeFromLink(link));
        }
      } else if (link.role === "cross_cutting") {
        if (!elevatedThreadKeys.has(threadKey)) {
          elevatedThreadKeys.add(threadKey);
          crossCuttingThreads.push(toThreadNodeFromLink(link));
        }
      } else {
        const resolved = threadByKey.get(threadKey);
        const targetProjectId = link.projectId ?? resolved?.projectId;
        if (targetProjectId != null) {
          const projectKey = makeScopedProjectKey(link.environmentId, targetProjectId);
          const existing = standardLinksByProjectKey.get(projectKey);
          if (existing !== undefined) {
            existing.push(link);
          } else {
            standardLinksByProjectKey.set(projectKey, [link]);
          }
        }
      }
    }

    const seenMembers = new Set<string>();
    const repositoriesWithOrder: Array<{
      readonly node: MetaProjectRepositoryNode;
      readonly sortOrder: number;
    }> = [];

    for (const [index, member] of mp.members.entries()) {
      const projectKey = makeScopedProjectKey(member.environmentId, member.projectId);
      if (seenMembers.has(projectKey)) continue;
      seenMembers.add(projectKey);
      categorizedProjectKeys.add(projectKey);

      const physical = physicalProjectByKey.get(projectKey);
      const repoThreadMap = new Map<string, MetaProjectThreadNode>();

      for (const thread of threadsByProjectKey.get(projectKey) ?? []) {
        const threadKey = makeScopedThreadKey(thread.environmentId, thread.threadId);
        if (elevatedThreadKeys.has(threadKey)) continue;
        repoThreadMap.set(threadKey, toStandardThreadNode(thread));
      }

      for (const link of standardLinksByProjectKey.get(projectKey) ?? []) {
        const threadKey = makeScopedThreadKey(link.environmentId, link.threadId);
        if (elevatedThreadKeys.has(threadKey)) continue;
        if (!repoThreadMap.has(threadKey)) {
          repoThreadMap.set(threadKey, toThreadNodeFromLink(link));
        }
      }

      repositoriesWithOrder.push({
        sortOrder: member.sortOrder ?? index,
        node: {
          environmentId: member.environmentId,
          projectId: member.projectId,
          title: member.label ?? physical?.title ?? member.projectId,
          workspaceRoot: physical?.workspaceRoot ?? null,
          role: member.role,
          environmentBadge: resolveBadge(member.environmentId),
          threads: [...repoThreadMap.values()].sort(compareThreadNodes),
          missing: physical === undefined,
        },
      });
    }

    const repositories = [...repositoriesWithOrder]
      .sort((left, right) => {
        if (left.sortOrder !== right.sortOrder) return left.sortOrder - right.sortOrder;
        const titleDiff = left.node.title.localeCompare(right.node.title);
        if (titleDiff !== 0) return titleDiff;
        const envDiff = left.node.environmentId.localeCompare(right.node.environmentId);
        if (envDiff !== 0) return envDiff;
        return left.node.projectId.localeCompare(right.node.projectId);
      })
      .map((entry) => entry.node);

    return {
      metaProjectId: mp.id,
      title: mp.title,
      description: mp.description ?? null,
      pinned: mp.pinnedAt != null,
      archived: mp.archivedAt != null,
      pmThreads: [...pmThreads].sort(compareThreadNodes),
      crossCuttingThreads: [...crossCuttingThreads].sort(compareThreadNodes),
      repositories,
    };
  });

  const uncategorizedRepositories: UncategorizedRepositoryNode[] = activePhysicalProjects
    .filter(
      (project) =>
        !categorizedProjectKeys.has(makeScopedProjectKey(project.environmentId, project.projectId)),
    )
    .sort((left, right) => {
      const leftPinned = left.pinnedAt != null ? 0 : 1;
      const rightPinned = right.pinnedAt != null ? 0 : 1;
      if (leftPinned !== rightPinned) return leftPinned - rightPinned;
      const titleDiff = left.title.localeCompare(right.title);
      if (titleDiff !== 0) return titleDiff;
      const envDiff = left.environmentId.localeCompare(right.environmentId);
      if (envDiff !== 0) return envDiff;
      return left.projectId.localeCompare(right.projectId);
    })
    .map((project) => {
      const projectKey = makeScopedProjectKey(project.environmentId, project.projectId);
      const threads = (threadsByProjectKey.get(projectKey) ?? [])
        .map(toStandardThreadNode)
        .sort(compareThreadNodes);
      return {
        environmentId: project.environmentId,
        projectId: project.projectId,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
        environmentBadge: resolveBadge(project.environmentId),
        threads,
      };
    });

  return {
    metaProjects: metaProjectNodes,
    uncategorizedRepositories,
  };
}
