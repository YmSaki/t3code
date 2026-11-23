import {
  EnvironmentId,
  type MetaProject,
  type MetaProjectAddMemberInput,
  type MetaProjectAddMemberResult,
  type MetaProjectCreateInput,
  type MetaProjectCreateResult,
  type MetaProjectDeleteInput,
  type MetaProjectDeleteResult,
  MetaProjectError,
  type MetaProjectGetInput,
  type MetaProjectGetResult,
  MetaProjectId,
  type MetaProjectLinkThreadInput,
  type MetaProjectLinkThreadResult,
  type MetaProjectListInput,
  type MetaProjectListResult,
  type MetaProjectMember,
  type MetaProjectMutation,
  type MetaProjectRemoveMemberInput,
  type MetaProjectRemoveMemberResult,
  type MetaProjectRole,
  type MetaProjectThreadRole,
  type MetaProjectUnlinkThreadInput,
  type MetaProjectUnlinkThreadResult,
  type MetaProjectUpdateInput,
  type MetaProjectUpdateResult,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  formatMetaProjectAgentContext,
  type MetaProjectContextFormat,
  type MetaProjectContextRepositoryEntry,
  type MetaProjectFormattedContext,
} from "@t3tools/shared/metaProjectContext.core";
import {
  buildMetaProjectRollup,
  type MetaProjectRollupResult,
  type RollupIssueInput,
  type RollupPullRequestInput,
  type RollupThreadInput,
} from "@t3tools/shared/metaProjectRollup.core";
import {
  buildMetaProjectHierarchyTree,
  type MetaProjectEnvironmentInput,
  type MetaProjectHierarchyTree,
  type MetaProjectPhysicalProjectInput,
  type MetaProjectThreadInput,
} from "@t3tools/shared/metaProjectTree.core";
import {
  extractCleanupForDeletedEnvironment,
  extractCleanupForDeletedProject,
  isValidMetaProjectRole,
  isValidMetaProjectThreadRole,
  validateMetaProject,
} from "@t3tools/shared/metaProjectValidation.core";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as MetaProjectStore from "./MetaProjectStore.ts";

export interface MetaProjectEnvironmentSnapshot {
  readonly environment: MetaProjectEnvironmentInput;
  readonly physicalProjects: ReadonlyArray<MetaProjectPhysicalProjectInput>;
  readonly threads: ReadonlyArray<MetaProjectThreadInput>;
  readonly pullRequests?: ReadonlyArray<RollupPullRequestInput> | undefined;
  readonly issues?: ReadonlyArray<RollupIssueInput> | undefined;
  readonly rollupThreads?: ReadonlyArray<RollupThreadInput> | undefined;
}

export interface MetaProjectDataSourceShape {
  readonly getLocalSnapshot?: (() => Effect.Effect<MetaProjectEnvironmentSnapshot>) | undefined;
  readonly fetchRemoteEnvironmentSnapshot?:
    | ((
        environmentId: EnvironmentId,
        projectIds: ReadonlyArray<ProjectId>,
      ) => Effect.Effect<MetaProjectEnvironmentSnapshot | null>)
    | undefined;
}

export class MetaProjectDataSource extends Context.Service<
  MetaProjectDataSource,
  MetaProjectDataSourceShape
>()("t3/metaProject/MetaProjectService/MetaProjectDataSource") {}

export type MetaProjectMutationOutcome =
  | MetaProjectCreateResult
  | MetaProjectUpdateResult
  | MetaProjectDeleteResult
  | MetaProjectAddMemberResult
  | MetaProjectRemoveMemberResult
  | MetaProjectLinkThreadResult
  | MetaProjectUnlinkThreadResult;

export interface MetaProjectSharedContextResult extends MetaProjectFormattedContext {
  readonly metaProjectId: MetaProjectId;
}

export interface MetaProjectServiceShape {
  readonly list: (
    input?: MetaProjectListInput | undefined,
  ) => Effect.Effect<MetaProjectListResult, MetaProjectError>;
  readonly get: (
    input: MetaProjectGetInput,
  ) => Effect.Effect<MetaProjectGetResult, MetaProjectError>;
  readonly listMembers: (
    metaProjectId: MetaProjectId,
  ) => Effect.Effect<ReadonlyArray<MetaProjectMember>, MetaProjectError>;
  readonly create: (
    input: MetaProjectCreateInput,
  ) => Effect.Effect<MetaProjectCreateResult, MetaProjectError>;
  readonly update: (
    input: MetaProjectUpdateInput,
  ) => Effect.Effect<MetaProjectUpdateResult, MetaProjectError>;
  readonly delete: (
    input: MetaProjectDeleteInput,
  ) => Effect.Effect<MetaProjectDeleteResult, MetaProjectError>;
  readonly addMember: (
    input: MetaProjectAddMemberInput,
  ) => Effect.Effect<MetaProjectAddMemberResult, MetaProjectError>;
  readonly removeMember: (
    input: MetaProjectRemoveMemberInput,
  ) => Effect.Effect<MetaProjectRemoveMemberResult, MetaProjectError>;
  readonly linkThread: (
    input: MetaProjectLinkThreadInput,
  ) => Effect.Effect<MetaProjectLinkThreadResult, MetaProjectError>;
  readonly unlinkThread: (
    input: MetaProjectUnlinkThreadInput,
  ) => Effect.Effect<MetaProjectUnlinkThreadResult, MetaProjectError>;
  readonly mutate: (
    mutation: MetaProjectMutation,
  ) => Effect.Effect<MetaProjectMutationOutcome, MetaProjectError>;
  readonly getTree: (options?: {
    readonly includeArchived?: boolean | undefined;
  }) => Effect.Effect<MetaProjectHierarchyTree, MetaProjectError>;
  readonly getSharedContext: (input: {
    readonly metaProjectId?: MetaProjectId | undefined;
    readonly environmentId?: EnvironmentId | undefined;
    readonly projectId?: ProjectId | undefined;
    readonly format?: MetaProjectContextFormat | undefined;
    readonly maxChars?: number | undefined;
  }) => Effect.Effect<MetaProjectSharedContextResult | null, MetaProjectError>;
  readonly getRollup: (input: {
    readonly metaProjectId: MetaProjectId;
  }) => Effect.Effect<MetaProjectRollupResult, MetaProjectError>;
  readonly cleanupDeletedProject: (target: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly deletedThreadIds?: ReadonlyArray<ThreadId> | undefined;
  }) => Effect.Effect<ReadonlyArray<MetaProject>, MetaProjectError>;
  readonly cleanupDeletedEnvironment: (
    environmentId: EnvironmentId,
  ) => Effect.Effect<ReadonlyArray<MetaProject>, MetaProjectError>;
}

export class MetaProjectService extends Context.Service<
  MetaProjectService,
  MetaProjectServiceShape
>()("t3/metaProject/MetaProjectService") {}

const DEFAULT_LOCAL_ENV_ID = EnvironmentId.make("env-local");

export const makeWithDataSource = Effect.fn("MetaProjectService.makeWithDataSource")(function* (
  explicitDataSource?: MetaProjectDataSourceShape | undefined,
) {
  const store = yield* MetaProjectStore.MetaProjectStore;
  const contextDataSource = yield* Effect.serviceOption(MetaProjectDataSource);
  const serverEnvironment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
  const projectStore = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);

  const dataSource: MetaProjectDataSourceShape =
    explicitDataSource ?? (Option.isSome(contextDataSource) ? contextDataSource.value : {});

  let generatedCounter = 0;
  const allocateMetaProjectId = Effect.fn("MetaProjectService.allocateMetaProjectId")(function* (
    explicitId?: MetaProjectId | undefined,
    commandId?: string | undefined,
  ) {
    if (explicitId !== undefined) return explicitId;
    if (commandId !== undefined) return MetaProjectId.make(commandId);
    generatedCounter += 1;
    const epochMs = DateTime.toEpochMillis(yield* DateTime.now);
    return MetaProjectId.make(`mp-${epochMs}-${generatedCounter}`);
  });

  const readDefaultLocalSnapshot = Effect.gen(
    function* (): Effect.fn.Return<MetaProjectEnvironmentSnapshot> {
      const descriptor = Option.isSome(serverEnvironment)
        ? yield* serverEnvironment.value.getDescriptor.pipe(Effect.orElseSucceed(() => null))
        : null;
      const localEnvironmentId = descriptor?.environmentId ?? DEFAULT_LOCAL_ENV_ID;
      const localLabel = descriptor?.label ?? "Local";

      const localProjectRows = Option.isSome(projectStore)
        ? yield* projectStore.value.list().pipe(Effect.orElseSucceed(() => []))
        : [];

      const physicalProjects: MetaProjectPhysicalProjectInput[] = localProjectRows.map((row) => ({
        environmentId: localEnvironmentId,
        projectId: row.projectId,
        title: row.title,
        workspaceRoot: row.workspaceRoot,
        pinnedAt: row.pinnedAt,
        archivedAt: row.archivedAt,
        deletedAt: row.deletedAt,
      }));

      return {
        environment: {
          environmentId: localEnvironmentId,
          label: localLabel,
          isLocal: true,
          online: true,
        },
        physicalProjects,
        threads: [],
      };
    },
  );

  const collectSnapshotsForMetaProjects = Effect.fn(
    "MetaProjectService.collectSnapshotsForMetaProjects",
  )(function* (
    metaProjects: ReadonlyArray<MetaProject>,
  ): Effect.fn.Return<ReadonlyArray<MetaProjectEnvironmentSnapshot>> {
    const localSnapshot =
      dataSource.getLocalSnapshot !== undefined
        ? yield* dataSource.getLocalSnapshot()
        : yield* readDefaultLocalSnapshot;

    const snapshots: MetaProjectEnvironmentSnapshot[] = [localSnapshot];
    if (dataSource.fetchRemoteEnvironmentSnapshot === undefined) {
      return snapshots;
    }

    const remoteProjectsByEnv = new Map<EnvironmentId, Set<ProjectId>>();
    for (const mp of metaProjects) {
      for (const member of mp.members) {
        if (member.environmentId === localSnapshot.environment.environmentId) continue;
        let projectSet = remoteProjectsByEnv.get(member.environmentId);
        if (projectSet === undefined) {
          projectSet = new Set<ProjectId>();
          remoteProjectsByEnv.set(member.environmentId, projectSet);
        }
        projectSet.add(member.projectId);
      }
      for (const link of mp.threadLinks) {
        if (link.environmentId === localSnapshot.environment.environmentId) continue;
        if (!remoteProjectsByEnv.has(link.environmentId)) {
          remoteProjectsByEnv.set(link.environmentId, new Set<ProjectId>());
        }
        if (link.projectId != null) {
          remoteProjectsByEnv.get(link.environmentId)?.add(link.projectId);
        }
      }
    }

    for (const [remoteEnvId, projectSet] of remoteProjectsByEnv.entries()) {
      const remoteSnapshot = yield* dataSource
        .fetchRemoteEnvironmentSnapshot(remoteEnvId, [...projectSet])
        .pipe(Effect.orElseSucceed(() => null));
      if (remoteSnapshot !== null) {
        snapshots.push(remoteSnapshot);
      }
    }

    return snapshots;
  });

  const list: MetaProjectServiceShape["list"] = Effect.fn("MetaProjectService.list")(
    function* (input) {
      const metaProjects = yield* store.list({
        includeArchived: input?.includeArchived,
      });
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      return {
        metaProjects,
        updatedAt,
      };
    },
  );

  const get: MetaProjectServiceShape["get"] = Effect.fn("MetaProjectService.get")(
    function* (input) {
      const found = yield* store.get(input.metaProjectId);
      if (Option.isNone(found)) {
        return yield* new MetaProjectError({
          reason: "not_found",
          message: `MetaProject '${input.metaProjectId}' was not found.`,
          metaProjectId: input.metaProjectId,
        });
      }
      return { metaProject: found.value };
    },
  );

  const listMembers: MetaProjectServiceShape["listMembers"] = Effect.fn(
    "MetaProjectService.listMembers",
  )(function* (metaProjectId) {
    return yield* store.listMembers(metaProjectId);
  });

  const create: MetaProjectServiceShape["create"] = Effect.fn("MetaProjectService.create")(
    function* (input) {
      const members = input.members ?? [];
      const threadLinks = input.threadLinks ?? [];
      const validation = validateMetaProject({ members, threadLinks });
      if (!validation.valid) {
        if (validation.duplicateMembers.length > 0) {
          const dup = validation.duplicateMembers[0]!;
          return yield* new MetaProjectError({
            reason: "duplicate_member",
            message: `Duplicate member '${dup.projectId}' in environment '${dup.environmentId}'.`,
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
          });
        }
        if (validation.duplicateThreadLinks.length > 0) {
          const dup = validation.duplicateThreadLinks[0]!;
          return yield* new MetaProjectError({
            reason: "duplicate_thread_link",
            message: `Duplicate thread link '${dup.threadId}' in environment '${dup.environmentId}'.`,
            ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
          });
        }
        return yield* new MetaProjectError({
          reason: "invalid_role",
          message: "MetaProject contains an invalid member or thread role.",
          ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        });
      }

      const id = yield* allocateMetaProjectId(input.id, input.commandId);
      const metaProject = yield* store.create({
        id,
        title: input.title,
        description: input.description,
        instructionsMd: input.instructionsMd,
        members,
        threadLinks,
      });
      return { metaProject };
    },
  );

  const update: MetaProjectServiceShape["update"] = Effect.fn("MetaProjectService.update")(
    function* (input) {
      const metaProject = yield* store.update({
        metaProjectId: input.metaProjectId,
        title: input.title,
        description: input.description,
        instructionsMd: input.instructionsMd,
        pinned: input.pinned,
        archived: input.archived,
      });
      return { metaProject };
    },
  );

  const remove: MetaProjectServiceShape["delete"] = Effect.fn("MetaProjectService.delete")(
    function* (input) {
      const deleted = yield* store.delete(input.metaProjectId);
      return {
        metaProjectId: input.metaProjectId,
        deleted,
      };
    },
  );

  const addMember: MetaProjectServiceShape["addMember"] = Effect.fn("MetaProjectService.addMember")(
    function* (input) {
      if (!isValidMetaProjectRole(input.member.role)) {
        return yield* new MetaProjectError({
          reason: "invalid_role",
          message: `Invalid member role '${input.member.role}'.`,
          metaProjectId: input.metaProjectId,
          ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
        });
      }
      const metaProject = yield* store.addMember({
        metaProjectId: input.metaProjectId,
        member: input.member,
      });
      return { metaProject };
    },
  );

  const removeMember: MetaProjectServiceShape["removeMember"] = Effect.fn(
    "MetaProjectService.removeMember",
  )(function* (input) {
    return yield* store.removeMember({
      metaProjectId: input.metaProjectId,
      environmentId: input.environmentId,
      projectId: input.projectId,
    });
  });

  const linkThread: MetaProjectServiceShape["linkThread"] = Effect.fn(
    "MetaProjectService.linkThread",
  )(function* (input) {
    if (!isValidMetaProjectThreadRole(input.threadLink.role)) {
      return yield* new MetaProjectError({
        reason: "invalid_role",
        message: `Invalid thread role '${input.threadLink.role}'.`,
        metaProjectId: input.metaProjectId,
        ...(input.commandId === undefined ? {} : { commandId: input.commandId }),
      });
    }
    const metaProject = yield* store.linkThread({
      metaProjectId: input.metaProjectId,
      threadLink: input.threadLink,
    });
    return { metaProject };
  });

  const unlinkThread: MetaProjectServiceShape["unlinkThread"] = Effect.fn(
    "MetaProjectService.unlinkThread",
  )(function* (input) {
    return yield* store.unlinkThread({
      metaProjectId: input.metaProjectId,
      environmentId: input.environmentId,
      threadId: input.threadId,
    });
  });

  const mutate: MetaProjectServiceShape["mutate"] = Effect.fn("MetaProjectService.mutate")(
    function* (mutation) {
      switch (mutation.type) {
        case "metaProject.create":
          return yield* create(mutation);
        case "metaProject.update":
          return yield* update(mutation);
        case "metaProject.delete":
          return yield* remove(mutation);
        case "metaProject.addMember":
          return yield* addMember(mutation);
        case "metaProject.removeMember":
          return yield* removeMember(mutation);
        case "metaProject.linkThread":
          return yield* linkThread(mutation);
        case "metaProject.unlinkThread":
          return yield* unlinkThread(mutation);
      }
    },
  );

  const getTree: MetaProjectServiceShape["getTree"] = Effect.fn("MetaProjectService.getTree")(
    function* (options) {
      const includeArchived = options?.includeArchived ?? false;
      const metaProjects = yield* store.list({ includeArchived });
      const snapshots = yield* collectSnapshotsForMetaProjects(metaProjects);

      const environments: MetaProjectEnvironmentInput[] = [];
      const physicalProjects: MetaProjectPhysicalProjectInput[] = [];
      const threads: MetaProjectThreadInput[] = [];

      for (const snap of snapshots) {
        environments.push(snap.environment);
        physicalProjects.push(...snap.physicalProjects);
        threads.push(...snap.threads);
      }

      return buildMetaProjectHierarchyTree({
        environments,
        physicalProjects,
        threads,
        metaProjects,
        includeArchived,
      });
    },
  );

  const getSharedContext: MetaProjectServiceShape["getSharedContext"] = Effect.fn(
    "MetaProjectService.getSharedContext",
  )(function* (input) {
    let targetMeta: MetaProject | null = null;

    if (input.metaProjectId !== undefined) {
      const found = yield* store.get(input.metaProjectId);
      if (Option.isNone(found)) {
        return yield* new MetaProjectError({
          reason: "not_found",
          message: `MetaProject '${input.metaProjectId}' was not found.`,
          metaProjectId: input.metaProjectId,
        });
      }
      targetMeta = found.value;
    } else if (input.environmentId !== undefined && input.projectId !== undefined) {
      const matches = yield* store.findByMemberProject({
        environmentId: input.environmentId,
        projectId: input.projectId,
      });
      targetMeta = matches[0] ?? null;
    }

    if (targetMeta === null) return null;

    const snapshots = yield* collectSnapshotsForMetaProjects([targetMeta]);
    const envLabelById = new Map<EnvironmentId, string>();
    const physicalProjectByKey = new Map<string, MetaProjectPhysicalProjectInput>();

    for (const snap of snapshots) {
      envLabelById.set(snap.environment.environmentId, snap.environment.label);
      for (const proj of snap.physicalProjects) {
        physicalProjectByKey.set(`${proj.environmentId}\u0000${proj.projectId}`, proj);
      }
    }

    const repositories: MetaProjectContextRepositoryEntry[] = targetMeta.members.map((member) => {
      const physical = physicalProjectByKey.get(`${member.environmentId}\u0000${member.projectId}`);
      return {
        environmentId: member.environmentId,
        environmentLabel: envLabelById.get(member.environmentId) ?? member.environmentId,
        projectId: member.projectId,
        title: member.label ?? physical?.title ?? member.projectId,
        workspaceRoot: physical?.workspaceRoot ?? null,
        role: member.role,
        description: member.description ?? null,
      };
    });

    const formatted = formatMetaProjectAgentContext({
      metaProjectId: targetMeta.id,
      title: targetMeta.title,
      description: targetMeta.description ?? null,
      instructionsMd: targetMeta.instructionsMd,
      repositories,
      activeRepository:
        input.environmentId !== undefined && input.projectId !== undefined
          ? { environmentId: input.environmentId, projectId: input.projectId }
          : null,
      format: input.format,
      maxChars: input.maxChars,
    });

    return {
      metaProjectId: targetMeta.id,
      ...formatted,
    };
  });

  const getRollup: MetaProjectServiceShape["getRollup"] = Effect.fn("MetaProjectService.getRollup")(
    function* (input) {
      const { metaProject } = yield* get({ metaProjectId: input.metaProjectId });
      const snapshots = yield* collectSnapshotsForMetaProjects([metaProject]);

      const memberProjectKeys = new Set<string>(
        metaProject.members.map((m) => `${m.environmentId}\u0000${m.projectId}`),
      );
      const roleByThreadKey = new Map<string, "pm" | "cross_cutting" | "standard">();
      for (const link of metaProject.threadLinks) {
        roleByThreadKey.set(`${link.environmentId}\u0000${link.threadId}`, link.role);
      }

      const pullRequests: RollupPullRequestInput[] = [];
      const issues: RollupIssueInput[] = [];
      const threads: RollupThreadInput[] = [];

      for (const snap of snapshots) {
        for (const pr of snap.pullRequests ?? []) {
          if (memberProjectKeys.has(`${pr.environmentId}\u0000${pr.projectId}`)) {
            pullRequests.push(pr);
          }
        }
        for (const issue of snap.issues ?? []) {
          if (memberProjectKeys.has(`${issue.environmentId}\u0000${issue.projectId}`)) {
            issues.push(issue);
          }
        }
        if (snap.rollupThreads !== undefined) {
          for (const thread of snap.rollupThreads) {
            const threadKey = `${thread.environmentId}\u0000${thread.threadId}`;
            const linkedRole = roleByThreadKey.get(threadKey);
            const belongsToMember = memberProjectKeys.has(
              `${thread.environmentId}\u0000${thread.projectId}`,
            );
            if (belongsToMember || linkedRole !== undefined) {
              threads.push({
                ...thread,
                role: linkedRole ?? thread.role ?? "standard",
              });
            }
          }
        } else {
          for (const thread of snap.threads) {
            const threadKey = `${thread.environmentId}\u0000${thread.threadId}`;
            const linkedRole = roleByThreadKey.get(threadKey);
            const belongsToMember = memberProjectKeys.has(
              `${thread.environmentId}\u0000${thread.projectId}`,
            );
            if (belongsToMember || linkedRole !== undefined) {
              threads.push({
                environmentId: thread.environmentId,
                projectId: thread.projectId,
                threadId: thread.threadId,
                title: thread.title,
                role: linkedRole ?? "standard",
                status: thread.isActive ? "running" : "idle",
                updatedAt: thread.updatedAt,
              });
            }
          }
        }
      }

      return buildMetaProjectRollup({
        pullRequests,
        issues,
        threads,
      });
    },
  );

  const cleanupDeletedProject: MetaProjectServiceShape["cleanupDeletedProject"] = Effect.fn(
    "MetaProjectService.cleanupDeletedProject",
  )(function* (target) {
    const all = yield* store.list({ includeArchived: true });
    const updated: MetaProject[] = [];

    for (const mp of all) {
      const plan = extractCleanupForDeletedProject(mp, target);
      if (!plan.hasChanges) continue;
      const saved = yield* store.replaceMembersAndThreads({
        metaProjectId: mp.id,
        members: plan.nextMetaProject.members.map((m) => ({
          ...m,
          role: m.role as MetaProjectRole,
        })),
        threadLinks: plan.nextMetaProject.threadLinks.map((l) => ({
          ...l,
          role: l.role as MetaProjectThreadRole,
        })),
      });
      updated.push(saved);
    }

    return updated;
  });

  const cleanupDeletedEnvironment: MetaProjectServiceShape["cleanupDeletedEnvironment"] = Effect.fn(
    "MetaProjectService.cleanupDeletedEnvironment",
  )(function* (environmentId) {
    const all = yield* store.list({ includeArchived: true });
    const updated: MetaProject[] = [];

    for (const mp of all) {
      const plan = extractCleanupForDeletedEnvironment(mp, environmentId);
      if (!plan.hasChanges) continue;
      const saved = yield* store.replaceMembersAndThreads({
        metaProjectId: mp.id,
        members: plan.nextMetaProject.members.map((m) => ({
          ...m,
          role: m.role as MetaProjectRole,
        })),
        threadLinks: plan.nextMetaProject.threadLinks.map((l) => ({
          ...l,
          role: l.role as MetaProjectThreadRole,
        })),
      });
      updated.push(saved);
    }

    return updated;
  });

  return MetaProjectService.of({
    list,
    get,
    listMembers,
    create,
    update,
    delete: remove,
    addMember,
    removeMember,
    linkThread,
    unlinkThread,
    mutate,
    getTree,
    getSharedContext,
    getRollup,
    cleanupDeletedProject,
    cleanupDeletedEnvironment,
  });
});

export const make = makeWithDataSource();

export const layer = Layer.effect(MetaProjectService, make);

export const layerWithDataSource = (dataSource: MetaProjectDataSourceShape) =>
  Layer.effect(MetaProjectService, makeWithDataSource(dataSource));
