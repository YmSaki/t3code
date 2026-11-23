import { expect, it } from "@effect/vitest";
import { EnvironmentId, MetaProjectId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as MetaProjectStore from "./MetaProjectStore.ts";

const testLayer = MetaProjectStore.layer.pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);

const mpId = (id: string) => MetaProjectId.make(id);
const envId = (id: string) => EnvironmentId.make(id);
const projId = (id: string) => ProjectId.make(id);
const thId = (id: string) => ThreadId.make(id);

it.effect("performs MetaProject CRUD, member management, and thread linking in SQLite", () =>
  Effect.gen(function* () {
    const store = yield* MetaProjectStore.MetaProjectStore;

    const created = yield* store.create({
      id: mpId("mp-alpha"),
      title: "Alpha System",
      description: "Core services",
      instructionsMd: "# Rules\nKeep core pure.",
      members: [
        {
          environmentId: envId("env-local"),
          projectId: projId("proj-web"),
          role: "frontend",
          label: "Web Frontend",
          sortOrder: 0,
        },
      ],
      threadLinks: [
        {
          environmentId: envId("env-local"),
          threadId: thId("th-pm-1"),
          role: "pm",
          projectId: projId("proj-web"),
          title: "PM Coordinator",
        },
      ],
    });

    expect(created.id).toBe("mp-alpha");
    expect(created.title).toBe("Alpha System");
    expect(created.members).toHaveLength(1);
    expect(created.threadLinks).toHaveLength(1);

    const withSecondMember = yield* store.addMember({
      metaProjectId: mpId("mp-alpha"),
      member: {
        environmentId: envId("env-remote"),
        projectId: projId("proj-api"),
        role: "backend",
        sortOrder: 1,
      },
    });
    expect(withSecondMember.members.map((m) => m.projectId)).toEqual(["proj-web", "proj-api"]);

    const duplicateExit = yield* Effect.exit(
      store.addMember({
        metaProjectId: mpId("mp-alpha"),
        member: {
          environmentId: envId("env-remote"),
          projectId: projId("proj-api"),
          role: "infra",
        },
      }),
    );
    expect(duplicateExit._tag).toBe("Failure");

    const updatedMember = yield* store.updateMember({
      metaProjectId: mpId("mp-alpha"),
      member: {
        environmentId: envId("env-remote"),
        projectId: projId("proj-api"),
        role: "infra",
        label: "API & Infra",
        sortOrder: 1,
      },
    });
    expect(updatedMember.members[1]?.role).toBe("infra");
    expect(updatedMember.members[1]?.label).toBe("API & Infra");

    const withCrossThread = yield* store.linkThread({
      metaProjectId: mpId("mp-alpha"),
      threadLink: {
        environmentId: envId("env-remote"),
        threadId: thId("th-cross-1"),
        role: "cross_cutting",
        title: "Schema Sync",
      },
    });
    expect(withCrossThread.threadLinks).toHaveLength(2);

    const matchingByMember = yield* store.findByMemberProject({
      environmentId: envId("env-remote"),
      projectId: projId("proj-api"),
    });
    expect(matchingByMember.map((m) => m.id)).toEqual(["mp-alpha"]);

    const afterRemoveMember = yield* store.removeMember({
      metaProjectId: mpId("mp-alpha"),
      environmentId: envId("env-local"),
      projectId: projId("proj-web"),
    });
    expect(afterRemoveMember.removed).toBe(true);
    expect(afterRemoveMember.metaProject.members).toHaveLength(1);

    const afterUnlink = yield* store.unlinkThread({
      metaProjectId: mpId("mp-alpha"),
      environmentId: envId("env-local"),
      threadId: thId("th-pm-1"),
    });
    expect(afterUnlink.unlinked).toBe(true);
    expect(afterUnlink.metaProject.threadLinks).toHaveLength(1);

    const updatedMeta = yield* store.update({
      metaProjectId: mpId("mp-alpha"),
      title: "Alpha System V2",
      pinned: true,
      archived: true,
    });
    expect(updatedMeta.title).toBe("Alpha System V2");
    expect(updatedMeta.pinnedAt).not.toBeNull();
    expect(updatedMeta.archivedAt).not.toBeNull();

    expect(yield* store.list({ includeArchived: false })).toHaveLength(0);
    expect(yield* store.list({ includeArchived: true })).toHaveLength(1);

    const deleted = yield* store.delete(mpId("mp-alpha"));
    expect(deleted).toBe(true);
    expect(Option.isNone(yield* store.get(mpId("mp-alpha")))).toBe(true);
    expect(Option.isSome(yield* store.get(mpId("mp-alpha"), { includeDeleted: true }))).toBe(true);
  }).pipe(Effect.provide(testLayer)),
);
