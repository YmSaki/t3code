import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const KanbanColumn = Schema.Literals(["backlog", "todo", "in_progress", "review", "done"]);
export type KanbanColumn = typeof KanbanColumn.Type;

export const KanbanCard = Schema.Struct({
  cardId: TrimmedNonEmptyString,
  sourceId: TrimmedNonEmptyString,
  kind: Schema.Literals(["issue", "task"]),
  title: TrimmedNonEmptyString,
  status: TrimmedNonEmptyString,
  column: KanbanColumn,
});
export type KanbanCard = typeof KanbanCard.Type;

export const KanbanListBoardInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId }),
  Schema.Struct({ workspaceRoot: TrimmedNonEmptyString }),
]);
export type KanbanListBoardInput = typeof KanbanListBoardInput.Type;

const moveFields = {
  cardId: TrimmedNonEmptyString,
  targetColumn: KanbanColumn,
};
export const KanbanMoveCardInput = Schema.Union([
  Schema.Struct({ projectId: ProjectId, ...moveFields }),
  Schema.Struct({ workspaceRoot: TrimmedNonEmptyString, ...moveFields }),
]);
export type KanbanMoveCardInput = typeof KanbanMoveCardInput.Type;

export const KanbanBoard = Schema.Struct({
  workspaceRoot: TrimmedNonEmptyString,
  columns: Schema.Array(Schema.Struct({ column: KanbanColumn, cards: Schema.Array(KanbanCard) })),
});

export class GithiveKanbanError extends Schema.TaggedError<GithiveKanbanError>()(
  "GithiveKanbanError",
  {
    operation: Schema.Literals(["resolve", "list", "move"]),
    reason: Schema.Literals([
      "project_not_found",
      "command_failed",
      "invalid_output",
      "card_not_found",
      "invalid_transition",
      "not_applied",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Githive kanban ${this.operation} failed (${this.reason}).`;
  }
}
