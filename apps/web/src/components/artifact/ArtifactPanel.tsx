import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type Artifact,
  type ArtifactId,
  type ArtifactVersionSummary,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildArtifactBridgeErrorResponse,
  buildArtifactBridgeSuccessResponse,
  buildArtifactBridgeUpdateNotification,
  injectArtifactBootstrap,
  verifyArtifactBridgeMessage,
} from "@t3tools/shared/artifactBridge.core";
import { injectHtmlRenderBootstrap } from "@t3tools/shared/htmlRender";
import {
  buildMarkdownRevisionPrompt,
  buildUnifiedDiff,
  listTaskCheckboxes,
  toggleTaskCheckbox,
} from "@t3tools/shared/markdownArtifact.core";
import { T, useGT, Var } from "gt-react";
import {
  CheckIcon,
  Code2Icon,
  DatabaseIcon,
  EyeIcon,
  GitCompareIcon,
  Maximize2Icon,
  Minimize2Icon,
  SendIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { randomUUID } from "~/lib/utils";
import { useArtifact, useArtifactCommands, useArtifactVersions } from "~/state/artifacts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";

type ArtifactTab = "preview" | "source" | "state" | "diff";

export interface ArtifactPanelProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly artifactId: ArtifactId;
  readonly onSendPrompt?: ((promptText: string) => void | Promise<void>) | undefined;
  readonly onClose?: (() => void) | undefined;
}

function createBridgeSecret(artifactId: ArtifactId, version: number): string {
  return `${artifactId}:${version}:${randomUUID()}`;
}

function formatErrorDescription(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() !== "" ? error.message : fallback;
}

export function ArtifactPanel(props: ArtifactPanelProps) {
  const gt = useGT();
  const theme = useHtmlRenderTheme();
  const [selectedVersion, setSelectedVersion] = useState<number | undefined>(undefined);
  const [activeTab, setActiveTab] = useState<ArtifactTab>("preview");
  const [fullscreen, setFullscreen] = useState(false);

  const artifactQuery = useArtifact(props.environmentId, props.artifactId, selectedVersion);
  const versionsQuery = useArtifactVersions(props.environmentId, props.artifactId);
  const commands = useArtifactCommands();

  const artifact = artifactQuery.data?.artifact ?? null;
  const version = artifactQuery.data?.version ?? null;
  const versions = versionsQuery.data?.versions ?? [];

  const compareFromVersion =
    version !== null && version.version > 1 ? version.version - 1 : undefined;
  const compareQuery = useArtifact(
    props.environmentId,
    compareFromVersion !== undefined && activeTab === "diff" ? props.artifactId : null,
    compareFromVersion,
  );

  const [stateDraftKey, setStateDraftKey] = useState<string>("");
  const [stateDraft, setStateDraft] = useState<string>("{}");
  const currentStateKey = artifact === null ? "" : `${artifact.id}:${artifact.stateVersion}`;
  if (artifact !== null && stateDraftKey !== currentStateKey) {
    setStateDraftKey(currentStateKey);
    setStateDraft(JSON.stringify(artifact.state, null, 2));
  }

  const [rangeStart, setRangeStart] = useState("1");
  const [rangeEnd, setRangeEnd] = useState("1");
  const [commentText, setCommentText] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const [bridgeSecretState, setBridgeSecretState] = useState(() => ({
    artifactId: props.artifactId,
    secret: createBridgeSecret(props.artifactId, 1),
  }));
  if (bridgeSecretState.artifactId !== props.artifactId) {
    setBridgeSecretState({
      artifactId: props.artifactId,
      secret: createBridgeSecret(props.artifactId, 1),
    });
  }
  const bridgeSecret = bridgeSecretState.secret;

  const frameRef = useRef<HTMLIFrameElement>(null);

  const postBridgeUpdate = (nextArtifact: Artifact) => {
    frameRef.current?.contentWindow?.postMessage(
      buildArtifactBridgeUpdateNotification({
        state: nextArtifact.state,
        stateVersion: nextArtifact.stateVersion,
        version: nextArtifact.currentVersion,
        theme: theme.appearance,
      }),
      "*",
    );
  };

  const handleBridgeMessage = useEffectEvent(
    (frame: HTMLIFrameElement, event: MessageEvent<unknown>) => {
      if (artifact === null) return;
      const verified = verifyArtifactBridgeMessage(event.data, {
        expectedSecret: bridgeSecret,
        frameFocused: document.activeElement === frame,
      });
      if (!verified.ok) {
        if (verified.id !== null) {
          frame.contentWindow?.postMessage(
            buildArtifactBridgeErrorResponse(verified.id, verified.code, verified.message),
            "*",
          );
        }
        return;
      }

      const req = verified.request;
      if (req.kind === "getState") {
        frame.contentWindow?.postMessage(
          buildArtifactBridgeSuccessResponse(req.id, {
            state: artifact.state,
            stateVersion: artifact.stateVersion,
          }),
          "*",
        );
        return;
      }

      if (req.kind === "setState") {
        void (async () => {
          const result = await commands.patchState({
            environmentId: props.environmentId,
            input: {
              artifactId: artifact.id,
              patch: req.patch,
              ...(req.expectedVersion === undefined
                ? {}
                : { expectedVersion: req.expectedVersion }),
            },
          });
          if (result._tag === "Success") {
            frame.contentWindow?.postMessage(
              buildArtifactBridgeSuccessResponse(req.id, {
                state: result.value.artifact.state,
                stateVersion: result.value.artifact.stateVersion,
              }),
              "*",
            );
            postBridgeUpdate(result.value.artifact);
            return;
          }
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            frame.contentWindow?.postMessage(
              buildArtifactBridgeErrorResponse(
                req.id,
                -32000,
                formatErrorDescription(failure, gt("Could not update artifact state.")),
              ),
              "*",
            );
          }
        })();
        return;
      }

      if (req.kind === "sendAction" || req.kind === "sendMessage") {
        const action =
          req.kind === "sendAction"
            ? {
                actionName: req.actionName,
                payload: req.payload,
                ...(req.promptText === undefined ? {} : { promptText: req.promptText }),
              }
            : {
                actionName: "message",
                payload: {},
                promptText: req.text,
              };
        void (async () => {
          const result = await commands.dispatchAction({
            environmentId: props.environmentId,
            input: { artifactId: artifact.id, action },
          });
          if (result._tag === "Success") {
            frame.contentWindow?.postMessage(
              buildArtifactBridgeSuccessResponse(req.id, result.value),
              "*",
            );
            if (props.onSendPrompt !== undefined) {
              await props.onSendPrompt(result.value.prompt);
            }
            return;
          }
          if (!isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            frame.contentWindow?.postMessage(
              buildArtifactBridgeErrorResponse(
                req.id,
                -32000,
                formatErrorDescription(failure, gt("Could not submit artifact action.")),
              ),
              "*",
            );
          }
        })();
      }
    },
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to postMessage events from the sandboxed artifact iframe
  useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      handleBridgeMessage(frame, event);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  if (artifactQuery.isPending && artifact === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Spinner size="md" />
      </div>
    );
  }

  if (artifact === null || version === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-sm text-muted-foreground">
        <p>{artifactQuery.error ?? gt("Artifact could not be loaded.")}</p>
        <Button size="sm" variant="outline" onClick={artifactQuery.refresh}>
          {gt("Retry")}
        </Button>
      </div>
    );
  }

  const handleVersionChange = async (nextVersionText: string | null) => {
    if (nextVersionText === null) return;
    const nextVersion = Number.parseInt(nextVersionText, 10);
    if (!Number.isInteger(nextVersion) || nextVersion < 1) return;
    setSelectedVersion(nextVersion);
    setIsBusy(true);
    const result = await commands.switchVersion({
      environmentId: props.environmentId,
      input: { artifactId: artifact.id, version: nextVersion },
    });
    setIsBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not switch artifact version"),
        description: formatErrorDescription(
          squashAtomCommandFailure(result),
          gt("Failed to switch version."),
        ),
      });
    }
  };

  const handleToggleCheckbox = async (index: number, nextChecked: boolean) => {
    if (artifact.kind !== "markdown") return;
    const toggled = toggleTaskCheckbox(version.content, index, nextChecked);
    if (!toggled.ok) return;
    setIsBusy(true);
    const result = await commands.revise({
      environmentId: props.environmentId,
      input: {
        artifactId: artifact.id,
        content: toggled.markdown,
        author: "user",
        summary: gt("Toggled task #{number}", { number: index + 1 }),
      },
    });
    setIsBusy(false);
    if (result._tag === "Success") {
      setSelectedVersion(undefined);
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not update checkbox"),
        description: formatErrorDescription(
          squashAtomCommandFailure(result),
          gt("Failed to revise markdown artifact."),
        ),
      });
    }
  };

  const handleSendRevisionComment = async () => {
    const startLine = Number.parseInt(rangeStart, 10);
    const endLine = Number.parseInt(rangeEnd, 10);
    const prompt = buildMarkdownRevisionPrompt({
      artifactId: artifact.id,
      title: artifact.title,
      markdown: version.content,
      comments: [{ startLine, endLine, comment: commentText }],
    });
    if (prompt === null) {
      toastManager.add({
        type: "warning",
        title: gt("Invalid line range or empty instruction"),
      });
      return;
    }
    setIsBusy(true);
    const result = await commands.dispatchAction({
      environmentId: props.environmentId,
      input: {
        artifactId: artifact.id,
        action: {
          actionName: "revise_markdown_selection",
          payload: { startLine, endLine },
          promptText: prompt,
        },
      },
    });
    setIsBusy(false);
    if (result._tag === "Success") {
      if (result.value.startedTurn) {
        setCommentText("");
        if (props.onSendPrompt !== undefined) {
          await props.onSendPrompt(result.value.prompt);
        }
        toastManager.add({
          type: "success",
          title: gt("Revision request sent"),
        });
      } else {
        toastManager.add({
          type: "warning",
          title: gt("Revision request was not sent"),
          description: gt("No active turn could be started for this thread."),
        });
      }
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not send revision request"),
        description: formatErrorDescription(
          squashAtomCommandFailure(result),
          gt("Request failed."),
        ),
      });
    }
  };

  const handleSaveStateJson = async () => {
    let parsed: unknown;
    let parseFailed = false;
    try {
      parsed = JSON.parse(stateDraft);
    } catch {
      parseFailed = true;
    }
    if (parseFailed || typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      toastManager.add({
        type: "warning",
        title: gt("Shared state must be a JSON object"),
      });
      return;
    }

    const parsedObj = parsed as Record<string, unknown>;
    const patch: Record<string, unknown> = { ...parsedObj };
    for (const key of Object.keys(artifact.state)) {
      if (!Object.hasOwn(parsedObj, key)) {
        patch[key] = null;
      }
    }

    setIsBusy(true);
    const result = await commands.patchState({
      environmentId: props.environmentId,
      input: {
        artifactId: artifact.id,
        patch,
        expectedVersion: artifact.stateVersion,
      },
    });
    setIsBusy(false);
    if (result._tag === "Success") {
      postBridgeUpdate(result.value.artifact);
      toastManager.add({
        type: "success",
        title: gt("Artifact state saved"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: gt("Could not save artifact state"),
        description: formatErrorDescription(
          squashAtomCommandFailure(result),
          gt("State update failed."),
        ),
      });
    }
  };

  const htmlSrcDoc =
    artifact.kind === "html"
      ? injectHtmlRenderBootstrap(
          injectArtifactBootstrap(version.content, {
            artifactId: artifact.id,
            initialState: artifact.state,
            initialStateVersion: artifact.stateVersion,
            secret: bridgeSecret,
          }),
          {
            artifactBridge: {
              artifactId: artifact.id,
              initialState: artifact.state,
              initialStateVersion: artifact.stateVersion,
              secret: bridgeSecret,
            },
          },
        )
      : undefined;

  const checkboxes = artifact.kind === "markdown" ? listTaskCheckboxes(version.content) : [];
  const markdownLines = artifact.kind === "markdown" ? version.content.split(/\r\n|\n|\r/) : [];
  const diffText =
    activeTab === "diff" && compareQuery.data !== null
      ? buildUnifiedDiff(compareQuery.data.version.content, version.content, {
          oldLabel: `v${compareQuery.data.version.version}`,
          newLabel: `v${version.version}`,
        })
      : "";

  const versionOptions: ReadonlyArray<ArtifactVersionSummary> =
    versions.length > 0
      ? versions
      : [
          {
            artifactId: artifact.id,
            version: version.version,
            author: version.author,
            contentLength: version.content.length,
            createdAt: version.createdAt,
          },
        ];

  return (
    <div
      className={
        fullscreen
          ? "fixed inset-0 z-50 flex h-dvh flex-col bg-background"
          : "flex h-full min-h-0 flex-col bg-background"
      }
      data-artifact-panel={artifact.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="secondary">
            {artifact.kind === "html" ? gt("HTML") : gt("Markdown")}
          </Badge>
          <h2 className="truncate text-sm font-medium text-foreground">{artifact.title}</h2>
          <Badge variant="outline">
            <T>
              v<Var>{version.version}</Var>
            </T>
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Select
            value={String(version.version)}
            onValueChange={(value) => {
              void handleVersionChange(value);
            }}
          >
            <SelectTrigger size="xs" className="w-28" aria-label={gt("Artifact version")}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              {versionOptions.map((entry) => (
                <SelectItem key={entry.version} value={String(entry.version)}>
                  {`v${entry.version} (${entry.author})`}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={fullscreen ? gt("Exit fullscreen") : gt("Enter fullscreen")}
            onClick={() => setFullscreen((current) => !current)}
          >
            {fullscreen ? <Minimize2Icon /> : <Maximize2Icon />}
          </Button>
          {props.onClose ? (
            <Button size="xs" variant="ghost" onClick={props.onClose}>
              {gt("Close")}
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <ToggleGroup
          value={[activeTab]}
          onValueChange={(next) => {
            const first = next[0] as ArtifactTab | undefined;
            if (first !== undefined) setActiveTab(first);
          }}
        >
          <ToggleGroupItem value="preview">
            <EyeIcon className="size-3.5" />
            <span>{gt("Preview")}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="source">
            <Code2Icon className="size-3.5" />
            <span>{gt("Source")}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="state">
            <DatabaseIcon className="size-3.5" />
            <span>{gt("State")}</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="diff">
            <GitCompareIcon className="size-3.5" />
            <span>{gt("Diff")}</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <span className="text-xs text-muted-foreground">
          <T>
            State v<Var>{artifact.stateVersion}</Var>
          </T>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {activeTab === "preview" ? (
          artifact.kind === "html" ? (
            <iframe
              ref={frameRef}
              title={artifact.title}
              sandbox="allow-scripts allow-forms"
              srcDoc={htmlSrcDoc}
              className="block size-full border-0 bg-background"
            />
          ) : (
            <ScrollArea className="h-full">
              <div className="flex flex-col gap-4 p-4">
                {checkboxes.length > 0 ? (
                  <div className="rounded-lg border border-border bg-card p-3">
                    <div className="mb-2 text-xs font-medium text-muted-foreground">
                      {gt("Interactive checklist")}
                    </div>
                    <div className="flex flex-col gap-2">
                      {checkboxes.map((item) => (
                        <label
                          key={`${item.line}:${item.index}`}
                          className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                        >
                          <Checkbox
                            checked={item.checked}
                            disabled={isBusy}
                            onCheckedChange={(checked) => {
                              void handleToggleCheckbox(item.index, checked === true);
                            }}
                          />
                          <span
                            className={item.checked ? "line-through text-muted-foreground" : ""}
                          >
                            {item.text}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}

                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    {gt("Document lines")}
                  </div>
                  <div className="flex flex-col gap-1 font-mono text-xs">
                    {markdownLines.map((lineText, idx) => {
                      const lineNumber = idx + 1;
                      return (
                        <div key={`line-${lineNumber}`} className="flex gap-3">
                          <span className="w-8 shrink-0 select-none text-right text-muted-foreground">
                            {lineNumber}
                          </span>
                          <span className="min-w-0 whitespace-pre-wrap break-words text-foreground">
                            {lineText === "" ? " " : lineText}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-lg border border-border bg-card p-3">
                  <div className="mb-2 text-xs font-medium text-muted-foreground">
                    {gt("Request AI revision by line range")}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      type="number"
                      size="compact"
                      className="w-24"
                      aria-label={gt("Start line")}
                      value={rangeStart}
                      onChange={(event) => setRangeStart(event.target.value)}
                    />
                    <span className="text-xs text-muted-foreground">{gt("to")}</span>
                    <Input
                      type="number"
                      size="compact"
                      className="w-24"
                      aria-label={gt("End line")}
                      value={rangeEnd}
                      onChange={(event) => setRangeEnd(event.target.value)}
                    />
                  </div>
                  <div className="mt-2 flex flex-col gap-2">
                    <Textarea
                      size="sm"
                      placeholder={gt("Describe how the agent should revise these lines...")}
                      value={commentText}
                      onChange={(event) => setCommentText(event.target.value)}
                    />
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        disabled={isBusy || commentText.trim() === ""}
                        onClick={() => {
                          void handleSendRevisionComment();
                        }}
                      >
                        <SendIcon />
                        <span>{gt("Send revision request")}</span>
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            </ScrollArea>
          )
        ) : activeTab === "source" ? (
          <ScrollArea className="h-full">
            <pre className="p-4 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
              {version.content}
            </pre>
          </ScrollArea>
        ) : activeTab === "state" ? (
          <div className="flex h-full flex-col gap-3 p-4">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {gt("Edit shared JSON state (16 KiB UTF-8 max)")}
              </span>
              <Button
                size="sm"
                disabled={isBusy}
                onClick={() => {
                  void handleSaveStateJson();
                }}
              >
                <CheckIcon />
                <span>{gt("Save state")}</span>
              </Button>
            </div>
            <div className="flex min-h-0 flex-1 flex-col font-mono text-xs">
              <Textarea
                className="flex-1"
                rows={14}
                value={stateDraft}
                onChange={(event) => setStateDraft(event.target.value)}
              />
            </div>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="p-4">
              {version.version <= 1 ? (
                <p className="text-sm text-muted-foreground">
                  {gt("Version 1 has no previous version to compare against.")}
                </p>
              ) : compareQuery.isPending && compareQuery.data === null ? (
                <Spinner size="sm" />
              ) : diffText === "" ? (
                <p className="text-sm text-muted-foreground">
                  {gt("No line differences between v{from} and v{to}.", {
                    from: compareFromVersion ?? 1,
                    to: version.version,
                  })}
                </p>
              ) : (
                <pre className="rounded-lg border border-border bg-card p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground">
                  {diffText}
                </pre>
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}
