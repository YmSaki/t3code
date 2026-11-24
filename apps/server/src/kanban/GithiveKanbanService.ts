import {
  GithiveKanbanError,
  type KanbanListBoardInput,
  type KanbanMoveCardInput,
} from "@t3tools/contracts";
import {
  parseGithiveCards,
  groupKanbanCards,
  kanbanTransitionStatus,
  isGithiveMoveApplied,
} from "@t3tools/shared/githiveKanban.core";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";

export class GithiveKanbanService extends Context.Service<
  GithiveKanbanService,
  {
    readonly listBoard: (input: KanbanListBoardInput) => Effect.Effect<
      {
        readonly workspaceRoot: string;
        readonly columns: ReturnType<typeof groupKanbanCards>;
      },
      GithiveKanbanError
    >;
    readonly moveCard: (
      input: KanbanMoveCardInput,
    ) => Effect.Effect<ReturnType<typeof parseGithiveCards>[number], GithiveKanbanError>;
  }
>()("t3/kanban/GithiveKanbanService") {}

const make = Effect.gen(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const projects = yield* ProjectService.ProjectService;
  const resolve = Effect.fn("GithiveKanbanService.resolve")(function* (
    input: KanbanListBoardInput,
  ) {
    if ("workspaceRoot" in input) return input.workspaceRoot;
    const project = yield* projects
      .getById(input.projectId)
      .pipe(
        Effect.mapError(
          (cause) =>
            new GithiveKanbanError({ operation: "resolve", reason: "command_failed", cause }),
        ),
      );
    if (Option.isNone(project))
      return yield* new GithiveKanbanError({ operation: "resolve", reason: "project_not_found" });
    return project.value.workspaceRoot;
  });
  const run = Effect.fn("GithiveKanbanService.run")(function* (
    cwd: string,
    args: ReadonlyArray<string>,
    operation: "list" | "move",
  ) {
    const output = yield* runner
      .run({
        command: "githive",
        args: [...args, "--json"],
        cwd,
        timeout: "15 seconds",
        maxOutputBytes: 8 * 1024 * 1024,
      })
      .pipe(
        Effect.mapError(
          (cause) => new GithiveKanbanError({ operation, reason: "command_failed", cause }),
        ),
      );
    if (
      output.code !== 0 ||
      output.timedOut ||
      output.stdoutTruncated ||
      output.stdoutInvalidUtf8
    ) {
      return yield* new GithiveKanbanError({ operation, reason: "command_failed" });
    }
    return output.stdout;
  });
  const readCards = Effect.fn("GithiveKanbanService.readCards")(function* (workspaceRoot: string) {
    const cards = [];
    for (const kind of ["issue", "task"] as const) {
      const json = yield* run(workspaceRoot, [kind, "list"], "list");
      cards.push(
        ...(yield* Effect.try({
          try: () => parseGithiveCards(json, kind),
          catch: (cause) =>
            new GithiveKanbanError({ operation: "list", reason: "invalid_output", cause }),
        })),
      );
    }
    return cards;
  });
  return GithiveKanbanService.of({
    listBoard: Effect.fn("GithiveKanbanService.listBoard")(function* (input) {
      const workspaceRoot = yield* resolve(input);
      return { workspaceRoot, columns: groupKanbanCards(yield* readCards(workspaceRoot)) };
    }),
    moveCard: Effect.fn("GithiveKanbanService.moveCard")(function* (input) {
      const workspaceRoot = yield* resolve(input);
      const cards = yield* readCards(workspaceRoot);
      const card = cards.find((candidate) => candidate.cardId === input.cardId);
      if (card === undefined)
        return yield* new GithiveKanbanError({ operation: "move", reason: "card_not_found" });
      const status = kanbanTransitionStatus(card, input.targetColumn);
      if (status === null)
        return yield* new GithiveKanbanError({ operation: "move", reason: "invalid_transition" });
      if (status === card.status) return card;
      const json = yield* run(
        workspaceRoot,
        [card.kind, "status", card.sourceId, status, "--no-sync"],
        "move",
      );
      const applied = yield* Effect.try({
        try: () => isGithiveMoveApplied(json),
        catch: (cause) =>
          new GithiveKanbanError({ operation: "move", reason: "invalid_output", cause }),
      });
      if (!applied)
        return yield* new GithiveKanbanError({ operation: "move", reason: "not_applied" });
      const updated = (yield* readCards(workspaceRoot)).find(
        (candidate) => candidate.cardId === input.cardId,
      );
      if (updated?.status !== status)
        return yield* new GithiveKanbanError({ operation: "move", reason: "not_applied" });
      return updated;
    }),
  });
});

export const layer = Layer.effect(GithiveKanbanService, make);
