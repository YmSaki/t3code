import {
  CommandId,
  MessageId,
  TrimmedNonEmptyString,
  type Artifact,
  type EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  buildArtifactBridgeErrorResponse,
  buildArtifactBridgeSuccessResponse,
  verifyArtifactBridgeMessage,
  type ArtifactBridgeRequest,
} from "@t3tools/shared/artifactBridge.core";
import { msg, T, useGT } from "gt-react-native";
import { useEffect, useRef, useState } from "react";
import { Platform, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { m } from "../../i18n/messages";
import { uuidv4 } from "../../lib/uuid";
import { webViewDecelerationRate } from "../../lib/webViewDecelerationRate";
import { artifactEnvironment } from "../../state/artifacts";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  artifactFrameUrl,
  artifactOuterHtml,
  artifactReceiveScript,
  artifactStateUpdate,
} from "./artifactBridge.logic";

const JSON_RPC_INTERNAL_ERROR = -32603;

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : m(msg("Request failed."));
};

/** An HTML artifact in a sandboxed frame that reads and writes its state through the bridge. */
export function ArtifactWebView(props: {
  readonly environmentId: EnvironmentId;
  readonly artifact: Artifact;
  readonly content: string;
}) {
  const gt = useGT();
  const view = useRef<WebView<object>>(null);
  const [secret] = useState(uuidv4);
  const [loaded, setLoaded] = useState(false);
  const [stopped, setStopped] = useState<"navigated" | "crashed" | null>(null);
  const patchState = useAtomCommand(artifactEnvironment.patchState, { reportFailure: false });
  const dispatchAction = useAtomCommand(artifactEnvironment.dispatchAction, {
    reportFailure: false,
  });
  const post = (message: unknown) => view.current?.injectJavaScript(artifactReceiveScript(message));

  const { artifact } = props;
  // A new version reloads the document; state changes reach the open one without a reload.
  const documentKey = `${artifact.id}:${artifact.currentVersion}`;
  const [document, setDocument] = useState(() => ({
    key: documentKey,
    html: artifactOuterHtml(artifactFrameUrl(artifact, props.content), secret),
  }));
  if (document.key !== documentKey) {
    setDocument({
      key: documentKey,
      html: artifactOuterHtml(artifactFrameUrl(artifact, props.content), secret),
    });
    setLoaded(false);
    setStopped(null);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the WebView document is outside React; it learns new state only through an injected update
  useEffect(() => {
    if (loaded)
      view.current?.injectJavaScript(artifactReceiveScript(artifactStateUpdate(artifact)));
  }, [artifact, loaded]);

  const confirmMessage = (text: string) =>
    new Promise<boolean>((resolve) =>
      Dialog.alert(
        gt("Send this message from {title}?", { title: artifact.title }),
        text,
        [
          { text: gt("Cancel"), style: "cancel", onPress: () => resolve(false) },
          {
            text: gt("Send", { $context: "verb, sends the message" }),
            onPress: () => resolve(true),
          },
        ],
        { cancelable: true, onDismiss: () => resolve(false) },
      ),
    );

  const handle = async (request: ArtifactBridgeRequest): Promise<unknown> => {
    switch (request.kind) {
      case "getState":
        return { state: artifact.state, stateVersion: artifact.stateVersion };
      case "setState": {
        const result = await patchState({
          environmentId: props.environmentId,
          input: {
            artifactId: artifact.id,
            patch: request.patch,
            ...(request.expectedVersion === undefined
              ? {}
              : { expectedVersion: request.expectedVersion }),
          },
        });
        if (result._tag !== "Success") throw new Error(failureMessage(result));
        return {
          state: result.value.artifact.state,
          stateVersion: result.value.artifact.stateVersion,
        };
      }
      case "sendAction": {
        const promptText = request.promptText?.trim();
        const result = await dispatchAction({
          environmentId: props.environmentId,
          input: {
            artifactId: artifact.id,
            action: {
              actionName: TrimmedNonEmptyString.make(request.actionName.trim()),
              payload: request.payload,
              ...(promptText ? { promptText: TrimmedNonEmptyString.make(promptText) } : {}),
            },
          },
        });
        if (result._tag !== "Success") throw new Error(failureMessage(result));
        return result.value;
      }
      case "sendMessage": {
        if (!(await confirmMessage(request.text))) throw new Error("Declined by the user.");
        await enqueueThreadOutboxMessage({
          environmentId: props.environmentId,
          threadId: artifact.threadId,
          messageId: MessageId.make(uuidv4()),
          commandId: CommandId.make(uuidv4()),
          text: request.text,
          attachments: [],
          dispatchMode: "queue",
          createdAt: new Date().toISOString(),
        });
        return { queued: true };
      }
    }
  };

  const onMessage = (event: WebViewMessageEvent) => {
    const verified = verifyArtifactBridgeMessage(event.nativeEvent.data, {
      expectedSecret: secret,
    });
    if (!verified.ok) {
      if (verified.reason === "navigated") setStopped("navigated");
      else if (verified.reason !== "invalid_secret" && verified.id !== null)
        post(buildArtifactBridgeErrorResponse(verified.id, verified.code, verified.message));
      return;
    }
    const { request } = verified;
    void handle(request).then(
      (result) => post(buildArtifactBridgeSuccessResponse(request.id, result)),
      (error: unknown) =>
        post(
          buildArtifactBridgeErrorResponse(
            request.id,
            JSON_RPC_INTERNAL_ERROR,
            error instanceof Error ? error.message : m(msg("Request failed.")),
          ),
        ),
    );
  };

  if (stopped !== null) {
    return (
      <View className="flex-1 items-center justify-center gap-4 px-8">
        <Text className="text-center text-sm text-foreground-muted">
          {stopped === "navigated" ? (
            <T>This artifact left its page and was stopped.</T>
          ) : (
            <T>This artifact stopped responding.</T>
          )}
        </Text>
        <Button
          label={gt("Retry")}
          tone="secondary"
          onPress={() => {
            setLoaded(false);
            setStopped(null);
          }}
        />
      </View>
    );
  }

  return (
    <View className="flex-1">
      <WebView<object>
        key={document.key}
        ref={view}
        source={{ html: document.html }}
        accessibilityLabel={artifact.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        nestedScrollEnabled
        decelerationRate={webViewDecelerationRate}
        originWhitelist={["*"]}
        // Android misreports nested frames as top-level; the frame's sandbox and CSP gate it there.
        onShouldStartLoadWithRequest={(request) =>
          Platform.OS === "android" || request.isTopFrame === false || request.url === "about:blank"
        }
        setSupportMultipleWindows={false}
        onLoadEnd={() => setLoaded(true)}
        onContentProcessDidTerminate={() => setStopped("crashed")}
        onRenderProcessGone={() => setStopped("crashed")}
        onMessage={onMessage}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}
