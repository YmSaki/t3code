import { createFileRoute } from "@tanstack/react-router";

import { KanbanBoardPanel } from "../components/kanban/KanbanBoardPanel";

export const Route = createFileRoute("/_chat/kanban")({
  component: KanbanBoardPanel,
});
