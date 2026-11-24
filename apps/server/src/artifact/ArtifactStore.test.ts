import { expect, it } from "@effect/vitest";
import {
  ArtifactArchivedError,
  ArtifactId,
  ArtifactNotFoundError,
  ArtifactStateConflictError,
  ArtifactVersionNotFoundError,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import migration108 from "../persistence/Migrations/108_Artifacts.ts";
import * as ArtifactStore from "./ArtifactStore.ts";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const artifactId = ArtifactId.make("artifact-1");
const isArtifactStateConflictError = Schema.is(ArtifactStateConflictError);

const testLayer = it.layer(
  ArtifactStore.layer.pipe(
    Layer.provideMerge(
      Layer.effectDiscard(migration108).pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);

testLayer("ArtifactStore", (it) => {
  it.effect("creates, revises, lists versions, switches versions, and archives artifacts", () =>
    Effect.gen(function* () {
      const store = yield* ArtifactStore.ArtifactStore;

      const created = yield* store.create({
        id: artifactId,
        environmentId,
        projectId,
        threadId,
        kind: "markdown",
        title: "Release Checklist",
        content: "- [ ] step 1",
        initialState: { filter: "open" },
      });
      expect(created.artifact.currentVersion).toBe(1);
      expect(created.artifact.stateVersion).toBe(0);
      expect(created.artifact.state).toEqual({ filter: "open" });
      expect(created.version.content).toBe("- [ ] step 1");

      const revised = yield* store.revise({
        artifactId,
        content: "- [x] step 1\n- [ ] step 2",
        author: "user",
        summary: "Checked step 1",
      });
      expect(revised.artifact.currentVersion).toBe(2);
      expect(revised.version.version).toBe(2);
      expect(revised.version.author).toBe("user");
      expect(revised.version.summary).toBe("Checked step 1");

      const versions = yield* store.listVersions(artifactId);
      expect(versions.map((v) => v.version)).toEqual([2, 1]);

      const switched = yield* store.switchVersion({ artifactId, version: 1 });
      expect(switched.artifact.currentVersion).toBe(1);
      expect(switched.version.content).toBe("- [ ] step 1");

      const missingVersion = yield* store
        .switchVersion({ artifactId, version: 99 })
        .pipe(Effect.flip);
      expect(missingVersion).toBeInstanceOf(ArtifactVersionNotFoundError);

      const archived = yield* store.setArchived({ artifactId, archived: true });
      expect(archived.archivedAt).not.toBeNull();

      const activeList = yield* store.listByThread({ threadId });
      expect(activeList).toHaveLength(0);

      const allList = yield* store.listByThread({ threadId, includeArchived: true });
      expect(allList).toHaveLength(1);

      const reviseWhileArchived = yield* store
        .revise({ artifactId, content: "blocked" })
        .pipe(Effect.flip);
      expect(reviseWhileArchived).toBeInstanceOf(ArtifactArchivedError);

      const unarchived = yield* store.setArchived({ artifactId, archived: false });
      expect(unarchived.archivedAt).toBeNull();

      const conflict = yield* store
        .revise({
          artifactId,
          content: "stale revision",
          expectedVersion: 2,
        })
        .pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(ArtifactStateConflictError);
      if (isArtifactStateConflictError(conflict)) {
        expect(conflict.expectedVersion).toBe(2);
        expect(conflict.actualVersion).toBe(1);
      }

      const revisedWithExpected = yield* store.revise({
        artifactId,
        content: "checked revision",
        expectedVersion: 1,
      });
      expect(revisedWithExpected.artifact.currentVersion).toBe(3);
    }),
  );

  it.effect("enforces optimistic concurrency on state_version and records user actions", () =>
    Effect.gen(function* () {
      const store = yield* ArtifactStore.ArtifactStore;
      const id = ArtifactId.make("artifact-optimistic");

      yield* store.create({
        id,
        environmentId,
        projectId,
        threadId,
        kind: "html",
        title: "Interactive Chart",
        content: "<div>chart</div>",
        initialState: { tab: "day" },
      });

      const v1 = yield* store.updateStateOptimistic({
        artifactId: id,
        expectedVersion: 0,
        nextState: { tab: "week", zoom: 2 },
      });
      expect(v1.stateVersion).toBe(1);
      expect(v1.state).toEqual({ tab: "week", zoom: 2 });

      const conflict = yield* store
        .updateStateOptimistic({
          artifactId: id,
          expectedVersion: 0,
          nextState: { tab: "month" },
        })
        .pipe(Effect.flip);
      expect(conflict).toBeInstanceOf(ArtifactStateConflictError);
      if (isArtifactStateConflictError(conflict)) {
        expect(conflict.expectedVersion).toBe(0);
        expect(conflict.actualVersion).toBe(1);
      }

      const missing = yield* store
        .updateStateOptimistic({
          artifactId: ArtifactId.make("artifact-unknown"),
          expectedVersion: 0,
          nextState: {},
        })
        .pipe(Effect.flip);
      expect(missing).toBeInstanceOf(ArtifactNotFoundError);

      const action = yield* store.recordAction({
        id: "action-1",
        artifactId: id,
        threadId,
        action: {
          actionName: "apply_filter",
          payload: { range: "7d" },
          promptText: "Update summary for 7d",
        },
        stateVersion: v1.stateVersion,
      });
      expect(action.actionName).toBe("apply_filter");

      const actions = yield* store.listActions(id);
      expect(actions).toHaveLength(1);
      expect(actions[0]?.payload).toEqual({ range: "7d" });
    }),
  );
});
