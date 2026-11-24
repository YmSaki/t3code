import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  PmBoardWorkerSummary,
  PmWorkerPolicy,
  PmWorkerStatus,
  ThreadId,
} from "@t3tools/contracts";
import { T, useGT, useMessages, Var } from "gt-react";
import {
  AlertTriangleIcon,
  BotIcon,
  CheckCircle2Icon,
  ChevronRightIcon,
  ClockIcon,
  OctagonAlertIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  SlidersHorizontalIcon,
  SquareIcon,
} from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";
import {
  buildPmPendingInbox,
  classifyPmWorkerBucket,
  formatPmWorkerElapsed,
  groupPmWorkers,
  type PmPendingInboxItem,
  type PmWorkerBucket,
} from "~/pmBoard.logic";
import { useEnvironmentIdentities } from "~/state/environments";
import { pmBoardEnvironment, usePmBoard, usePmBoardActions } from "~/state/pmBoard";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";

export interface PmControlPanelProps {
  readonly environmentId: EnvironmentId;
  readonly pmThreadId: ThreadId;
  readonly onOpenWorkerThread?: ((worker: PmBoardWorkerSummary) => void) | undefined;
  readonly onAnswerPendingWorker?: ((item: PmPendingInboxItem) => void) | undefined;
}

const STATUS_BADGE_VARIANT: Record<
  PmWorkerStatus,
  "info" | "warning" | "success" | "error" | "secondary"
> = {
  queued: "secondary",
  running: "info",
  waiting_approval: "warning",
  waiting_input: "warning",
  completed: "success",
  failed: "error",
  interrupted: "error",
  cancelled: "secondary",
};

function statusLabel(status: PmWorkerStatus, gt: ReturnType<typeof useGT>): string {
  switch (status) {
    case "queued":
      return gt("Queued");
    case "running":
      return gt("Running");
    case "waiting_approval":
      return gt("Needs approval");
    case "waiting_input":
      return gt("Needs input");
    case "completed":
      return gt("Completed");
    case "failed":
      return gt("Failed");
    case "interrupted":
      return gt("Interrupted");
    case "cancelled":
      return gt("Cancelled");
  }
}

export function PmControlPanel(props: PmControlPanelProps) {
  const gt = useGT();
  const resolveMessage = useMessages();
  const nowIso = useNowMinute();
  const nowMs = Date.parse(nowIso);
  const environmentIdentities = useEnvironmentIdentities();
  const { board, error, isPending, refresh } = usePmBoard(props.environmentId, props.pmThreadId);
  const actions = usePmBoardActions();

  const canStopAll = useAtomValue(pmBoardEnvironment.stopAll.permissionAtom(props.environmentId));
  const canToggleKillSwitch = useAtomValue(
    pmBoardEnvironment.setKillSwitch.permissionAtom(props.environmentId),
  );
  const canUpdatePolicy = useAtomValue(
    pmBoardEnvironment.updatePolicy.permissionAtom(props.environmentId),
  );

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [maxConcurrentInput, setMaxConcurrentInput] = useState("");
  const [maxTurnsInput, setMaxTurnsInput] = useState("");
  const [requireWorktreeDraft, setRequireWorktreeDraft] = useState<boolean | null>(null);
  const [allowNestedDraft, setAllowNestedDraft] = useState<boolean | null>(null);

  const notifyFailure = (title: string, cause: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  };

  const handleStopAll = async () => {
    if (busyAction !== null) return;
    setBusyAction("stop-all");
    const result = await actions.stopAll({
      environmentId: props.environmentId,
      pmThreadId: props.pmThreadId,
      activateKillSwitch: true,
    });
    setBusyAction(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      notifyFailure(gt("Could not stop active workers"), squashAtomCommandFailure(result));
    } else if (result._tag === "Success") {
      toastManager.add({
        type: "warning",
        title: gt("PM workers stopped"),
        description: gt("Stopped {count} active workers and activated the kill switch.", {
          count: result.value.stoppedWorkerThreadIds.length,
        }),
      });
    }
  };

  const handleToggleKillSwitch = async (nextActive: boolean) => {
    if (busyAction !== null) return;
    setBusyAction("kill-switch");
    const result = nextActive
      ? await actions.setKillSwitch({
          environmentId: props.environmentId,
          scope: "thread",
          threadId: props.pmThreadId,
          active: true,
        })
      : await actions.resetKillSwitch({
          environmentId: props.environmentId,
          scope: "thread",
          threadId: props.pmThreadId,
        });
    setBusyAction(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      notifyFailure(gt("Could not update kill switch"), squashAtomCommandFailure(result));
    }
  };

  const openPolicyEditor = (policy: PmWorkerPolicy) => {
    setMaxConcurrentInput(String(policy.maxConcurrentWorkers));
    setMaxTurnsInput(String(policy.maxDelegatedTurns));
    setRequireWorktreeDraft(policy.requireWorktreeIsolation);
    setAllowNestedDraft(policy.allowNestedDelegation);
    setPolicyOpen(true);
  };

  const handleSavePolicy = async (currentPolicy: PmWorkerPolicy, metaProjectId: string | null) => {
    if (busyAction !== null) return;
    const parsedConcurrent = Number.parseInt(maxConcurrentInput, 10);
    const parsedTurns = Number.parseInt(maxTurnsInput, 10);
    const maxConcurrentWorkers =
      Number.isFinite(parsedConcurrent) && parsedConcurrent >= 1
        ? parsedConcurrent
        : currentPolicy.maxConcurrentWorkers;
    const maxDelegatedTurns =
      Number.isFinite(parsedTurns) && parsedTurns >= 1
        ? parsedTurns
        : currentPolicy.maxDelegatedTurns;

    setBusyAction("save-policy");
    const result = await actions.updatePolicy({
      environmentId: props.environmentId,
      threadId: props.pmThreadId,
      role: "pm",
      metaProjectId,
      policy: {
        ...currentPolicy,
        maxConcurrentWorkers,
        maxDelegatedTurns,
        requireWorktreeIsolation: requireWorktreeDraft ?? currentPolicy.requireWorktreeIsolation,
        allowNestedDelegation: allowNestedDraft ?? currentPolicy.allowNestedDelegation,
      },
    });
    setBusyAction(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      notifyFailure(gt("Could not save PM policy"), squashAtomCommandFailure(result));
    } else if (result._tag === "Success") {
      setPolicyOpen(false);
    }
  };

  const workers = board?.workers ?? [];
  const grouped = groupPmWorkers(workers);
  const pendingInbox = buildPmPendingInbox(workers, board?.pendingQuestions ?? []);
  const activeCount = grouped.running.length + grouped.waiting.length;

  const bucketHeading = (bucket: PmWorkerBucket, count: number): string => {
    switch (bucket) {
      case "running":
        return gt("Active ({count})", { count });
      case "waiting":
        return gt("Waiting ({count})", { count });
      case "completed":
        return gt("Completed ({count})", { count });
      case "failed":
        return gt("Stopped or failed ({count})", { count });
    }
  };

  const orderedBuckets: ReadonlyArray<{
    readonly key: PmWorkerBucket;
    readonly items: ReadonlyArray<PmBoardWorkerSummary>;
  }> = [
    { key: "waiting", items: grouped.waiting },
    { key: "running", items: grouped.running },
    { key: "completed", items: grouped.completed },
    { key: "failed", items: grouped.failed },
  ];

  const environmentLabel = (envId: EnvironmentId): string =>
    environmentIdentities.find((identity) => identity.environmentId === envId)?.label ?? envId;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <BotIcon className="size-4 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              <T>PM Control Board</T>
            </h2>
            {board !== null ? (
              <p className="truncate text-xs text-muted-foreground">
                <T>
                  <Var>{activeCount}</Var>/<Var>{board.policy.maxConcurrentWorkers}</Var> active,{" "}
                  <Var>{board.delegatedTurnCount}</Var>/<Var>{board.policy.maxDelegatedTurns}</Var>{" "}
                  turns
                </T>
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {board !== null ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canUpdatePolicy || busyAction !== null}
              onClick={() => (policyOpen ? setPolicyOpen(false) : openPolicyEditor(board.policy))}
            >
              <SlidersHorizontalIcon className="size-3.5" aria-hidden />
              <span>
                <T>Policy</T>
              </span>
            </Button>
          ) : null}
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Refresh PM board")}
            disabled={isPending}
            onClick={refresh}
          >
            <RefreshCwIcon className="size-3.5" aria-hidden />
          </Button>
          {board?.killSwitchActive ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canToggleKillSwitch || busyAction !== null}
              onClick={() => void handleToggleKillSwitch(false)}
            >
              <PlayIcon className="size-3.5" aria-hidden />
              <span>
                <T>Resume</T>
              </span>
            </Button>
          ) : (
            <Button
              size="xs"
              variant="destructive"
              disabled={!canStopAll || busyAction !== null}
              onClick={() => void handleStopAll()}
            >
              <SquareIcon className="size-3" aria-hidden />
              <span>
                <T>Stop all</T>
              </span>
            </Button>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-3 p-3">
          {error !== null ? (
            <Alert variant="error">
              <AlertTriangleIcon className="size-4" aria-hidden />
              <AlertTitle>
                <T>Could not load PM board</T>
              </AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          {board?.killSwitchActive ? (
            <Alert variant="warning">
              <OctagonAlertIcon className="size-4" aria-hidden />
              <AlertTitle>
                <T>Kill switch active</T>
              </AlertTitle>
              <AlertDescription>
                <T>
                  New worker dispatches are paused until you resume delegation for this PM thread.
                </T>
              </AlertDescription>
            </Alert>
          ) : null}

          {board !== null && policyOpen ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-foreground">
                  <T>Delegation policy</T>
                </span>
                <Badge variant="secondary" size="sm">
                  {board.policy.requireWorktreeIsolation ? gt("Worktree required") : gt("Shared")}
                </Badge>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    <T>Max concurrent workers</T>
                  </span>
                  <Input
                    type="number"
                    min={1}
                    value={maxConcurrentInput}
                    onChange={(event) => setMaxConcurrentInput(event.target.value)}
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">
                    <T>Max delegated turns</T>
                  </span>
                  <Input
                    type="number"
                    min={1}
                    value={maxTurnsInput}
                    onChange={(event) => setMaxTurnsInput(event.target.value)}
                  />
                </label>
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span>
                    <T>Require git worktree isolation</T>
                  </span>
                  <Switch
                    checked={requireWorktreeDraft ?? board.policy.requireWorktreeIsolation}
                    onCheckedChange={setRequireWorktreeDraft}
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-xs">
                  <span>
                    <T>Allow nested worker delegation</T>
                  </span>
                  <Switch
                    checked={allowNestedDraft ?? board.policy.allowNestedDelegation}
                    onCheckedChange={setAllowNestedDraft}
                  />
                </label>
              </div>
              <div className="flex justify-end gap-2">
                <Button size="xs" variant="ghost" onClick={() => setPolicyOpen(false)}>
                  <T>Cancel</T>
                </Button>
                <Button
                  size="xs"
                  disabled={busyAction !== null}
                  onClick={() => void handleSavePolicy(board.policy, board.metaProjectId)}
                >
                  <T>Save policy</T>
                </Button>
              </div>
            </div>
          ) : null}

          {pendingInbox.length > 0 ? (
            <section aria-label={gt("Pending Approval & Question Inbox")} className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  <ShieldAlertIcon className="size-3.5 text-warning" aria-hidden />
                  <h3 className="text-xs font-semibold text-foreground">
                    <T>Pending Approval &amp; Question Inbox</T>
                  </h3>
                </div>
                <Badge variant="warning" size="sm">
                  {pendingInbox.length}
                </Badge>
              </div>
              <div className="flex flex-col gap-2">
                {pendingInbox.map((item) => (
                  <div
                    key={item.workerThreadId}
                    className="flex flex-col gap-2 rounded-lg border border-warning/32 bg-warning-surface p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-medium text-foreground">{item.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {item.worker !== null
                            ? `${environmentLabel(item.worker.environmentId)}${item.worker.targetRepoRole ? ` - ${item.worker.targetRepoRole}` : ""}`
                            : item.workerThreadId}
                        </p>
                      </div>
                      <Badge variant={STATUS_BADGE_VARIANT[item.status]} size="sm">
                        {statusLabel(item.status, gt)}
                      </Badge>
                    </div>
                    {item.questions.length > 0 ? (
                      <ul className="list-disc space-y-1 pl-4 text-xs text-foreground">
                        {item.questions.map((question) => (
                          <li key={`${item.workerThreadId}:${question}`}>{question}</li>
                        ))}
                      </ul>
                    ) : null}
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {props.onAnswerPendingWorker !== undefined ? (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => props.onAnswerPendingWorker?.(item)}
                        >
                          <T>Respond</T>
                        </Button>
                      ) : null}
                      {item.worker !== null && props.onOpenWorkerThread !== undefined ? (
                        <Button
                          size="xs"
                          variant="default"
                          onClick={() => {
                            if (item.worker !== null) props.onOpenWorkerThread?.(item.worker);
                          }}
                        >
                          <T>Open worker</T>
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {board !== null && workers.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border p-6 text-center">
              <CheckCircle2Icon className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium text-foreground">
                <T>No delegated workers yet</T>
              </p>
              <p className="text-xs text-muted-foreground">
                <T>
                  Ask this PM thread to delegate work across repositories and worker threads will
                  appear here.
                </T>
              </p>
            </div>
          ) : null}

          {orderedBuckets.map(({ key, items }) => {
            if (items.length === 0) return null;
            return (
              <section key={key} className="space-y-1.5">
                <h3 className="text-xs font-semibold text-muted-foreground">
                  {bucketHeading(key, items.length)}
                </h3>
                <div className="flex flex-col gap-2">
                  {items.map((worker) => {
                    const elapsed = formatPmWorkerElapsed(
                      worker.startedAt,
                      Number.isFinite(nowMs) ? nowMs : 0,
                    );
                    const bucket = classifyPmWorkerBucket(worker.status);
                    return (
                      <button
                        key={worker.threadId}
                        type="button"
                        onClick={() => props.onOpenWorkerThread?.(worker)}
                        className="flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-border bg-card p-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <span className="truncate text-xs font-medium text-foreground">
                                {worker.title}
                              </span>
                              <Badge variant={STATUS_BADGE_VARIANT[worker.status]} size="sm">
                                {statusLabel(worker.status, gt)}
                              </Badge>
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                              <Badge variant="outline" size="sm">
                                {environmentLabel(worker.environmentId)}
                              </Badge>
                              {worker.targetRepoRole !== null ? (
                                <Badge variant="secondary" size="sm">
                                  {worker.targetRepoRole}
                                </Badge>
                              ) : null}
                              <span>
                                <T>
                                  <Var>{worker.turnCount}</Var> turns
                                </T>
                              </span>
                              {elapsed !== null ? (
                                <span className="inline-flex items-center gap-0.5">
                                  <ClockIcon className="size-3" aria-hidden />
                                  {elapsed}
                                </span>
                              ) : null}
                            </div>
                          </div>
                          {props.onOpenWorkerThread !== undefined ? (
                            <ChevronRightIcon
                              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                              aria-hidden
                            />
                          ) : null}
                        </div>
                        {worker.lastMessagePreview !== null &&
                        worker.lastMessagePreview.trim() !== "" ? (
                          <p className="line-clamp-2 text-xs text-muted-foreground">
                            {bucket === "waiting"
                              ? resolveMessage(worker.lastMessagePreview)
                              : worker.lastMessagePreview}
                          </p>
                        ) : null}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
