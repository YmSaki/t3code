import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createWorklogEnvironmentAtoms,
  mergeEnvironmentWorklogs,
  type MergedWorklogViewModel,
} from "@t3tools/client-runtime/state/worklog";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AgentWorklogEntry,
  type EnvironmentId,
  type IcalFeedId,
  type WorklogFilter,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { msg } from "gt-react";

import { connectionAtomRuntime } from "../connection/runtime";
import { m } from "../i18n/messages";
import { useEnvironmentHttpBaseUrl } from "./environments";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { environmentSession, sessionHasScope, useEnvironmentScope } from "./session";
import { useAtomCommand } from "./use-atom-command";

export const worklogEnvironment = createWorklogEnvironmentAtoms(connectionAtomRuntime);

export interface EnvironmentWorklogStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isConnected: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly entries: ReadonlyArray<AgentWorklogEntry>;
}

interface MultiEnvironmentWorklogAtomKey {
  readonly since: string;
  readonly until: string;
  readonly timeZone: string;
}

const worklogByWindowAtom = Atom.family((windowKey: string) =>
  Atom.make((get): ReadonlyArray<EnvironmentWorklogStatus> => {
    const parsed = JSON.parse(windowKey) as MultiEnvironmentWorklogAtomKey;
    const presentations = get(environmentPresentations.presentationsAtom);
    const statuses: Array<EnvironmentWorklogStatus> = [];

    for (const [environmentId, presentation] of presentations) {
      const isConnected = presentation.connection.phase === "connected";
      const sessionResult = get(environmentSession.sessionStateAtom(environmentId));
      const canRead = sessionHasScope(sessionResult, AuthOrchestrationReadScope);

      if (!isConnected || !canRead) {
        statuses.push({
          environmentId,
          label: presentation.entry.target.label,
          isConnected,
          isPending: false,
          error: null,
          entries: [],
        });
        continue;
      }

      const result = get(
        worklogEnvironment.query({
          environmentId,
          input: {
            filter: {
              since: parsed.since,
              until: parsed.until,
            },
            mode: "raw",
            timeZone: parsed.timeZone,
            includePeers: false,
          },
        }),
      );

      const data = AsyncResult.getOrElse(result, () => null);
      statuses.push({
        environmentId,
        label: presentation.entry.target.label,
        isConnected,
        isPending: result.waiting,
        error:
          result._tag === "Failure" ? m(msg("Failed to load worklog from environment.")) : null,
        entries: data?.entries ?? [],
      });
    }

    return statuses;
  }).pipe(Atom.withLabel(`web-worklog:window:${windowKey}`)),
);

export interface MultiEnvironmentWorklogState {
  readonly environmentStatuses: ReadonlyArray<EnvironmentWorklogStatus>;
  readonly merged: MergedWorklogViewModel;
  readonly isPending: boolean;
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useMultiEnvironmentWorklog(params: {
  readonly since: string;
  readonly until: string;
  readonly timeZone: string;
  readonly mode: "raw" | "merged";
  readonly gapToleranceMinutes: number | null;
  readonly filter?: WorklogFilter | undefined;
}): MultiEnvironmentWorklogState {
  const windowKey = JSON.stringify({
    since: params.since,
    until: params.until,
    timeZone: params.timeZone,
  });
  const atom = worklogByWindowAtom(windowKey);
  const environmentStatuses = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);

  const selectedEnvIds =
    params.filter?.environmentIds !== undefined && params.filter.environmentIds.length > 0
      ? new Set<string>(params.filter.environmentIds)
      : null;

  const activeStatuses =
    selectedEnvIds === null
      ? environmentStatuses
      : environmentStatuses.filter((status) => selectedEnvIds.has(status.environmentId));

  const merged = mergeEnvironmentWorklogs({
    entriesByEnvironment: activeStatuses.map((status) => status.entries),
    mode: params.mode,
    gapToleranceMinutes: params.gapToleranceMinutes,
    timeZone: params.timeZone,
    filter: params.filter,
    since: params.since,
    until: params.until,
  });

  const pendingCount = activeStatuses.filter((status) => status.isPending).length;
  const loadedCount = activeStatuses.filter(
    (status) => status.isConnected && !status.isPending && status.error === null,
  ).length;

  return {
    environmentStatuses,
    merged,
    isPending: pendingCount > 0 && loadedCount === 0,
    isPartial: pendingCount > 0 && loadedCount > 0,
    refresh,
  };
}

export function useWorklogIcalFeeds(environmentId: EnvironmentId | null) {
  const feedsQuery = useEnvironmentQuery(
    environmentId !== null
      ? worklogEnvironment.listIcalFeeds({
          environmentId,
          input: { includeRevoked: false },
        })
      : null,
  );
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);

  const backfill = useAtomCommand(worklogEnvironment.backfill);
  const createIcalFeed = useAtomCommand(worklogEnvironment.createIcalFeed);
  const rotateIcalFeedToken = useAtomCommand(worklogEnvironment.rotateIcalFeedToken);
  const deleteIcalFeed = useAtomCommand(worklogEnvironment.deleteIcalFeed);

  return {
    feeds: feedsQuery.data?.feeds ?? [],
    isPending: feedsQuery.isPending,
    error: feedsQuery.error,
    refreshFeeds: feedsQuery.refresh,
    httpBaseUrl,
    canManage,
    backfill: (envId: EnvironmentId) =>
      backfill({ environmentId: envId, input: { environmentId: envId } }),
    createFeed: (
      envId: EnvironmentId,
      input: {
        readonly name: string;
        readonly timeZone?: string;
        readonly gapToleranceMinutes?: number;
        readonly filter?: WorklogFilter;
        readonly includeStatsInDescription?: boolean;
        readonly includeThreadUrl?: boolean;
      },
    ) => createIcalFeed({ environmentId: envId, input }),
    rotateToken: (envId: EnvironmentId, feedId: IcalFeedId) =>
      rotateIcalFeedToken({ environmentId: envId, input: { feedId } }),
    deleteFeed: (envId: EnvironmentId, feedId: IcalFeedId) =>
      deleteIcalFeed({ environmentId: envId, input: { feedId } }),
  };
}

export function buildIcalSubscriptionUrl(httpBaseUrl: string | null, rawToken: string): string {
  const cleanToken = rawToken.trim();
  const path = `/api/worklog/ical/${encodeURIComponent(cleanToken)}.ics`;
  if (!httpBaseUrl) return path;
  const trimmedBase = httpBaseUrl.replace(/\/+$/, "");
  return `${trimmedBase}${path}`;
}
