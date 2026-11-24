import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { T, useGT, useMessages } from "gt-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { useWorklogDay } from "./useWorklogDay";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** The summary log of one merged work block: what ran, for how long, and what it changed. */
export function WorklogBlockSheet({
  route,
}: StaticScreenProps<{ readonly anchorMs: number; readonly blockId: string }>) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { view } = useWorklogDay(Number(route.params.anchorMs));
  const block = view.blocks.find((item) => item.id === route.params.blockId) ?? null;
  const entries = block ? view.entries.filter((entry) => block.entryIds.includes(entry.id)) : [];
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader
        title={block?.title ?? gt("Work block")}
        subtitle={block ? `${block.provider}${block.model ? ` · ${block.model}` : ""}` : undefined}
        onClose={() => navigation.goBack()}
      />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {block === null ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              <T>This block is no longer in the worklog.</T>
            </Text>
          ) : (
            <>
              <Text className="text-sm text-foreground-secondary">
                {`${timeFormat.format(block.startedAtMs)} – ${timeFormat.format(block.endedAtMs)}`}
                {block.projectTitle ? ` · ${block.projectTitle}` : ""}
              </Text>
              <View className="gap-1 rounded-2xl bg-card p-4">
                <Detail
                  label={gt("Active time")}
                  value={formatDuration(block.activeDurationMs, m)}
                />
                <Detail label={gt("Span")} value={formatDuration(block.durationMs, m)} />
                <Detail label={gt("Turns")} value={String(block.turnCount)} />
                <Detail label={gt("Changed files")} value={String(block.stats.changedFilesCount)} />
                <Detail label={gt("Commands")} value={String(block.stats.commandsCount)} />
                <Detail
                  label={gt("Tokens")}
                  value={`${block.stats.inputTokens + block.stats.outputTokens}`}
                />
              </View>
              {block.summary ? (
                <Text className="text-sm leading-normal text-foreground" selectable>
                  {block.summary}
                </Text>
              ) : null}
              {entries.length > 1 ? (
                <ListSection title={gt("Runs")}>
                  {entries.map((entry) => (
                    <View key={entry.id} className="gap-0.5 px-4 py-3">
                      <Text className="font-t3-medium text-sm text-foreground" numberOfLines={2}>
                        {entry.title}
                      </Text>
                      <Text className="text-xs text-foreground-muted">
                        {`${timeFormat.format(new Date(entry.startedAt))} – ${timeFormat.format(new Date(entry.endedAt))}`}
                      </Text>
                      {entry.summary ? (
                        <Text className="text-xs text-foreground-secondary" selectable>
                          {entry.summary}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </ListSection>
              ) : null}
              {block.threadId !== null && block.source === "t3_run" ? (
                <Button
                  label={gt("Open thread")}
                  tone="secondary"
                  onPress={() =>
                    navigation.dispatch(
                      StackActions.replace("Thread", {
                        environmentId: EnvironmentId.make(block.environmentId),
                        threadId: ThreadId.make(block.threadId!),
                      }),
                    )
                  }
                />
              ) : null}
            </>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}

function Detail(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row justify-between gap-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="font-t3-medium text-sm text-foreground">{props.value}</Text>
    </View>
  );
}
