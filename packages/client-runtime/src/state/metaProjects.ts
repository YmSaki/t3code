import {
  type CommandId,
  type EnvironmentId,
  type MetaProject,
  type MetaProjectAddMemberInput,
  type MetaProjectAddMemberResult,
  type MetaProjectCreateInput,
  type MetaProjectCreateResult,
  type MetaProjectDeleteInput,
  type MetaProjectDeleteResult,
  type MetaProjectId,
  type MetaProjectLinkThreadInput,
  type MetaProjectLinkThreadResult,
  type MetaProjectListInput,
  type MetaProjectListResult,
  type MetaProjectMutation,
  type MetaProjectRemoveMemberInput,
  type MetaProjectRemoveMemberResult,
  type MetaProjectUnlinkThreadInput,
  type MetaProjectUnlinkThreadResult,
  type MetaProjectUpdateInput,
  type MetaProjectUpdateResult,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentRpcInput, EnvironmentRpcSuccess } from "../rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export type MetaProjectTreeResult = EnvironmentRpcSuccess<typeof WS_METHODS.metaProjectsGetTree>;
export type MetaProjectContextResult = EnvironmentRpcSuccess<
  typeof WS_METHODS.metaProjectsGetContext
>;
export type MetaProjectRollupData = EnvironmentRpcSuccess<typeof WS_METHODS.metaProjectsGetRollup>;
export type MetaProjectMutationResult = EnvironmentRpcSuccess<typeof WS_METHODS.metaProjectsMutate>;

export interface MetaProjectGetTargetInput {
  readonly metaProjectId: MetaProjectId;
  readonly includeArchived?: boolean | undefined;
}

interface PendingOptimisticMutation {
  readonly key: number;
  readonly mutation: MetaProjectMutation;
}

export function applyOptimisticMetaProjectMutation(
  metaProjects: ReadonlyArray<MetaProject>,
  mutation: MetaProjectMutation,
  nowIso = "1970-01-01T00:00:00.000Z",
): ReadonlyArray<MetaProject> {
  switch (mutation.type) {
    case "metaProject.create": {
      const candidateId = (mutation.id ?? mutation.commandId) as MetaProjectId | undefined;
      if (candidateId === undefined) return metaProjects;
      if (metaProjects.some((item) => item.id === candidateId)) return metaProjects;
      const created: MetaProject = {
        id: candidateId,
        title: mutation.title.trim(),
        description: mutation.description ?? null,
        instructionsMd: mutation.instructionsMd ?? "",
        members: mutation.members ?? [],
        threadLinks: mutation.threadLinks ?? [],
        pinnedAt: null,
        archivedAt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
        deletedAt: null,
      };
      return [created, ...metaProjects];
    }
    case "metaProject.update":
      return metaProjects.map((item) => {
        if (item.id !== mutation.metaProjectId) return item;
        return {
          ...item,
          title: mutation.title !== undefined ? mutation.title.trim() : item.title,
          description: mutation.description !== undefined ? mutation.description : item.description,
          instructionsMd:
            mutation.instructionsMd !== undefined ? mutation.instructionsMd : item.instructionsMd,
          pinnedAt:
            mutation.pinned === undefined
              ? item.pinnedAt
              : mutation.pinned
                ? (item.pinnedAt ?? nowIso)
                : null,
          archivedAt:
            mutation.archived === undefined
              ? item.archivedAt
              : mutation.archived
                ? (item.archivedAt ?? nowIso)
                : null,
          updatedAt: nowIso,
        };
      });
    case "metaProject.delete":
      return metaProjects.filter((item) => item.id !== mutation.metaProjectId);
    case "metaProject.addMember":
      return metaProjects.map((item) => {
        if (item.id !== mutation.metaProjectId) return item;
        const alreadyMember = item.members.some(
          (member) =>
            member.environmentId === mutation.member.environmentId &&
            member.projectId === mutation.member.projectId,
        );
        if (alreadyMember) return item;
        return {
          ...item,
          members: [...item.members, mutation.member],
          updatedAt: nowIso,
        };
      });
    case "metaProject.removeMember":
      return metaProjects.map((item) => {
        if (item.id !== mutation.metaProjectId) return item;
        return {
          ...item,
          members: item.members.filter(
            (member) =>
              !(
                member.environmentId === mutation.environmentId &&
                member.projectId === mutation.projectId
              ),
          ),
          updatedAt: nowIso,
        };
      });
    case "metaProject.linkThread":
      return metaProjects.map((item) => {
        if (item.id !== mutation.metaProjectId) return item;
        const filtered = item.threadLinks.filter(
          (link) =>
            !(
              link.environmentId === mutation.threadLink.environmentId &&
              link.threadId === mutation.threadLink.threadId
            ),
        );
        return {
          ...item,
          threadLinks: [mutation.threadLink, ...filtered],
          updatedAt: nowIso,
        };
      });
    case "metaProject.unlinkThread":
      return metaProjects.map((item) => {
        if (item.id !== mutation.metaProjectId) return item;
        return {
          ...item,
          threadLinks: item.threadLinks.filter(
            (link) =>
              !(
                link.environmentId === mutation.environmentId && link.threadId === mutation.threadId
              ),
          ),
          updatedAt: nowIso,
        };
      });
  }
}

export function createMetaProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const commandScheduler = createAtomCommandScheduler();
  const revision = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`environment-data:meta-projects:revision:${environmentId}`)),
  );
  const pendingOptimistic = Atom.family((environmentId: EnvironmentId) =>
    Atom.make<ReadonlyArray<PendingOptimisticMutation>>([]).pipe(
      Atom.withLabel(`environment-data:meta-projects:optimistic:${environmentId}`),
    ),
  );

  let nextOptimisticKey = 0;

  const bumpMetaProjects = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    Effect.sync(() => {
      registry.update(revision(environmentId), (count) => count + 1);
    });

  const rawList = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meta-projects:list",
    tag: WS_METHODS.metaProjectsList,
    staleTimeMs: 10_000,
    refreshTrigger: ({ environmentId }) => revision(environmentId),
  });

  const listAtomFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as readonly [
      EnvironmentId,
      MetaProjectListInput,
    ];
    const base = rawList({ environmentId, input });
    const pendingAtom = pendingOptimistic(environmentId);
    return Atom.make((get) => {
      const result = get(base);
      const pending = get(pendingAtom);
      if (pending.length === 0) return result;
      return AsyncResult.map(result, (data) => {
        let metaProjects: ReadonlyArray<MetaProject> = data.metaProjects;
        for (const entry of pending) {
          metaProjects = applyOptimisticMetaProjectMutation(
            metaProjects,
            entry.mutation,
            data.updatedAt ?? "1970-01-01T00:00:00.000Z",
          );
        }
        if (!input.includeArchived) {
          metaProjects = metaProjects.filter((item) => item.archivedAt == null);
        }
        return { ...data, metaProjects };
      });
    }).pipe(Atom.withLabel(`environment-data:meta-projects:list-view:${key}`));
  });

  const list = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: MetaProjectListInput;
  }): Atom.Atom<AsyncResult.AsyncResult<MetaProjectListResult, unknown>> =>
    listAtomFamily(JSON.stringify([target.environmentId, target.input]));

  const getAtomFamily = Atom.family((key: string) => {
    const [environmentId, input] = JSON.parse(key) as readonly [
      EnvironmentId,
      MetaProjectGetTargetInput,
    ];
    const listAtom = list({
      environmentId,
      input: input.includeArchived === undefined ? {} : { includeArchived: input.includeArchived },
    });
    return Atom.make((get) =>
      AsyncResult.map(
        get(listAtom),
        (data) => data.metaProjects.find((item) => item.id === input.metaProjectId) ?? null,
      ),
    ).pipe(Atom.withLabel(`environment-data:meta-projects:get:${key}`));
  });

  const get = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: MetaProjectGetTargetInput;
  }): Atom.Atom<AsyncResult.AsyncResult<MetaProject | null, unknown>> =>
    getAtomFamily(JSON.stringify([target.environmentId, target.input]));

  const tree = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meta-projects:tree",
    tag: WS_METHODS.metaProjectsGetTree,
    staleTimeMs: 10_000,
    refreshTrigger: ({ environmentId }) => revision(environmentId),
  });

  const context = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meta-projects:context",
    tag: WS_METHODS.metaProjectsGetContext,
    staleTimeMs: 10_000,
    refreshTrigger: ({ environmentId }) => revision(environmentId),
  });

  const rollup = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:meta-projects:rollup",
    tag: WS_METHODS.metaProjectsGetRollup,
    staleTimeMs: 10_000,
    refreshTrigger: ({ environmentId }) => revision(environmentId),
  });

  const mutate = createEnvironmentRpcCommand(runtime, {
    label: "environment-command:meta-projects:mutate",
    tag: WS_METHODS.metaProjectsMutate,
    scheduler: commandScheduler,
    concurrency: {
      mode: "serial",
      key: ({ environmentId }) => environmentId,
    },
    onStart: ({ environmentId, input }, registry) => {
      nextOptimisticKey += 1;
      const key = nextOptimisticKey;
      registry.update(pendingOptimistic(environmentId), (items) => [
        ...items,
        { key, mutation: input },
      ]);
      return key;
    },
    onSuccess: ({ environmentId }, registry) => bumpMetaProjects(registry, environmentId),
    onSettled: ({ environmentId }, registry) =>
      Effect.sync(() => {
        registry.update(pendingOptimistic(environmentId), (items) => items.slice(1));
      }),
  });

  const createCommand = <Input, Result extends MetaProjectMutationResult>(
    label: string,
    toMutation: (input: Input) => EnvironmentRpcInput<typeof WS_METHODS.metaProjectsMutate>,
  ) => ({
    label,
    requiredScopes: mutate.requiredScopes,
    permissionAtom: mutate.permissionAtom,
    run: (
      registry: AtomRegistry.AtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: Input },
    ) =>
      mutate
        .run(registry, {
          environmentId: target.environmentId,
          input: toMutation(target.input),
        })
        .pipe(Effect.map((value) => value as Result)),
  });

  return {
    list,
    get,
    tree,
    context,
    rollup,
    mutate,
    create: createCommand<
      MetaProjectCreateInput & { readonly commandId?: CommandId | undefined },
      MetaProjectCreateResult
    >("environment-command:meta-projects:create", (input) => ({
      type: "metaProject.create",
      ...input,
    })),
    update: createCommand<MetaProjectUpdateInput, MetaProjectUpdateResult>(
      "environment-command:meta-projects:update",
      (input) => ({
        type: "metaProject.update",
        ...input,
      }),
    ),
    delete: createCommand<MetaProjectDeleteInput, MetaProjectDeleteResult>(
      "environment-command:meta-projects:delete",
      (input) => ({
        type: "metaProject.delete",
        ...input,
      }),
    ),
    addMember: createCommand<MetaProjectAddMemberInput, MetaProjectAddMemberResult>(
      "environment-command:meta-projects:add-member",
      (input) => ({
        type: "metaProject.addMember",
        ...input,
      }),
    ),
    removeMember: createCommand<MetaProjectRemoveMemberInput, MetaProjectRemoveMemberResult>(
      "environment-command:meta-projects:remove-member",
      (input) => ({
        type: "metaProject.removeMember",
        ...input,
      }),
    ),
    linkThread: createCommand<MetaProjectLinkThreadInput, MetaProjectLinkThreadResult>(
      "environment-command:meta-projects:link-thread",
      (input) => ({
        type: "metaProject.linkThread",
        ...input,
      }),
    ),
    unlinkThread: createCommand<MetaProjectUnlinkThreadInput, MetaProjectUnlinkThreadResult>(
      "environment-command:meta-projects:unlink-thread",
      (input) => ({
        type: "metaProject.unlinkThread",
        ...input,
      }),
    ),
  };
}
