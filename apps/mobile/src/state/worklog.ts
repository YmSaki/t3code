import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { createWorklogEnvironmentAtoms } from "@t3tools/client-runtime/state/worklog";
import type { AgentWorklogEntry, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const worklogEnvironment = createWorklogEnvironmentAtoms(connectionAtomRuntime);

export interface WorklogWindowQuery {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly sinceIso: string;
  readonly untilIso: string;
  readonly timeZone: string;
}

export interface WorklogWindowEntries {
  readonly entriesByEnvironment: ReadonlyArray<ReadonlyArray<AgentWorklogEntry>>;
  readonly pending: boolean;
  readonly failedEnvironmentIds: ReadonlyArray<EnvironmentId>;
}

// Each machine answers for itself; the client merges them, so peers are not asked twice.
const worklogWindows = Atom.family((key: string) => {
  const query = JSON.parse(key) as WorklogWindowQuery;
  const machineQuery = (environmentId: EnvironmentId) =>
    worklogEnvironment.query({
      environmentId,
      input: {
        filter: { since: query.sinceIso, until: query.untilIso },
        mode: "merged",
        timeZone: query.timeZone,
        includePeers: false,
      },
    });
  return Atom.readable(
    (get): WorklogWindowEntries => {
      const results = query.environmentIds.map((environmentId) => ({
        environmentId,
        result: get(machineQuery(environmentId)),
      }));
      return {
        entriesByEnvironment: results.map(
          ({ result }) => AsyncResult.getOrElse(result, () => null)?.entries ?? [],
        ),
        pending: results.some(({ result }) => result.waiting),
        failedEnvironmentIds: results
          .filter(({ result }) => result._tag === "Failure")
          .map(({ environmentId }) => environmentId),
      };
    },
    (refresh) =>
      query.environmentIds.forEach((environmentId) => refresh(machineQuery(environmentId))),
  ).pipe(Atom.withLabel(`mobile-worklog-window:${key}`));
});

export function useWorklogWindow(query: WorklogWindowQuery) {
  const atom = worklogWindows(JSON.stringify(query));
  return { ...useAtomValue(atom), refresh: useAtomRefresh(atom) };
}
