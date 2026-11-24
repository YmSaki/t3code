import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { KanbanCard, KanbanColumn } from "@t3tools/contracts";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { useProjects } from "../../state/entities";
import { kanbanEnvironment } from "../../state/kanban";
import { useAtomCommand } from "../../state/use-atom-command";

type EnvironmentProject = ReturnType<typeof useProjects>[number];

function projectSelectionKey(project: Pick<EnvironmentProject, "environmentId" | "id">): string {
  return JSON.stringify([project.environmentId, project.id]);
}

const KANBAN_COLUMNS: ReadonlyArray<KanbanColumn> = [
  "backlog",
  "todo",
  "in_progress",
  "review",
  "done",
];

function columnLabel(gt: ReturnType<typeof useGT>, column: KanbanColumn): string {
  switch (column) {
    case "backlog":
      return gt("Backlog");
    case "todo":
      return gt("To Do");
    case "in_progress":
      return gt("In Progress");
    case "review":
      return gt("Review");
    case "done":
      return gt("Done");
  }
}

function KanbanBoardView({
  project,
  projects,
  onSelectProject,
}: {
  project: EnvironmentProject;
  projects: ReadonlyArray<EnvironmentProject>;
  onSelectProject: (projectId: string) => void;
}) {
  const gt = useGT();
  const [movingCardId, setMovingCardId] = useState<string | null>(null);
  const boardAtom = kanbanEnvironment.board({
    environmentId: project.environmentId,
    input: { projectId: project.id },
  });
  const boardResult = useAtomValue(boardAtom);
  const refreshBoard = useAtomRefresh(boardAtom);
  const moveCard = useAtomCommand(kanbanEnvironment.moveCard, {
    reportFailure: true,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-sm font-semibold text-foreground">{gt("Kanban Board")}</h1>
          <select
            aria-label={gt("Select project")}
            className="rounded-md border border-border bg-background px-2.5 py-1 text-xs text-foreground"
            value={projectSelectionKey(project)}
            onChange={(event) => onSelectProject(event.target.value)}
          >
            {projects.map((item) => {
              const key = projectSelectionKey(item);
              return (
                <option key={key} value={key}>
                  {item.title}
                </option>
              );
            })}
          </select>
        </div>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => refreshBoard()}
        >
          <RefreshCwIcon className="size-3.5" />
          {gt("Refresh")}
        </button>
      </header>

      <div className="flex-1 overflow-x-auto p-4">
        {AsyncResult.isInitial(boardResult) ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {gt("Loading Kanban board...")}
          </div>
        ) : AsyncResult.isFailure(boardResult) ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {gt("Failed to load Kanban board:")} {String(boardResult.cause)}
          </div>
        ) : (
          <div className="grid h-full min-w-[900px] grid-cols-5 gap-3">
            {(() => {
              const columnsByKey = new Map(
                boardResult.value.columns.map((col) => [col.column, col.cards]),
              );
              return KANBAN_COLUMNS.map((column) => {
                const cards: ReadonlyArray<KanbanCard> = columnsByKey.get(column) ?? [];
                return (
                  <section
                    key={column}
                    className="flex flex-col rounded-lg border border-border bg-muted/30 p-2.5"
                  >
                    <div className="mb-2 flex items-center justify-between px-1">
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {columnLabel(gt, column)}
                      </h2>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-2xs font-medium text-muted-foreground">
                        {cards.length}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
                      {cards.length === 0 ? (
                        <div className="rounded-md border border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground">
                          {gt("No cards")}
                        </div>
                      ) : (
                        cards.map((card) => (
                          <article
                            key={card.cardId}
                            className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 shadow-xs"
                          >
                            <div className="flex items-start justify-between gap-2">
                              <span className="text-xs font-medium text-foreground">
                                {card.title}
                              </span>
                            </div>
                            <div className="flex items-center justify-between gap-2 text-2xs text-muted-foreground">
                              <span className="truncate">
                                {card.kind} · {card.sourceId}
                              </span>
                              <select
                                aria-label={gt("Move card")}
                                className="rounded border border-border bg-background px-1.5 py-0.5 text-2xs text-foreground"
                                value={card.column}
                                disabled={movingCardId === card.cardId}
                                onChange={(event) => {
                                  const targetColumn = event.target.value as KanbanColumn;
                                  if (targetColumn !== card.column) {
                                    setMovingCardId(card.cardId);
                                    void moveCard({
                                      environmentId: project.environmentId,
                                      input: {
                                        projectId: project.id,
                                        cardId: card.cardId,
                                        targetColumn,
                                      },
                                    }).finally(() => {
                                      setMovingCardId((current) =>
                                        current === card.cardId ? null : current,
                                      );
                                    });
                                  }
                                }}
                              >
                                {KANBAN_COLUMNS.map((target) => (
                                  <option key={target} value={target}>
                                    {columnLabel(gt, target)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </article>
                        ))
                      )}
                    </div>
                  </section>
                );
              });
            })()}
          </div>
        )}
      </div>
    </div>
  );
}

export function KanbanBoardPanel() {
  const gt = useGT();
  const projects = useProjects();
  const [selectedProjectKey, setSelectedProjectKey] = useState<string | null>(null);

  const activeProject =
    projects.find((project) => projectSelectionKey(project) === selectedProjectKey) ??
    projects[0] ??
    null;

  if (!activeProject) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {gt("No projects available for Kanban board.")}
      </div>
    );
  }

  return (
    <KanbanBoardView
      project={activeProject}
      projects={projects}
      onSelectProject={setSelectedProjectKey}
    />
  );
}
