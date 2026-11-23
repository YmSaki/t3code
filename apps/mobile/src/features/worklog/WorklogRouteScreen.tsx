import { useNavigation } from "@react-navigation/native";
import { shiftWorklogAnchorMs } from "@t3tools/client-runtime/state/worklog";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import { T, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { IconButton } from "../../components/ui/IconButton";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { useWorklogDay } from "./useWorklogDay";

const HOUR_HEIGHT = 48;
const LABEL_WIDTH = 44;
const HOUR_MARKS = [0, 3, 6, 9, 12, 15, 18, 21];

export function WorklogRouteScreen() {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [anchorMs, setAnchorMs] = useState(() => Date.now());
  const { day, pending, failedEnvironmentIds, summary, layout, refresh } = useWorklogDay(anchorMs);
  const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(
    new Date(day.year, day.month - 1, day.day),
  );

  return (
    <SettingsScreen title={gt("Worklog")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <View className="flex-row items-center gap-2">
          <IconButton
            icon="chevron.left"
            accessibilityLabel={gt("Previous day")}
            onPress={() => setAnchorMs((current) => shiftWorklogAnchorMs(current, -1, "day"))}
          />
          <Text className="min-w-0 flex-1 text-center font-t3-bold text-base text-foreground">
            {dateLabel}
          </Text>
          <IconButton
            icon="chevron.right"
            accessibilityLabel={gt("Next day")}
            onPress={() => setAnchorMs((current) => shiftWorklogAnchorMs(current, 1, "day"))}
          />
        </View>
        <View className="flex-row items-center justify-center gap-2">
          <Button
            label={gt("Today")}
            size="compact"
            tone="secondary"
            onPress={() => setAnchorMs(Date.now())}
          />
          <IconButton icon="arrow.clockwise" accessibilityLabel={gt("Refresh")} onPress={refresh} />
        </View>
        {failedEnvironmentIds.length > 0 ? (
          <Notice
            icon="exclamationmark.triangle"
            message={gt("{count} environments could not load their worklog.", {
              count: failedEnvironmentIds.length,
            })}
          />
        ) : null}
        <View className="flex-row gap-3">
          <Stat
            label={gt("Working time")}
            value={formatDuration(summary?.unionDurationMs ?? 0, m)}
          />
          <Stat
            label={gt("Agent time")}
            value={formatDuration(summary?.parallelDurationMs ?? 0, m)}
          />
          <Stat label={gt("Blocks")} value={String(summary?.sliceCount ?? 0)} />
        </View>
        {layout.length === 0 ? (
          pending ? (
            <View className="items-center py-8">
              <AppActivityIndicator />
            </View>
          ) : (
            <Text className="py-6 text-center text-sm text-foreground-muted">
              <T>No agent work on this day.</T>
            </Text>
          )
        ) : (
          <View style={{ height: HOUR_HEIGHT * 24 }}>
            {HOUR_MARKS.map((hour) => (
              <View
                key={hour}
                pointerEvents="none"
                className="absolute right-0 left-0 flex-row items-start border-t border-border"
                style={{ top: hour * HOUR_HEIGHT }}
              >
                <Text className="text-2xs text-foreground-muted" style={{ width: LABEL_WIDTH }}>
                  {`${hour}:00`}
                </Text>
              </View>
            ))}
            <View className="absolute top-0 right-0 bottom-0" style={{ left: LABEL_WIDTH }}>
              {layout.map((item) => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.slice.title}, ${formatDuration(item.slice.durationMs, m)}`}
                  onPress={() =>
                    navigation.navigate("WorklogBlock", {
                      anchorMs: day.dayStartMs + 3_600_000,
                      blockId: item.slice.blockId,
                    })
                  }
                  className="absolute overflow-hidden rounded-lg border border-border bg-card-alt px-1.5 py-1 active:opacity-70"
                  style={{
                    top: `${item.topPercent}%`,
                    height: `${item.heightPercent}%`,
                    left: `${(item.columnIndex / item.columnCount) * 100}%`,
                    width: `${100 / item.columnCount}%`,
                  }}
                >
                  <Text className="font-t3-medium text-2xs text-foreground" numberOfLines={2}>
                    {item.labelDensity === "badge_only" ? item.badgeLabel : item.displayLabel}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function Stat(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-1 gap-0.5 rounded-2xl bg-card px-3 py-3">
      <Text className="text-xs text-foreground-muted" numberOfLines={1}>
        {props.label}
      </Text>
      <Text className="font-t3-bold text-base text-foreground" numberOfLines={1}>
        {props.value}
      </Text>
    </View>
  );
}
