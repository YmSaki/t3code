import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { countActivePmWorkers } from "@t3tools/client-runtime/state/pmBoard";
import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type PmWorkerStatus,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { pmBoardEnvironment, usePmWorkerApprovals } from "../../state/pmBoard";
import { useEnvironmentQuery } from "../../state/query";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { PendingApprovalCard } from "./PendingApprovalCard";

const STATUS_LABELS = {
  queued: msg("Queued"),
  running: msg("Running"),
  waiting_approval: msg("Waiting for approval"),
  waiting_input: msg("Waiting for input"),
  completed: msg("Completed"),
  failed: msg("Failed"),
  interrupted: msg("Interrupted"),
  cancelled: msg("Cancelled"),
} satisfies Record<PmWorkerStatus, string>;

function Stat(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-1 gap-0.5 rounded-2xl bg-card px-4 py-3">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="font-t3-bold text-lg text-foreground">{props.value}</Text>
    </View>
  );
}

function WorkerApproval(props: {
  readonly entry: ChildThreadApproval;
  readonly locked: boolean;
  readonly responding: boolean;
  readonly onRespond: (decision: ProviderApprovalDecision) => Promise<unknown>;
}) {
  const { entry } = props;
  const canOperate = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  return (
    <View className="gap-1.5">
      <Text className="font-t3-medium text-xs text-foreground-muted">{entry.title}</Text>
      <PendingApprovalCard
        canOperateThread={canOperate && !props.locked}
        approval={entry.approval}
        respondingApprovalId={props.responding ? entry.approval.requestId : null}
        onRespond={(_requestId, decision) => props.onRespond(decision)}
      />
    </View>
  );
}

const approvalKey = (entry: ChildThreadApproval) =>
  `${entry.thread.environmentId}:${entry.thread.threadId}:${entry.approval.requestId}`;

const isLive = (entry: ChildThreadApproval) => entry.approval.responseCapability === "live";

export function PmBoardSheet({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly pmThreadId: ThreadId }>) {
  const { environmentId, pmThreadId } = route.params;
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const board = useEnvironmentQuery(
    pmBoardEnvironment.board({ environmentId, input: { pmThreadId } }),
  );
  const workers = board.data?.workers ?? [];
  const approvals = usePmWorkerApprovals(
    workers
      .filter((worker) => worker.status === "waiting_approval")
      .map((worker) => ({
        environmentId: worker.environmentId,
        threadId: worker.threadId,
        title: worker.title,
      })),
  );
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);

  const answer = async (entry: ChildThreadApproval, decision: ProviderApprovalDecision) => {
    const key = approvalKey(entry);
    setResponding((current) => new Set(current).add(key));
    const result = await respond({
      environmentId: entry.thread.environmentId,
      input: { threadId: entry.thread.threadId, requestId: entry.approval.requestId, decision },
    });
    setResponding((current) => {
      const next = new Set(current);
      next.delete(key);
      return next;
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : gt("Failed to submit approval decision."),
      );
    }
    return result;
  };

  const answerable = approvals.filter(isLive);
  const canOperate = (entry: ChildThreadApproval) =>
    readEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const approveAll = () => {
    const allowed = answerable.filter(canOperate);
    if (allowed.length === 0) return;
    Dialog.alert(
      gt("Allow {count} requests?", { count: allowed.length }),
      allowed.map((entry) => entry.title).join("\n"),
      [
        { text: gt("Cancel"), style: "cancel" },
        {
          text: gt("Allow all"),
          onPress: () => {
            setError(null);
            setBatchRunning(true);
            // One at a time; rights are re-read as each starts in case they changed meanwhile.
            void allowed
              .reduce<Promise<unknown>>(
                (previous, entry) =>
                  previous.then(() => (canOperate(entry) ? answer(entry, "accept") : undefined)),
                Promise.resolve(),
              )
              .finally(() => setBatchRunning(false));
          },
        },
      ],
    );
  };

  const openThread = (threadEnvironmentId: EnvironmentId, threadId: ThreadId) =>
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: threadEnvironmentId, threadId }),
    );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={gt("PM board")} onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          nestedScrollEnabled
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {board.error ? <ErrorBanner message={board.error} /> : null}
          {error ? <ErrorBanner message={error} /> : null}
          {board.data === null ? (
            board.isPending ? (
              <View className="items-center py-8">
                <AppActivityIndicator />
              </View>
            ) : null
          ) : (
            <>
              {board.data.killSwitchActive ? (
                <Notice
                  tone="danger"
                  icon="exclamationmark.triangle"
                  message={gt("The kill switch is on. No new workers start.")}
                />
              ) : null}
              <View className="flex-row gap-3">
                <Stat
                  label={gt("Active workers")}
                  value={`${countActivePmWorkers(workers)} / ${board.data.policy.maxConcurrentWorkers}`}
                />
                <Stat
                  label={gt("Delegated turns")}
                  value={`${board.data.delegatedTurnCount} / ${board.data.policy.maxDelegatedTurns}`}
                />
              </View>
              {approvals.length > 0 ? (
                <View className="gap-3">
                  <View className="flex-row items-center justify-between">
                    <Text className="font-t3-bold text-sm text-foreground">{gt("Approvals")}</Text>
                    <Button
                      label={gt("Allow all")}
                      size="compact"
                      loading={batchRunning}
                      disabled={answerable.length === 0 || responding.size > 0}
                      onPress={approveAll}
                    />
                  </View>
                  {approvals.map((entry) => (
                    <WorkerApproval
                      key={approvalKey(entry)}
                      entry={entry}
                      locked={batchRunning}
                      responding={responding.has(approvalKey(entry))}
                      onRespond={(decision) => {
                        setError(null);
                        return answer(entry, decision);
                      }}
                    />
                  ))}
                </View>
              ) : null}
              {board.data.pendingQuestions.length > 0 ? (
                <ListSection title={gt("Questions")}>
                  {board.data.pendingQuestions.map((question) => {
                    const worker = workers.find(
                      (item) => item.threadId === question.workerThreadId,
                    );
                    return (
                      <ListRow
                        key={question.workerThreadId}
                        icon="questionmark.bubble"
                        label={question.title}
                        description={question.questions.join("\n")}
                        disabled={worker === undefined}
                        onPress={() => worker && openThread(worker.environmentId, worker.threadId)}
                      />
                    );
                  })}
                </ListSection>
              ) : null}
              <ListSection title={gt("Workers")}>
                {workers.length === 0 ? (
                  <Text className="px-4 py-3 text-sm text-foreground-muted">
                    {gt("No workers yet.")}
                  </Text>
                ) : (
                  workers.map((worker) => (
                    <ListRow
                      key={`${worker.environmentId}:${worker.threadId}`}
                      icon="text.bubble"
                      label={worker.title}
                      description={worker.lastMessagePreview ?? undefined}
                      detail={m(STATUS_LABELS[worker.status])}
                      onPress={() => openThread(worker.environmentId, worker.threadId)}
                    />
                  ))
                )}
              </ListSection>
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
