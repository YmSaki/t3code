import {
  CommandId,
  ProviderInstanceId,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadHandoffMode,
  type ThreadId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";
import { useState } from "react";
import { threadHandoff } from "../../state/orchestration";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

const HANDOFF_PROVIDERS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
  { value: "codex", label: "Codex" },
  { value: "claudeAgent", label: "Claude" },
  { value: "cursor", label: "Cursor" },
  { value: "opencode", label: "OpenCode" },
  { value: "pi", label: "Pi" },
  { value: "grok", label: "Grok" },
  { value: "antigravity", label: "Antigravity" },
  { value: "kiro", label: "Kiro" },
  { value: "muse", label: "Muse Code" },
  { value: "fx", label: "fx" },
];

interface ThreadHandoffDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly threadRef: ScopedThreadRef;
  readonly onHandoffSuccess?: ((threadId: ThreadId) => void) | undefined;
}

export function ThreadHandoffDialog({
  open,
  onOpenChange,
  threadRef,
  onHandoffSuccess,
}: ThreadHandoffDialogProps) {
  const gt = useGT();
  const [provider, setProvider] = useState("claudeAgent");
  const [model, setModel] = useState("claude-sonnet-4-6");
  const [mode, setMode] = useState<ThreadHandoffMode>("raw");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const runHandoff = useOrchestrationCommand(threadHandoff, { reportFailure: false });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedModel = model.trim();
    if (!trimmedModel || submitting) return;

    setSubmitting(true);
    setErrorMessage(null);
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make(provider),
      model: trimmedModel,
    };

    try {
      const result = await runHandoff({
        environmentId: threadRef.environmentId,
        input: {
          commandId: CommandId.make(`handoff-${Date.now()}`),
          threadId: threadRef.threadId,
          modelSelection,
          mode,
        },
      });
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          setErrorMessage(String(squashAtomCommandFailure(result)));
        }
        return;
      }
      toastManager.add({
        type: "success",
        title: gt("Thread handed off"),
        description: gt("Started a new thread on {provider} ({model}).", {
          provider,
          model: trimmedModel,
        }),
      });
      onOpenChange(false);
      onHandoffSuccess?.(result.value.threadId);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <form onSubmit={(event) => void handleSubmit(event)}>
          <DialogHeader>
            <DialogTitle>{gt("Hand off thread")}</DialogTitle>
            <DialogDescription>
              {gt(
                "Continue this conversation in a new thread with a different model using the raw transcript.",
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <label
                  htmlFor="thread-handoff-provider"
                  className="block text-xs font-medium text-foreground"
                >
                  {gt("Target provider")}
                </label>
                <select
                  id="thread-handoff-provider"
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {HANDOFF_PROVIDERS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="thread-handoff-model"
                  className="block text-xs font-medium text-foreground"
                >
                  {gt("Target model")}
                </label>
                <Input
                  id="thread-handoff-model"
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                  placeholder="claude-sonnet-4-6"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <label
                  htmlFor="thread-handoff-mode"
                  className="block text-xs font-medium text-foreground"
                >
                  {gt("Transcript mode")}
                </label>
                <select
                  id="thread-handoff-mode"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as ThreadHandoffMode)}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  <option value="raw">{gt("Raw log (keep truncated tool outputs)")}</option>
                  <option value="compact">
                    {gt("Compact (messages only, drop tool outputs)")}
                  </option>
                </select>
              </div>
              {errorMessage ? (
                <p role="alert" className="text-xs text-destructive">
                  {errorMessage}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              {gt("Cancel")}
            </Button>
            <Button type="submit" disabled={submitting || model.trim().length === 0}>
              {submitting ? gt("Handing off...") : gt("Hand off")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
