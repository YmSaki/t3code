import { expect, it } from "@effect/vitest";
import { Project, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as GithiveKanbanService from "./GithiveKanbanService.ts";

const id = "01j8xt5e6f7g8h9j0k1a2b3c4d";
const cwd = "C:/workspace";
const list = (status?: string) =>
  JSON.stringify({
    ok: true,
    data: {
      items: status === undefined ? [] : [{ id, title: "Work", status }],
      total: status === undefined ? 0 : 1,
    },
  });
const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
  stdout,
  stderr: "",
  code: code as NonNullable<ProcessRunner.ProcessRunOutput["code"]>,
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

function testLayer(
  run: ProcessRunner.ProcessRunner["Service"]["run"],
  getById: ProjectService.ProjectService["Service"]["getById"] = () => Effect.succeedNone,
) {
  return GithiveKanbanService.layer.pipe(
    Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, { run })),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById })),
  );
}

it.effect("lists both sources in the destination workspace and verifies persisted moves", () =>
  Effect.gen(function* () {
    let status = "todo";
    const calls: ProcessRunner.ProcessRunInput[] = [];
    const service = yield* GithiveKanbanService.GithiveKanbanService.pipe(
      Effect.provide(
        testLayer(
          (input) =>
            Effect.sync(() => {
              calls.push(input);
              if (input.args[1] === "status") {
                status = input.args[3]!;
                return output('{"ok":true,"data":{"applied":true}}');
              }
              return output(list(input.args[0] === "task" ? status : undefined));
            }),
          (projectId) =>
            Effect.succeedSome(
              Project.make({
                id: projectId,
                title: "Workspace",
                workspaceRoot: cwd,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-11-24T00:00:00.000Z",
                updatedAt: "2026-11-24T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
        ),
      ),
    );
    const board = yield* service.listBoard({ projectId: ProjectId.make("workspace") });
    expect(board.columns.find((column) => column.column === "todo")?.cards[0]?.cardId).toBe(
      `task:${id}`,
    );
    const moved = yield* service.moveCard({
      workspaceRoot: cwd,
      cardId: `task:${id}`,
      targetColumn: "in_progress",
    });
    expect(moved.status).toBe("doing");
    const writeCount = calls.filter((call) => call.args[1] === "status").length;
    expect(
      yield* service.moveCard({
        workspaceRoot: cwd,
        cardId: `task:${id}`,
        targetColumn: "in_progress",
      }),
    ).toEqual(moved);
    expect(calls.filter((call) => call.args[1] === "status")).toHaveLength(writeCount);
    expect(
      calls.every(
        (call) => call.cwd === cwd && call.command === "githive" && call.args.at(-1) === "--json",
      ),
    ).toBe(true);
    expect(calls.find((call) => call.args[1] === "status")?.args).toEqual([
      "task",
      "status",
      id,
      "doing",
      "--no-sync",
      "--json",
    ]);
  }),
);

it.effect("fails explicitly for missing CLI, nonzero exits and invalid JSON", () =>
  Effect.gen(function* () {
    for (const run of [
      () =>
        Effect.fail(
          new ProcessRunner.ProcessSpawnError({
            command: "githive",
            argumentCount: 3,
            cause: new Error("ENOENT"),
          }),
        ),
      () => Effect.succeed(output(list(), 2)),
      () => Effect.succeed(output("invalid JSON")),
      () => Effect.succeed(output('{"ok":false,"error":{"code":"failed"}}')),
    ]) {
      const result = yield* Effect.result(
        Effect.flatMap(GithiveKanbanService.GithiveKanbanService, (service) =>
          service.listBoard({ workspaceRoot: cwd }),
        ).pipe(Effect.provide(testLayer(run))),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure._tag).toBe("GithiveKanbanError");
    }
  }),
);

it.effect("rejects invalid transitions, missing cards and unapplied or unpersisted writes", () =>
  Effect.gen(function* () {
    for (const [targetColumn, response, expected] of [
      ["done", '{"ok":true,"data":{"applied":true}}', "invalid_transition"],
      ["in_progress", '{"ok":true,"data":{"applied":false}}', "not_applied"],
      ["in_progress", '{"ok":true,"data":{"applied":true}}', "not_applied"],
      ["in_progress", "broken", "invalid_output"],
    ] as const) {
      const layer = testLayer((input) =>
        Effect.succeed(
          output(
            input.args[1] === "status"
              ? response
              : list(input.args[0] === "task" ? "todo" : undefined),
          ),
        ),
      );
      const result = yield* Effect.result(
        Effect.flatMap(GithiveKanbanService.GithiveKanbanService, (service) =>
          service.moveCard({ workspaceRoot: cwd, cardId: `task:${id}`, targetColumn }),
        ).pipe(Effect.provide(layer)),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) expect(result.failure.reason).toBe(expected);
    }
    const result = yield* Effect.result(
      Effect.flatMap(GithiveKanbanService.GithiveKanbanService, (service) =>
        service.moveCard({ workspaceRoot: cwd, cardId: "missing", targetColumn: "todo" }),
      ).pipe(Effect.provide(testLayer(() => Effect.succeed(output(list()))))),
    );
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("card_not_found");
    else expect.fail("Missing card must fail");
  }),
);

it.effect("rejects an unknown project before invoking githive", () =>
  Effect.gen(function* () {
    const service = yield* GithiveKanbanService.GithiveKanbanService;
    const result = yield* Effect.result(
      service.listBoard({ projectId: ProjectId.make("missing") }),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.reason).toBe("project_not_found");
  }).pipe(Effect.provide(testLayer(() => Effect.die("Must not invoke CLI")))),
);
