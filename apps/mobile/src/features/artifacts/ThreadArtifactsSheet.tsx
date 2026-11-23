import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { RelativeTime } from "../../components/RelativeTime";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { artifactEnvironment } from "../../state/artifacts";
import { useEnvironmentQuery } from "../../state/query";

export function ThreadArtifactsSheet({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly threadId: ThreadId }>) {
  const { environmentId, threadId } = route.params;
  const gt = useGT();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const list = useEnvironmentQuery(
    artifactEnvironment.list({ environmentId, input: { threadId } }),
  );
  const artifacts = list.data?.artifacts ?? [];
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <SheetHeader title={gt("Artifacts")} onClose={() => navigation.goBack()} />
      <ScreenContent>
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-4 px-5 pt-2"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        >
          {list.error ? <ErrorBanner message={list.error} /> : null}
          {list.data === null && list.isPending ? (
            <View className="items-center py-8">
              <AppActivityIndicator />
            </View>
          ) : artifacts.length === 0 && list.error === null ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              <T>No artifacts in this thread.</T>
            </Text>
          ) : (
            <ListSection>
              {artifacts.map((artifact) => (
                <ListRow
                  key={artifact.id}
                  icon={artifact.kind === "html" ? "globe" : "doc.text"}
                  label={artifact.title}
                  meta={<RelativeTime timestamp={artifact.updatedAt} />}
                  onPress={() =>
                    navigation.dispatch(
                      StackActions.replace("Artifact", { environmentId, artifactId: artifact.id }),
                    )
                  }
                />
              ))}
            </ListSection>
          )}
        </ScrollView>
      </ScreenContent>
    </View>
  );
}
