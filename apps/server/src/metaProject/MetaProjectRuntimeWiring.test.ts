import { expect, it } from "@effect/vitest";
import {
  AuthMcpClientAccess,
  EnvironmentId,
  OrchestratorMcpFailure,
  type PeerLink,
  ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as MetaProjectRuntimeWiring from "./MetaProjectRuntimeWiring.ts";
import * as MetaProjectService from "./MetaProjectService.ts";

const envWorker = EnvironmentId.make("env-worker");
const envDown = EnvironmentId.make("env-down");
const envUnknown = EnvironmentId.make("env-unknown");
const projApi = ProjectId.make("proj-api");

const linkFor = (environmentId: EnvironmentId, label: string): PeerLink => {
  const epoch = DateTime.makeUnsafe("2026-11-22T00:00:00.000Z");
  return {
    environmentId,
    label,
    urls: ["https://worker.tailnet.ts.net"],
    access: AuthMcpClientAccess.make("full-access"),
    linkedAt: epoch,
    expiresAt: DateTime.add(epoch, { days: 30 }),
    lastReachedAt: epoch,
    lastError: null,
  };
};

const thread = (threadId: string, projectId: string, status: string, settled = false) => ({
  threadId,
  projectId,
  title: `Thread ${threadId}`,
  status,
  settled,
  updatedAt: "2026-11-22T10:00:00.000Z",
  itemCount: 4,
});

it("maps peer thread statuses onto rollup statuses", () => {
  expect(MetaProjectRuntimeWiring.toRollupThreadStatus("running", false)).toBe("running");
  expect(MetaProjectRuntimeWiring.toRollupThreadStatus("queued", false)).toBe("running");
  expect(MetaProjectRuntimeWiring.toRollupThreadStatus("waiting", false)).toBe("waiting_input");
  expect(MetaProjectRuntimeWiring.toRollupThreadStatus("failed", false)).toBe("error");
  expect(MetaProjectRuntimeWiring.toRollupThreadStatus("completed", false)).toBe("idle");
  expect(MetaProjectRuntimeWiring.toRollupThreadStatus("idle", true)).toBe("settled");
});

it.effect("fetches a linked peer's projects and threads, paging, and marks failures offline", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly environmentId: string; readonly tool: string; cursor: unknown }> =
      [];
    const pages: Record<string, ReadonlyArray<unknown>> = {
      t3_project_list: [
        {
          projects: [
            { id: "proj-api", title: "API", workspaceRoot: "/srv/api", deletedAt: null },
            { id: "proj-other", title: "Other", workspaceRoot: "/srv/other", deletedAt: null },
          ],
          nextCursor: null,
        },
      ],
      t3_thread_list: [
        { threads: [thread("th-1", "proj-api", "running")], nextCursor: 1 },
        {
          threads: [thread("th-2", "proj-api", "waiting"), thread("th-3", "proj-other", "idle")],
          nextCursor: null,
          total: 3,
        },
      ],
    };

    const layer = MetaProjectRuntimeWiring.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PeerMcpClient.PeerMcpClient)({
            call: (input) => {
              const cursor = input.arguments.cursor;
              calls.push({ environmentId: input.environmentId, tool: input.tool, cursor });
              if (input.environmentId !== envWorker) {
                return Effect.fail(
                  new OrchestratorMcpFailure({ code: "orchestration_error", message: "down" }),
                );
              }
              const page = pages[input.tool]?.[typeof cursor === "number" ? cursor : 0];
              // oxlint-disable-next-line t3code/no-inline-schema-compile -- the mock decodes with whatever schema each call passes in.
              return Schema.decodeUnknownEffect(input.success)(page).pipe(Effect.orDie);
            },
          }),
          Layer.mock(PeerLinks.PeerLinks)({
            get: (environmentId) =>
              Effect.succeed(
                environmentId === envWorker
                  ? Option.some(linkFor(envWorker, "Worker"))
                  : environmentId === envDown
                    ? Option.some(linkFor(envDown, "Sleeping Box"))
                    : Option.none(),
              ),
          }),
        ),
      ),
    );

    const dataSource = yield* MetaProjectService.MetaProjectDataSource.pipe(Effect.provide(layer));
    const fetch = dataSource.fetchRemoteEnvironmentSnapshot!;

    const snapshot = yield* fetch(envWorker, [projApi]);
    expect(snapshot?.environment).toEqual({
      environmentId: envWorker,
      label: "Worker",
      isLocal: false,
      online: true,
    });
    expect(snapshot?.physicalProjects.map((project) => project.projectId)).toEqual(["proj-api"]);
    expect(snapshot?.threads.map((t) => [t.threadId, t.isActive])).toEqual([
      ["th-1", true],
      ["th-2", true],
    ]);
    expect(snapshot?.rollupThreads?.map((t) => t.status)).toEqual(["running", "waiting_input"]);
    expect(calls.filter((call) => call.tool === "t3_thread_list").map((c) => c.cursor)).toEqual([
      0, 1,
    ]);

    const down = yield* fetch(envDown, [projApi]);
    expect(down).toEqual({
      environment: { environmentId: envDown, label: "Sleeping Box", isLocal: false, online: false },
      physicalProjects: [],
      threads: [],
    });

    expect(yield* fetch(envUnknown, [])).toBeNull();
  }),
);
