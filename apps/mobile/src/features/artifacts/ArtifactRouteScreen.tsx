import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  TrimmedNonEmptyString,
  type ArtifactId,
  type ArtifactResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import { setMarkdownTaskChecked } from "@t3tools/shared/markdownTaskEdits";
import { markdownTaskMarkerOffset } from "@t3tools/shared/markdownTaskList";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { artifactEnvironment } from "../../state/artifacts";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { ArtifactWebView } from "./ArtifactWebView";

export function ArtifactRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId; readonly artifactId: ArtifactId }>) {
  const { environmentId, artifactId } = route.params;
  const gt = useGT();
  const navigation = useNavigation();
  const result = useEnvironmentQuery(
    artifactEnvironment.get({ environmentId, input: { artifactId } }),
  );
  const data = result.data;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={data?.artifact.title ?? gt("Artifact")}
        subtitle={data ? gt("Version {version}", { version: data.version.version }) : null}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: gt("Refresh"), onPress: result.refresh }}
      />
      <ScreenContent>
        {result.error ? (
          <View className="p-4">
            <ErrorBanner message={result.error} />
          </View>
        ) : null}
        {data === null ? (
          result.isPending ? (
            <View className="flex-1 items-center justify-center">
              <AppActivityIndicator />
            </View>
          ) : null
        ) : data.artifact.kind === "html" ? (
          <ArtifactWebView
            environmentId={environmentId}
            artifact={data.artifact}
            content={data.version.content}
          />
        ) : (
          <MarkdownArtifact environmentId={environmentId} data={data} onFailed={result.refresh} />
        )}
      </ScreenContent>
    </View>
  );
}

/** Ticking a task box saves a new version, so the agent sees the change in the artifact. */
function MarkdownArtifact(props: {
  readonly environmentId: EnvironmentId;
  readonly data: ArtifactResult;
  readonly onFailed: () => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const canRevise = useAtomValue(artifactEnvironment.revise.permissionAtom(props.environmentId));
  const revise = useAtomCommand(artifactEnvironment.revise);
  // Taps wait for the saved version to load, so each edit starts from the latest content.
  const [awaitedVersion, setAwaitedVersion] = useState<number | null>(null);
  // The renderer ticks a box before the save; remounting it shows the saved content again.
  const [undoneTicks, setUndoneTicks] = useState(0);
  const { artifact, version } = props.data;
  const saving = awaitedVersion !== null && version.version < awaitedVersion;
  const undo = () => {
    setUndoneTicks((count) => count + 1);
    props.onFailed();
  };
  const onTaskListItemPress = async (event: {
    readonly index: number;
    readonly checked: boolean;
    readonly text: string;
  }) => {
    const offset = saving
      ? null
      : markdownTaskMarkerOffset(version.content, event.index, event.text, event.checked);
    if (offset === null) return undo();
    setAwaitedVersion(Number.POSITIVE_INFINITY);
    const result = await revise({
      environmentId: props.environmentId,
      input: {
        artifactId: artifact.id,
        content: setMarkdownTaskChecked(version.content, offset, event.checked),
        author: "user",
        expectedVersion: version.version,
        // Stored with the version for the agent to read, so it stays in one language.
        summary: TrimmedNonEmptyString.make(
          `${event.checked ? "Checked" : "Unchecked"} "${event.text.trim().slice(0, 400) || "task"}"`,
        ),
      },
    });
    if (result._tag === "Success") {
      setAwaitedVersion(result.value.version.version);
    } else {
      setAwaitedVersion(null);
      undo();
    }
  };
  return (
    <ScrollView className="flex-1" contentContainerStyle={{ padding: 18 }}>
      <View className="mx-auto w-full max-w-[760px]">
        <SelectableMarkdownText
          key={`${version.version}:${undoneTicks}`}
          markdown={version.content}
          textStyle={styles.nativeTextStyle}
          {...(canRevise
            ? { onTaskListItemPress: (event) => void onTaskListItemPress(event) }
            : {})}
        />
      </View>
    </ScrollView>
  );
}
