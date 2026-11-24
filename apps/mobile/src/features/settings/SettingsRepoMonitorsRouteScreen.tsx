import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { buildRepoMonitorRuleToggleInput } from "@t3tools/client-runtime/state/repoMonitors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  RepoMonitorDryRunResult,
  RepoMonitorEventKind,
  RepoMonitorEventOutcome,
  RepoMonitorEventRecord,
  RepoMonitorRuleId,
} from "@t3tools/contracts";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { RelativeTime } from "../../components/RelativeTime";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListRow } from "../../components/ui/ListRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { repoMonitorEnvironment } from "../../state/repoMonitors";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";

const EVENT_KIND_LABELS = {
  branch_push: msg("Branch push"),
  pr_opened: msg("Pull request opened"),
  pr_merged: msg("Pull request merged"),
  pr_comment: msg("Pull request comment"),
  issue_opened: msg("Issue opened"),
  issue_comment: msg("Issue comment"),
} satisfies Record<RepoMonitorEventKind, string>;

const OUTCOME_LABELS = {
  triggered: msg("Triggered"),
  skipped_disabled: msg("Skipped: monitor off"),
  skipped_kill_switch: msg("Skipped: kill switch"),
  skipped_loop_guard: msg("Skipped: loop guard"),
  skipped_dedupe: msg("Skipped: duplicate"),
  skipped_cooldown: msg("Skipped: cooldown"),
  skipped_rate_limit: msg("Skipped: rate limit"),
  dry_run: msg("Dry run"),
} satisfies Record<RepoMonitorEventOutcome, string>;

function useScrollPadding() {
  const insets = useSafeAreaInsets();
  return { paddingBottom: Math.max(insets.bottom, 18) + 18 };
}

export function SettingsRepoMonitorsRouteScreen() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const connected = environments.filter(
    (environment) => environment.connection.phase === "connected",
  );
  return (
    <SettingsScreen title={gt("Repo monitors")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={useScrollPadding()}
      >
        {connected.length === 0 ? (
          <EmptyState
            variant="plain"
            title={gt("No connected environments")}
            detail={gt("Connect an environment to see its repo monitors.")}
          />
        ) : (
          connected.map((environment) => (
            <EnvironmentRules
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
            />
          ))
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EnvironmentRules(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const rules = useEnvironmentQuery(
    repoMonitorEnvironment.listRules({ environmentId: props.environmentId, input: {} }),
  );
  return (
    <SettingsSection title={props.label}>
      {rules.error ? <ErrorBanner message={rules.error} /> : null}
      {(rules.data?.rules ?? []).length === 0 && rules.error === null ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          {rules.isPending ? gt("Loading…") : gt("No repo monitors.")}
        </Text>
      ) : (
        rules.data?.rules.map((rule) => (
          <ListRow
            key={rule.id}
            icon="eye"
            label={rule.name}
            description={rule.eventKinds.map((kind) => m(EVENT_KIND_LABELS[kind])).join(", ")}
            detail={rule.enabled ? gt("On") : gt("Off")}
            onPress={() =>
              navigation.navigate("SettingsRepoMonitorRule", {
                environmentId: props.environmentId,
                ruleId: rule.id,
              })
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

export function SettingsRepoMonitorRuleRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly ruleId: RepoMonitorRuleId;
}>) {
  const { environmentId, ruleId } = route.params;
  const gt = useGT();
  const rules = useEnvironmentQuery(repoMonitorEnvironment.listRules({ environmentId, input: {} }));
  const events = useEnvironmentQuery(
    repoMonitorEnvironment.listEvents({ environmentId, input: { ruleId, limit: 20 } }),
  );
  const canWrite = useAtomValue(repoMonitorEnvironment.upsertRule.permissionAtom(environmentId));
  const canDryRun = useAtomValue(repoMonitorEnvironment.dryRun.permissionAtom(environmentId));
  const upsertRule = useAtomCommand(repoMonitorEnvironment.upsertRule, { reportFailure: false });
  const dryRun = useAtomCommand(repoMonitorEnvironment.dryRun, { reportFailure: false });
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [dryRunResults, setDryRunResults] = useState<ReadonlyArray<RepoMonitorDryRunResult> | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [openEventId, setOpenEventId] = useState<string | null>(null);
  const rule = rules.data?.rules.find((item) => item.id === ruleId) ?? null;
  const padding = useScrollPadding();
  const failureText = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
    const failure = squashAtomCommandFailure(result);
    return failure instanceof Error && failure.message.trim() !== ""
      ? failure.message
      : gt("The environment request failed.");
  };

  const toggle = async (enabled: boolean) => {
    if (rule === null) return;
    setSaving(true);
    setError(null);
    const result = await upsertRule({
      environmentId,
      input: buildRepoMonitorRuleToggleInput(rule, enabled),
    });
    if (result._tag === "Failure") setError(failureText(result));
    setSaving(false);
  };

  const runDryRun = async () => {
    if (rule === null) return;
    setRunning(true);
    setError(null);
    const result = await dryRun({
      environmentId,
      input: { projectId: rule.projectId, ruleId: rule.id },
    });
    if (result._tag === "Success") setDryRunResults(result.value.results);
    else setError(failureText(result));
    setRunning(false);
  };

  return (
    <SettingsScreen title={rule?.name ?? gt("Repo monitor")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={padding}
      >
        {rules.error ? <ErrorBanner message={rules.error} /> : null}
        {error ? <ErrorBanner message={error} /> : null}
        {rule === null ? (
          rules.isPending ? null : (
            <EmptyState
              variant="plain"
              title={gt("Repo monitor not found")}
              detail={gt("It may have been deleted on another device.")}
            />
          )
        ) : (
          <>
            <SettingsSection footer={rule.description}>
              <ListToggleRow
                icon="eye"
                label={gt("Monitor")}
                value={rule.enabled}
                disabled={!canWrite || saving}
                onValueChange={(value) => void toggle(value)}
              />
            </SettingsSection>
            <SettingsSection
              title={gt("Dry run")}
              trailing={
                <Button
                  label={gt("Run")}
                  size="compact"
                  loading={running}
                  disabled={!canDryRun}
                  onPress={() => void runDryRun()}
                />
              }
            >
              {dryRunResults === null ? (
                <Text className="px-4 py-3 text-sm text-foreground-muted">
                  <T>See what this monitor would trigger now, without starting anything.</T>
                </Text>
              ) : (
                dryRunResults.flatMap((result) =>
                  result.matchedEvents.length === 0
                    ? [
                        <Text
                          key={result.ruleId}
                          className="px-4 py-3 text-sm text-foreground-muted"
                        >
                          {gt("Nothing matches right now.")}
                        </Text>,
                      ]
                    : result.matchedEvents.map((event) => (
                        <EventRow
                          key={`dry:${result.ruleId}:${event.id}`}
                          environmentId={environmentId}
                          event={event}
                          prompt={event.renderedPrompt ?? null}
                          open={openEventId === `dry:${event.id}`}
                          onToggle={() =>
                            setOpenEventId(
                              openEventId === `dry:${event.id}` ? null : `dry:${event.id}`,
                            )
                          }
                        />
                      )),
                )
              )}
            </SettingsSection>
            <SettingsSection title={gt("Recent events")}>
              {events.error ? <ErrorBanner message={events.error} /> : null}
              {(events.data?.events ?? []).length === 0 && events.error === null ? (
                <Text className="px-4 py-3 text-sm text-foreground-muted">
                  {events.isPending ? gt("Loading…") : gt("No events yet.")}
                </Text>
              ) : (
                events.data?.events.map((event) => (
                  <EventRow
                    key={event.id}
                    environmentId={environmentId}
                    event={event}
                    prompt={event.renderedPrompt ?? null}
                    open={openEventId === event.id}
                    onToggle={() => setOpenEventId(openEventId === event.id ? null : event.id)}
                  />
                ))
              )}
            </SettingsSection>
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function EventRow(props: {
  readonly environmentId: EnvironmentId;
  readonly event: RepoMonitorEventRecord;
  readonly prompt: string | null;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const selectDetail = useSelectWorkspaceDetail();
  const { event } = props;
  const reference = [
    event.branch,
    event.pullRequestNumber == null ? null : `#${event.pullRequestNumber}`,
    event.issueKey,
    event.commitSha?.slice(0, 7),
    event.authorLogin,
  ].filter(Boolean);
  return (
    <View>
      <ListRow
        icon={event.outcome === "triggered" ? "checkmark.circle" : "circle.dashed"}
        label={event.summary}
        description={`${m(EVENT_KIND_LABELS[event.eventKind])} · ${m(OUTCOME_LABELS[event.outcome])}`}
        meta={<RelativeTime timestamp={event.occurredAt} />}
        onPress={props.onToggle}
      />
      {props.open ? (
        <View className="gap-2 px-4 pb-3">
          {reference.length > 0 ? (
            <Text className="text-xs text-foreground-muted" selectable>
              {reference.join(" · ")}
            </Text>
          ) : null}
          {props.prompt ? (
            <Text
              className="rounded-xl bg-card-alt p-3 font-mono text-xs text-foreground"
              selectable
            >
              {props.prompt}
            </Text>
          ) : null}
          <View className="flex-row flex-wrap gap-2">
            {event.url ? (
              <Button
                label={gt("Open link")}
                size="compact"
                tone="secondary"
                onPress={() => void tryOpenExternalUrl(event.url!)}
              />
            ) : null}
            {event.dispatchedThreadId ? (
              <Button
                label={gt("Open thread")}
                size="compact"
                tone="secondary"
                onPress={() =>
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: String(props.environmentId),
                      threadId: String(event.dispatchedThreadId),
                    },
                  })
                }
              />
            ) : null}
          </View>
        </View>
      ) : null}
    </View>
  );
}
