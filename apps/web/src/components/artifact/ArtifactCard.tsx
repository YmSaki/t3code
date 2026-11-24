import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { Artifact, ArtifactId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  buildMarkdownRevisionPrompt,
  listTaskCheckboxes,
  toggleTaskCheckbox,
} from "@t3tools/shared/markdownArtifact.core";
import { T, useGT, Var } from "gt-react";
import { FileCode2Icon, FileTextIcon, PanelRightOpenIcon, SendIcon } from "lucide-react";
import { useState } from "react";

import { useArtifact, useArtifactCommands } from "~/state/artifacts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

export interface ArtifactCardProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly artifact: Artifact;
  readonly onOpenPanel?: ((artifactId: ArtifactId) => void) | undefined;
  readonly onSendPrompt?: ((promptText: string) => void | Promise<void>) | undefined;
}

export function ArtifactCard(props: ArtifactCardProps) {
  const { artifact } = props;
  const gt = useGT();
  const artifactQuery = useArtifact(props.environmentId, artifact.id);
  const commands = useArtifactCommands();
  const [quickComment, setQuickComment] = useState("");
  const [isBusy, setIsBusy] = useState(false);

  const version = artifactQuery.data?.version ?? null;
  const checkboxes =
    artifact.kind === "markdown" && version !== null ? listTaskCheckboxes(version.content) : [];
  const visibleCheckboxes = checkboxes.slice(0, 4);
  const remainingCount = Math.max(0, checkboxes.length - visibleCheckboxes.length);

  const handleToggleCheckbox = async (index: number, nextChecked: boolean) => {
    if (artifact.kind !== "markdown" || version === null) return;
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
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const err = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not update checkbox"),
        description: err instanceof Error ? err.message : gt("Failed to revise artifact."),
      });
    }
  };

  const handleQuickRevision = async () => {
    const trimmed = quickComment.trim();
    if (trimmed === "" || version === null) return;
    const lineCount = Math.max(1, version.content.split(/\r\n|\n|\r/).length);
    const prompt = buildMarkdownRevisionPrompt({
      artifactId: artifact.id,
      title: artifact.title,
      markdown: version.content,
      comments: [{ startLine: 1, endLine: lineCount, comment: trimmed }],
    });
    if (prompt === null) return;

    setIsBusy(true);
    const result = await commands.dispatchAction({
      environmentId: props.environmentId,
      input: {
        artifactId: artifact.id,
        action: {
          actionName: "revise_markdown_card",
          payload: { startLine: 1, endLine: lineCount },
          promptText: prompt,
        },
      },
    });
    setIsBusy(false);
    if (result._tag === "Success") {
      if (result.value.startedTurn) {
        setQuickComment("");
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
      const err = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Could not send revision request"),
        description: err instanceof Error ? err.message : gt("Request failed."),
      });
    }
  };

  return (
    <div
      className="rounded-xl border border-border bg-card p-3 sm:p-4"
      data-artifact-card={artifact.id}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {artifact.kind === "html" ? (
            <FileCode2Icon className="size-4 shrink-0 text-muted-foreground" />
          ) : (
            <FileTextIcon className="size-4 shrink-0 text-muted-foreground" />
          )}
          <span className="truncate text-sm font-medium text-foreground">{artifact.title}</span>
          <Badge variant="secondary">
            {artifact.kind === "html" ? gt("HTML") : gt("Markdown")}
          </Badge>
          <Badge variant="outline">
            <T>
              v<Var>{artifact.currentVersion}</Var>
            </T>
          </Badge>
        </div>
        {props.onOpenPanel !== undefined ? (
          <Button size="sm" variant="outline" onClick={() => props.onOpenPanel?.(artifact.id)}>
            <PanelRightOpenIcon />
            <span>{gt("Open panel")}</span>
          </Button>
        ) : null}
      </div>

      {visibleCheckboxes.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1.5 border-t border-border pt-2.5">
          {visibleCheckboxes.map((item) => (
            <label
              key={`${item.line}:${item.index}`}
              className="flex cursor-pointer items-center gap-2 text-xs text-foreground"
            >
              <Checkbox
                checked={item.checked}
                disabled={isBusy}
                onCheckedChange={(checked) => {
                  void handleToggleCheckbox(item.index, checked === true);
                }}
              />
              <span className={item.checked ? "line-through text-muted-foreground" : ""}>
                {item.text}
              </span>
            </label>
          ))}
          {remainingCount > 0 ? (
            <span className="text-xs text-muted-foreground">
              <T>
                +<Var>{remainingCount}</Var> more tasks in panel
              </T>
            </span>
          ) : null}
        </div>
      ) : null}

      {artifact.kind === "markdown" && version !== null ? (
        <div className="mt-3 flex items-center gap-2 border-t border-border pt-2.5">
          <Input
            size="compact"
            className="flex-1"
            placeholder={gt("Request a quick revision...")}
            value={quickComment}
            onChange={(event) => setQuickComment(event.target.value)}
          />
          <Button
            size="compact"
            variant="secondary"
            disabled={isBusy || quickComment.trim() === ""}
            onClick={() => {
              void handleQuickRevision();
            }}
          >
            <SendIcon />
            <span>{gt("Send")}</span>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
