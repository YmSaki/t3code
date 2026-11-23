import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import type {
  MetaProjectEnvironmentBadge,
  MetaProjectHierarchyTree,
  MetaProjectTreeNode,
} from "@t3tools/shared/metaProjectTree.core";

export interface SidebarMetaProjectExpansionState {
  readonly expandedMetaProjectIds: ReadonlyArray<string>;
  readonly uncategorizedExpanded: boolean;
}

export const DEFAULT_SIDEBAR_META_PROJECT_EXPANSION: SidebarMetaProjectExpansionState = {
  expandedMetaProjectIds: [],
  uncategorizedExpanded: true,
};

export interface SidebarProjectDragPayload {
  readonly kind: "physical_project";
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly sourceMetaProjectId?: string | null | undefined;
}

export interface SidebarProjectDropEligibility {
  readonly allowed: boolean;
  readonly reason: "valid" | "same_meta_project" | "already_member";
}

export interface SidebarProjectDropAssignment {
  readonly shouldAdd: boolean;
  readonly shouldRemoveFromSource: boolean;
  readonly sourceMetaProjectId: string | null;
  readonly targetMetaProjectId: string;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly role: string;
}

export interface MetaProjectSidebarCounts {
  readonly metaProjectCount: number;
  readonly categorizedRepositoryCount: number;
  readonly uncategorizedRepositoryCount: number;
  readonly activePmThreadCount: number;
  readonly activeCrossCuttingThreadCount: number;
}

const META_PROJECT_DROP_PREFIX = "meta-project-drop:";
const SIDEBAR_PROJECT_DRAG_PREFIX = "meta-project-drag:";

export function isMetaProjectExpanded(
  state: SidebarMetaProjectExpansionState,
  metaProjectId: string,
): boolean {
  return state.expandedMetaProjectIds.includes(metaProjectId);
}

export function setMetaProjectExpanded(
  state: SidebarMetaProjectExpansionState,
  metaProjectId: string,
  expanded: boolean,
): SidebarMetaProjectExpansionState {
  const already = state.expandedMetaProjectIds.includes(metaProjectId);
  if (expanded === already) return state;
  return {
    ...state,
    expandedMetaProjectIds: expanded
      ? [...state.expandedMetaProjectIds, metaProjectId]
      : state.expandedMetaProjectIds.filter((id) => id !== metaProjectId),
  };
}

export function toggleMetaProjectExpanded(
  state: SidebarMetaProjectExpansionState,
  metaProjectId: string,
): SidebarMetaProjectExpansionState {
  return setMetaProjectExpanded(state, metaProjectId, !isMetaProjectExpanded(state, metaProjectId));
}

export function toggleUncategorizedExpanded(
  state: SidebarMetaProjectExpansionState,
): SidebarMetaProjectExpansionState {
  return {
    ...state,
    uncategorizedExpanded: !state.uncategorizedExpanded,
  };
}

export function makeSidebarProjectDragId(
  environmentId: EnvironmentId,
  projectId: ProjectId,
): string {
  return `${SIDEBAR_PROJECT_DRAG_PREFIX}${environmentId}:${projectId}`;
}

export function makeMetaProjectDropId(metaProjectId: string): string {
  return `${META_PROJECT_DROP_PREFIX}${metaProjectId}`;
}

export function parseMetaProjectDropId(id: unknown): string | null {
  if (typeof id !== "string" || !id.startsWith(META_PROJECT_DROP_PREFIX)) {
    return null;
  }
  const rest = id.slice(META_PROJECT_DROP_PREFIX.length);
  return rest.length > 0 ? rest : null;
}

export function parseSidebarProjectDragPayload(data: unknown): SidebarProjectDragPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const candidate = data as Record<string, unknown>;
  if (candidate.kind !== "physical_project") return null;
  if (typeof candidate.environmentId !== "string" || candidate.environmentId.length === 0) {
    return null;
  }
  if (typeof candidate.projectId !== "string" || candidate.projectId.length === 0) {
    return null;
  }
  return {
    kind: "physical_project",
    environmentId: candidate.environmentId as EnvironmentId,
    projectId: candidate.projectId as ProjectId,
    sourceMetaProjectId:
      typeof candidate.sourceMetaProjectId === "string" ? candidate.sourceMetaProjectId : null,
  };
}

export function canDropProjectIntoMetaProject(
  payload: SidebarProjectDragPayload,
  targetMetaProject: Pick<MetaProjectTreeNode, "metaProjectId" | "repositories">,
): SidebarProjectDropEligibility {
  if (payload.sourceMetaProjectId === targetMetaProject.metaProjectId) {
    return { allowed: false, reason: "same_meta_project" };
  }
  const alreadyMember = targetMetaProject.repositories.some(
    (repo) => repo.environmentId === payload.environmentId && repo.projectId === payload.projectId,
  );
  if (alreadyMember) {
    return { allowed: false, reason: "already_member" };
  }
  return { allowed: true, reason: "valid" };
}

export function computeProjectDropAssignment(
  payload: SidebarProjectDragPayload,
  targetMetaProject: Pick<MetaProjectTreeNode, "metaProjectId" | "repositories">,
  defaultRole = "other",
): SidebarProjectDropAssignment | null {
  const eligibility = canDropProjectIntoMetaProject(payload, targetMetaProject);
  if (!eligibility.allowed) return null;

  const sourceMetaProjectId = payload.sourceMetaProjectId ?? null;
  return {
    shouldAdd: true,
    shouldRemoveFromSource:
      sourceMetaProjectId !== null && sourceMetaProjectId !== targetMetaProject.metaProjectId,
    sourceMetaProjectId,
    targetMetaProjectId: targetMetaProject.metaProjectId,
    environmentId: payload.environmentId,
    projectId: payload.projectId,
    role: defaultRole,
  };
}

export function summarizeMetaProjectCounts(
  tree: MetaProjectHierarchyTree,
): MetaProjectSidebarCounts {
  let categorizedRepositoryCount = 0;
  let activePmThreadCount = 0;
  let activeCrossCuttingThreadCount = 0;

  for (const mp of tree.metaProjects) {
    categorizedRepositoryCount += mp.repositories.length;
    for (const thread of mp.pmThreads) {
      if (thread.isActive) activePmThreadCount += 1;
    }
    for (const thread of mp.crossCuttingThreads) {
      if (thread.isActive) activeCrossCuttingThreadCount += 1;
    }
  }

  return {
    metaProjectCount: tree.metaProjects.length,
    categorizedRepositoryCount,
    uncategorizedRepositoryCount: tree.uncategorizedRepositories.length,
    activePmThreadCount,
    activeCrossCuttingThreadCount,
  };
}

export function formatEnvironmentBadgeLabel(
  badge: Pick<MetaProjectEnvironmentBadge, "label" | "isLocal" | "online">,
  options?: {
    readonly localLabel?: string | undefined;
    readonly offlineSuffix?: string | undefined;
  },
): string {
  const baseLabel = badge.isLocal && options?.localLabel ? options.localLabel : badge.label;
  if (!badge.online) {
    return options?.offlineSuffix ? `${baseLabel} (${options.offlineSuffix})` : baseLabel;
  }
  return baseLabel;
}

export function filterMetaProjectTree(
  tree: MetaProjectHierarchyTree,
  rawQuery: string,
): MetaProjectHierarchyTree {
  const needle = rawQuery.trim().toLowerCase();
  if (needle.length === 0) return tree;

  const matchesText = (value: string | null | undefined) =>
    value != null && value.toLowerCase().includes(needle);

  const metaProjects = tree.metaProjects.flatMap((mp) => {
    const metaMatches = matchesText(mp.title) || matchesText(mp.description);
    if (metaMatches) return [mp];

    const pmThreads = mp.pmThreads.filter((thread) => matchesText(thread.title));
    const crossCuttingThreads = mp.crossCuttingThreads.filter((thread) =>
      matchesText(thread.title),
    );
    const repositories = mp.repositories.filter(
      (repo) =>
        matchesText(repo.title) ||
        matchesText(repo.role) ||
        matchesText(repo.environmentBadge.label) ||
        repo.threads.some((thread) => matchesText(thread.title)),
    );

    if (pmThreads.length === 0 && crossCuttingThreads.length === 0 && repositories.length === 0) {
      return [];
    }

    return [
      {
        ...mp,
        pmThreads,
        crossCuttingThreads,
        repositories,
      },
    ];
  });

  const uncategorizedRepositories = tree.uncategorizedRepositories.filter(
    (repo) =>
      matchesText(repo.title) ||
      matchesText(repo.environmentBadge.label) ||
      repo.threads.some((thread) => matchesText(thread.title)),
  );

  return {
    metaProjects,
    uncategorizedRepositories,
  };
}
