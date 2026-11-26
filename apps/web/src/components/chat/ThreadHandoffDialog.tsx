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
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import {
  getDefaultProviderInstanceModel,
  isProviderInstancePickerVisible,
  providerInstanceEntriesFor,
  resolveSelectableProviderInstanceEntry,
} from "../../providerInstances";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
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
  const providersByEnvironment = useEnvironmentProviders();
  const settings = useEnvironmentSettings(threadRef.environmentId);
  const threadShell = useThreadShell(threadRef);
  const providers = providersByEnvironment.get(threadRef.environmentId) ?? [];
  const allEntries = providerInstanceEntriesFor(
    providers,
    settings,
    threadShell?.projectId ?? null,
  );
  const enabledEntries = allEntries.filter(isProviderInstancePickerVisible);
  const providerOptions = enabledEntries.length > 0 ? enabledEntries : allEntries;
  const defaultEntry =
    resolveSelectableProviderInstanceEntry(providerOptions, undefined) ?? providerOptions[0];

  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [modelInput, setModelInput] = useState<string | null>(null);
  const [mode, setMode] = useState<ThreadHandoffMode>("raw");
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const activeProviderEntry =
    providerOptions.find((entry) => entry.instanceId === selectedProviderId) ?? defaultEntry;
  const provider = activeProviderEntry?.instanceId ?? "";
  const defaultModel = activeProviderEntry
    ? (getDefaultProviderInstanceModel(providers, activeProviderEntry.instanceId) ?? "")
    : "";
  const model = modelInput ?? defaultModel;

  const runHandoff = useOrchestrationCommand(threadHandoff, { reportFailure: false });

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmedModel = model.trim();
    if (!provider || !trimmedModel || submitting) return;

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
          commandId: CommandId.make(`handoff-${randomUUID()}`),
          threadId: threadRef.threadId,
          modelSelection,
          mode,
        },
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: gt("Thread handed off"),
          description: gt("Started a new thread on {provider} ({model}).", {
            provider: activeProviderEntry?.displayName ?? provider,
            model: trimmedModel,
          }),
        });
        onOpenChange(false);
        onHandoffSuccess?.(result.value.threadId);
      } else if (!isAtomCommandInterrupted(result)) {
        setErrorMessage(String(squashAtomCommandFailure(result)));
      }
    } catch (error) {
      setSubmitting(false);
      throw error;
    }
    setSubmitting(false);
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
                  onChange={(event) => {
                    setSelectedProviderId(event.target.value);
                    setModelInput(null);
                  }}
                  disabled={providerOptions.length === 0}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                >
                  {providerOptions.map((option) => (
                    <option key={option.instanceId} value={option.instanceId}>
                      {option.displayName}
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
                  onChange={(event) => setModelInput(event.target.value)}
                  placeholder={defaultModel || "claude-sonnet-4-6"}
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
            <Button type="submit" disabled={submitting || !provider || model.trim().length === 0}>
              {submitting ? gt("Handing off...") : gt("Hand off")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
