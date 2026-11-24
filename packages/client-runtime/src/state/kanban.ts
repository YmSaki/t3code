import { WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

/**
 * Create environment-scoped Effect reactivity atoms for the githive-backed workspace kanban board.
 */
export function createKanbanEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const board = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:kanban:board",
    tag: WS_METHODS.kanbanListBoard,
    staleTimeMs: 5_000,
  });

  const moveCard = createEnvironmentRpcCommand(runtime, {
    label: "environment-data:kanban:move-card",
    tag: WS_METHODS.kanbanMoveCard,
    onSettled: ({ environmentId, input }, registry) =>
      Effect.sync(() => {
        const boardInput =
          "projectId" in input
            ? { projectId: input.projectId }
            : { workspaceRoot: input.workspaceRoot };
        registry.refresh(board({ environmentId, input: boardInput }));
      }),
  });

  return {
    board,
    moveCard,
  };
}
