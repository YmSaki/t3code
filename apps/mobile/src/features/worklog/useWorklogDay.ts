import {
  buildWorklogWindowRange,
  mergeEnvironmentWorklogs,
} from "@t3tools/client-runtime/state/worklog";

import { useConnectedEnvironmentIds } from "../../state/environments";
import { useWorklogWindow } from "../../state/worklog";

const deviceTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/** One local day of agent work across every connected machine, merged on this device. */
export function useWorklogDay(anchorMs: number) {
  const timeZone = deviceTimeZone();
  const range = buildWorklogWindowRange({ anchorMs, viewMode: "day", timeZone });
  const window = useWorklogWindow({
    environmentIds: useConnectedEnvironmentIds(),
    sinceIso: range.sinceIso,
    untilIso: range.untilIso,
    timeZone,
  });
  const view = mergeEnvironmentWorklogs({
    entriesByEnvironment: window.entriesByEnvironment,
    mode: "merged",
    timeZone,
    since: range.sinceIso,
    until: range.untilIso,
  });
  const day = range.days[0]!;
  return {
    day,
    pending: window.pending,
    failedEnvironmentIds: window.failedEnvironmentIds,
    refresh: window.refresh,
    view,
    summary: view.dailySummaries.find((summary) => summary.dayKey === day.dayKey) ?? null,
    layout: view.dayLayouts[day.dayKey] ?? [],
  };
}
