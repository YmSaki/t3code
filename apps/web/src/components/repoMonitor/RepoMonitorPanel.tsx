import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import {
  buildRepoMonitorRuleToggleInput,
  buildRepoMonitorRuleUpsertFromPreset,
  formatRepoMonitorCommaList,
  parseRepoMonitorCommaList,
  type RepoMonitorPresetView,
} from "@t3tools/client-runtime/state/repoMonitors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
  type EnvironmentId,
  type ProjectId,
  type RepoMonitorActionKind,
  type RepoMonitorEventKind,
  type RepoMonitorRule,
  type RepoMonitorRuleId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { listRepoMonitorPresets } from "@t3tools/shared/repoMonitorPresets.core";
import { useGT } from "gt-react";
import {
  AlertTriangleIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  PowerOffIcon,
  RadarIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { useState } from "react";

import { m as resolveMessage } from "../../i18n/messages";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import {
  repoMonitorEnvironment,
  useRepoMonitorGlobalKillSwitch,
  useRepoMonitorPresets,
  useRepoMonitorRules,
} from "../../state/repoMonitors";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { RepoMonitorDryRunAndLogs } from "./RepoMonitorDryRunAndLogs";

export interface RepoMonitorPanelProps {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly projectId?: ProjectId | null | undefined;
  readonly onOpenThread?: (ref: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}

const EVENT_KINDS: ReadonlyArray<RepoMonitorEventKind> = [
  "branch_push",
  "pr_opened",
  "pr_merged",
  "pr_comment",
  "issue_opened",
  "issue_comment",
];

const ACTION_KINDS: ReadonlyArray<RepoMonitorActionKind> = [
  "notify_pm",
  "launch_thread",
  "send_to_thread",
];

const RUNTIME_MODES: ReadonlyArray<RuntimeMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

interface RuleFormDraft {
  readonly id?: RepoMonitorRuleId | undefined;
  readonly presetId?: string | undefined;
  readonly name: string;
  readonly description: string;
  readonly enabled: boolean;
  readonly eventKinds: ReadonlyArray<RepoMonitorEventKind>;
  readonly branchGlobs: string;
  readonly requiredLabels: string;
  readonly excludedLabels: string;
  readonly allowedAuthors: string;
  readonly excludedAuthors: string;
  readonly excludeBots: boolean;
  readonly keywords: string;
  readonly actionKind: RepoMonitorActionKind;
  readonly targetThreadId: string;
  readonly runtimeMode: RuntimeMode;
  readonly promptTemplate: string;
  readonly cooldownSec: string;
  readonly maxTriggersPerHour: string;
}

function createEmptyRuleDraft(): RuleFormDraft {
  return {
    name: "",
    description: "",
    enabled: true,
    eventKinds: ["pr_comment"],
    branchGlobs: "",
    requiredLabels: "",
    excludedLabels: "",
    allowedAuthors: "",
    excludedAuthors: "",
    excludeBots: true,
    keywords: "",
    actionKind: "launch_thread",
    targetThreadId: "",
    runtimeMode: "auto-accept-edits",
    promptTemplate: "Event {{title}} by {{author}}:\n{{body}}",
    cooldownSec: "60",
    maxTriggersPerHour: "20",
  };
}

function ruleToDraft(rule: RepoMonitorRule): RuleFormDraft {
  return {
    id: rule.id,
    presetId: rule.presetId,
    name: rule.name,
    description: rule.description ?? "",
    enabled: rule.enabled,
    eventKinds: [...rule.eventKinds],
    branchGlobs: formatRepoMonitorCommaList(rule.filter.branchGlobs),
    requiredLabels: formatRepoMonitorCommaList(rule.filter.requiredLabels),
    excludedLabels: formatRepoMonitorCommaList(rule.filter.excludedLabels),
    allowedAuthors: formatRepoMonitorCommaList(rule.filter.allowedAuthors),
    excludedAuthors: formatRepoMonitorCommaList(rule.filter.excludedAuthors),
    excludeBots: rule.filter.excludeBots ?? false,
    keywords: formatRepoMonitorCommaList(rule.filter.keywords),
    actionKind: rule.actionKind,
    targetThreadId: rule.targetThreadId ?? "",
    runtimeMode: rule.runtimeMode ?? "auto-accept-edits",
    promptTemplate: rule.promptTemplate,
    cooldownSec: String(rule.cooldownSec),
    maxTriggersPerHour: String(rule.maxTriggersPerHour),
  };
}

export function RepoMonitorPanel({
  environmentId: propEnvironmentId,
  projectId: propProjectId,
  onOpenThread,
}: RepoMonitorPanelProps) {
  const gt = useGT();
  const settingsScope = useOptionalSettingsScope();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projects = useProjects();

  const scopeEnvId =
    settingsScope?.environment?.environmentId ??
    settingsScope?.connectedEnvironments[0]?.environmentId ??
    null;
  const scopeProjectId =
    settingsScope &&
    (settingsScope.scope.kind === "project" || settingsScope.scope.kind === "checkout")
      ? (settingsScope.scope.members[0]?.id ?? null)
      : null;

  const [manualEnvId, setManualEnvId] = useState<EnvironmentId | null>(null);
  const [manualProjectId, setManualProjectId] = useState<ProjectId | null>(null);

  const activeEnvironmentId =
    propEnvironmentId ??
    manualEnvId ??
    scopeEnvId ??
    primaryEnvironmentId ??
    environments[0]?.environmentId ??
    null;

  const envProjects = projects.filter(
    (project) => activeEnvironmentId !== null && project.environmentId === activeEnvironmentId,
  );

  const activeProjectId =
    propProjectId ??
    (manualProjectId !== null && envProjects.some((p) => p.id === manualProjectId)
      ? manualProjectId
      : null) ??
    scopeProjectId ??
    envProjects[0]?.id ??
    null;

  const [activeTab, setActiveTab] = useState<"rules" | "logs">("rules");
  const [selectedRuleId, setSelectedRuleId] = useState<RepoMonitorRuleId | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState<RuleFormDraft>(createEmptyRuleDraft);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [creatingPresetId, setCreatingPresetId] = useState<string | null>(null);
  const [togglingRuleId, setTogglingRuleId] = useState<string | null>(null);
  const [deletingRuleId, setDeletingRuleId] = useState<string | null>(null);
  const [isTogglingKillSwitch, setIsTogglingKillSwitch] = useState(false);

  const rulesQuery = useRepoMonitorRules(activeEnvironmentId, activeProjectId ?? undefined);
  const presetsQuery = useRepoMonitorPresets(activeEnvironmentId);
  const globalKillSwitch = useRepoMonitorGlobalKillSwitch(activeEnvironmentId);

  const createRule = useAtomCommand(repoMonitorEnvironment.createRule, { reportFailure: false });
  const updateRule = useAtomCommand(repoMonitorEnvironment.updateRule, { reportFailure: false });
  const deleteRule = useAtomCommand(repoMonitorEnvironment.deleteRule, { reportFailure: false });
  const setGlobalKillSwitch = useAtomCommand(repoMonitorEnvironment.setGlobalKillSwitch, {
    reportFailure: false,
  });

  const serverPresets = presetsQuery.data?.presets;
  const presets: ReadonlyArray<RepoMonitorPresetView> =
    serverPresets && serverPresets.length > 0
      ? serverPresets
      : listRepoMonitorPresets().map((preset) => ({
          id: preset.id,
          name: preset.name,
          description: preset.description,
          eventKinds: preset.eventKinds,
          defaultFilter: preset.defaultFilter,
          actionKind: preset.actionKind,
          defaultRuntimeMode: preset.defaultRuntimeMode,
          promptTemplate: preset.promptTemplate,
          defaultCooldownSec: preset.defaultCooldownSec,
          defaultMaxTriggersPerHour: preset.defaultMaxTriggersPerHour,
        }));

  const rules = rulesQuery.data?.rules ?? [];

  const eventKindLabel = (kind: RepoMonitorEventKind): string => {
    switch (kind) {
      case "branch_push":
        return gt("Branch push");
      case "pr_opened":
        return gt("PR opened");
      case "pr_merged":
        return gt("PR merged");
      case "pr_comment":
        return gt("PR comment");
      case "issue_opened":
        return gt("Issue opened");
      case "issue_comment":
        return gt("Issue comment");
    }
  };

  const actionKindLabel = (kind: RepoMonitorActionKind): string => {
    switch (kind) {
      case "notify_pm":
        return gt("Notify PM");
      case "launch_thread":
        return gt("Launch thread");
      case "send_to_thread":
        return gt("Send to thread");
    }
  };

  const runtimeModeLabel = (mode: RuntimeMode): string => {
    switch (mode) {
      case "approval-required":
        return gt("Approval required");
      case "auto-accept-edits":
        return gt("Auto-accept edits");
      case "auto":
        return gt("Auto");
      case "full-access":
        return gt("Full access");
    }
  };

  const handleToggleKillSwitch = async (nextActive: boolean) => {
    if (activeEnvironmentId === null || isTogglingKillSwitch) return;
    setIsTogglingKillSwitch(true);
    const result = await setGlobalKillSwitch({
      environmentId: activeEnvironmentId,
      input: { scope: "global", active: nextActive },
    });
    setIsTogglingKillSwitch(false);
    if (result._tag === "Success") {
      toastManager.add({
        type: nextActive ? "warning" : "success",
        title: nextActive
          ? gt("Global monitor kill switch enabled")
          : gt("Repository monitoring resumed"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title:
          errorDisplayMessage(squashAtomCommandFailure(result), resolveMessage) ??
          gt("Failed to update kill switch."),
      });
    }
  };

  const handleCreateFromPreset = async (preset: RepoMonitorPresetView) => {
    if (activeEnvironmentId === null || activeProjectId === null || creatingPresetId !== null) {
      return;
    }
    setCreatingPresetId(preset.id);
    const result = await createRule({
      environmentId: activeEnvironmentId,
      input: buildRepoMonitorRuleUpsertFromPreset({
        preset,
        projectId: activeProjectId,
        environmentId: activeEnvironmentId,
      }),
    });
    setCreatingPresetId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: gt("Rule created from preset"),
        description: result.value.name,
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title:
          errorDisplayMessage(squashAtomCommandFailure(result), resolveMessage) ||
          gt("Failed to create rule from preset."),
      });
    }
  };

  const handleToggleRuleEnabled = async (rule: RepoMonitorRule, nextEnabled: boolean) => {
    if (activeEnvironmentId === null || togglingRuleId !== null) return;
    setTogglingRuleId(rule.id);
    const result = await updateRule({
      environmentId: activeEnvironmentId,
      input: buildRepoMonitorRuleToggleInput(rule, nextEnabled),
    });
    setTogglingRuleId(null);
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: nextEnabled ? gt("Rule enabled") : gt("Rule paused"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title:
          errorDisplayMessage(squashAtomCommandFailure(result), resolveMessage) ??
          gt("Failed to update rule."),
      });
    }
  };

  const handleDeleteRule = async (rule: RepoMonitorRule) => {
    if (activeEnvironmentId === null || deletingRuleId !== null) return;
    setDeletingRuleId(rule.id);
    const result = await deleteRule({
      environmentId: activeEnvironmentId,
      input: { id: rule.id },
    });
    setDeletingRuleId(null);
    if (result._tag === "Success") {
      if (selectedRuleId === rule.id) setSelectedRuleId(null);
      toastManager.add({
        type: "success",
        title: gt("Rule deleted"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title:
          errorDisplayMessage(squashAtomCommandFailure(result), resolveMessage) ??
          gt("Failed to delete rule."),
      });
    }
  };

  const openCreateDialog = () => {
    setDraft(createEmptyRuleDraft());
    setFormError(null);
    setEditorOpen(true);
  };

  const openEditDialog = (rule: RepoMonitorRule) => {
    setDraft(ruleToDraft(rule));
    setFormError(null);
    setEditorOpen(true);
  };

  const toggleDraftEventKind = (kind: RepoMonitorEventKind, checked: boolean) => {
    setDraft((current) => {
      const next = checked
        ? current.eventKinds.includes(kind)
          ? current.eventKinds
          : [...current.eventKinds, kind]
        : current.eventKinds.filter((k) => k !== kind);
      return { ...current, eventKinds: next };
    });
  };

  const handleSaveRule = async () => {
    if (activeEnvironmentId === null || activeProjectId === null || isSaving) return;
    const trimmedName = draft.name.trim();
    const trimmedPrompt = draft.promptTemplate.trim();
    if (trimmedName.length === 0) {
      setFormError(gt("Rule name is required."));
      return;
    }
    if (draft.eventKinds.length === 0) {
      setFormError(gt("Select at least one event kind."));
      return;
    }
    if (trimmedPrompt.length === 0) {
      setFormError(gt("Prompt template is required."));
      return;
    }

    const parsedCooldown = Number.parseInt(draft.cooldownSec, 10);
    const cooldownSec = Number.isFinite(parsedCooldown) && parsedCooldown >= 0 ? parsedCooldown : 0;
    const parsedMaxPerHour = Number.parseInt(draft.maxTriggersPerHour, 10);
    const maxTriggersPerHour =
      Number.isFinite(parsedMaxPerHour) && parsedMaxPerHour >= 1 ? parsedMaxPerHour : 1;

    const branchGlobs = parseRepoMonitorCommaList(draft.branchGlobs);
    const requiredLabels = parseRepoMonitorCommaList(draft.requiredLabels);
    const excludedLabels = parseRepoMonitorCommaList(draft.excludedLabels);
    const allowedAuthors = parseRepoMonitorCommaList(draft.allowedAuthors);
    const excludedAuthors = parseRepoMonitorCommaList(draft.excludedAuthors);
    const keywords = parseRepoMonitorCommaList(draft.keywords);
    const trimmedThreadId = draft.targetThreadId.trim();

    setFormError(null);
    setIsSaving(true);
    const command = draft.id === undefined ? createRule : updateRule;
    const result = await command({
      environmentId: activeEnvironmentId,
      input: {
        ...(draft.id === undefined ? {} : { id: draft.id }),
        projectId: activeProjectId,
        environmentId: activeEnvironmentId,
        name: TrimmedNonEmptyString.make(trimmedName),
        ...(draft.description.trim().length > 0 ? { description: draft.description.trim() } : {}),
        enabled: draft.enabled,
        eventKinds: draft.eventKinds,
        filter: {
          ...(branchGlobs === undefined ? {} : { branchGlobs }),
          ...(requiredLabels === undefined ? {} : { requiredLabels }),
          ...(excludedLabels === undefined ? {} : { excludedLabels }),
          ...(allowedAuthors === undefined ? {} : { allowedAuthors }),
          ...(excludedAuthors === undefined ? {} : { excludedAuthors }),
          excludeBots: draft.excludeBots,
          ...(keywords === undefined ? {} : { keywords }),
        },
        actionKind: draft.actionKind,
        targetThreadId: trimmedThreadId.length > 0 ? ThreadId.make(trimmedThreadId) : null,
        runtimeMode: draft.runtimeMode,
        promptTemplate: TrimmedNonEmptyString.make(trimmedPrompt),
        cooldownSec: NonNegativeInt.make(cooldownSec),
        maxTriggersPerHour: PositiveInt.make(maxTriggersPerHour),
        ...(draft.presetId ? { presetId: TrimmedNonEmptyString.make(draft.presetId) } : {}),
      },
    });
    setIsSaving(false);

    if (result._tag === "Success") {
      setEditorOpen(false);
      toastManager.add({
        type: "success",
        title: draft.id === undefined ? gt("Monitor rule created") : gt("Monitor rule updated"),
      });
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setFormError(
        errorDisplayMessage(squashAtomCommandFailure(result), resolveMessage) ??
          gt("Failed to save monitor rule."),
      );
    }
  };

  if (activeEnvironmentId === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <RadarIcon />
          </EmptyMedia>
          <EmptyTitle>{gt("No connected environment")}</EmptyTitle>
          <EmptyDescription>
            {gt("Connect an environment to configure repository monitoring rules.")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const activeProjectName =
    envProjects.find((p) => p.id === activeProjectId)?.title ??
    (activeProjectId ? activeProjectId : gt("All projects"));

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/40 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <RadarIcon className="size-4 shrink-0 text-primary" />
            <h2 className="text-base font-semibold text-foreground">{gt("Repository monitors")}</h2>
          </div>
          <p className="text-xs text-muted-foreground">
            {gt("Automate reactions to branch pushes, pull request reviews, and new issues.")}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {propEnvironmentId === undefined && environments.length > 1 ? (
            <Select
              value={activeEnvironmentId}
              onValueChange={(value) => {
                if (value !== null) {
                  setManualEnvId(value as EnvironmentId);
                  setManualProjectId(null);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-40">
                <SelectValue>
                  {environments.find((e) => e.environmentId === activeEnvironmentId)?.label ??
                    activeEnvironmentId}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {environments.map((env) => (
                  <SelectItem key={env.environmentId} value={env.environmentId}>
                    {env.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}

          {propProjectId === undefined && envProjects.length > 0 ? (
            <Select
              value={activeProjectId ?? ""}
              onValueChange={(value) => {
                if (value !== null && value.length > 0) {
                  setManualProjectId(value as ProjectId);
                }
              }}
            >
              <SelectTrigger size="sm" className="w-44">
                <SelectValue>{activeProjectName}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {envProjects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null}

          <Button
            size="sm"
            variant={globalKillSwitch ? "destructive" : "outline"}
            disabled={isTogglingKillSwitch}
            onClick={() => void handleToggleKillSwitch(!globalKillSwitch)}
          >
            <PowerOffIcon />
            {globalKillSwitch ? gt("Resume monitors") : gt("Kill switch")}
          </Button>

          <Button size="sm" disabled={activeProjectId === null} onClick={openCreateDialog}>
            <PlusIcon />
            {gt("New rule")}
          </Button>
        </div>
      </div>

      {globalKillSwitch ? (
        <Alert variant="warning">
          <AlertTriangleIcon />
          <AlertTitle>{gt("Global monitor kill switch is active")}</AlertTitle>
          <AlertDescription>
            {gt(
              "All automatic repository monitor triggers are paused until you resume monitoring.",
            )}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              disabled={isTogglingKillSwitch}
              onClick={() => void handleToggleKillSwitch(false)}
            >
              {gt("Resume")}
            </Button>
          </AlertAction>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <ToggleGroup
          value={[activeTab]}
          onValueChange={(next) => {
            const picked = next[0];
            if (picked === "rules" || picked === "logs") {
              setActiveTab(picked);
            }
          }}
        >
          <Toggle value="rules">{gt("Rules ({count})", { count: rules.length })}</Toggle>
          <Toggle value="logs">{gt("Dry run & logs")}</Toggle>
        </ToggleGroup>
      </div>

      {activeTab === "rules" ? (
        <div className="space-y-5">
          <div className="space-y-2.5">
            <div className="flex items-center gap-1.5">
              <ZapIcon className="size-3.5 text-primary" />
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {gt("One-click presets")}
              </h3>
            </div>
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
              {presets.map((preset) => (
                <div
                  key={preset.id}
                  className="flex flex-col justify-between gap-2.5 rounded-xl border border-border/60 bg-card/40 p-3"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">{preset.name}</span>
                      <Badge variant="outline" size="sm">
                        {actionKindLabel(preset.actionKind)}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">{preset.description}</p>
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex flex-wrap gap-1">
                      {preset.eventKinds.map((kind) => (
                        <Badge key={kind} variant="secondary" size="sm">
                          {eventKindLabel(kind)}
                        </Badge>
                      ))}
                    </div>
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={activeProjectId === null || creatingPresetId !== null}
                      onClick={() => void handleCreateFromPreset(preset)}
                    >
                      {creatingPresetId === preset.id ? (
                        <Spinner className="size-3" />
                      ) : (
                        <PlusIcon />
                      )}
                      {gt("Add preset")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {rulesQuery.error ? (
            <Alert variant="error">
              <AlertTitle>{gt("Failed to load monitor rules")}</AlertTitle>
              <AlertDescription>{rulesQuery.error}</AlertDescription>
            </Alert>
          ) : null}

          {rulesQuery.isPending && rules.length === 0 ? (
            <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
              <Spinner className="size-4" />
              <span>{gt("Loading monitor rules...")}</span>
            </div>
          ) : rules.length === 0 ? (
            <Empty size="compact">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <RadarIcon />
                </EmptyMedia>
                <EmptyTitle>{gt("No monitor rules configured")}</EmptyTitle>
                <EmptyDescription>
                  {gt("Add a preset above or create a custom rule to monitor repository activity.")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <div className="space-y-2.5">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className="flex flex-col gap-3 rounded-xl border border-border/60 bg-card/50 p-3.5"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{rule.name}</span>
                        <Badge variant={rule.enabled ? "success" : "secondary"} size="sm">
                          {rule.enabled ? gt("Active") : gt("Paused")}
                        </Badge>
                        <Badge variant="outline" size="sm">
                          {actionKindLabel(rule.actionKind)}
                        </Badge>
                      </div>

                      {rule.description ? (
                        <p className="text-xs text-muted-foreground">{rule.description}</p>
                      ) : null}

                      <div className="flex flex-wrap items-center gap-1.5">
                        {rule.eventKinds.map((kind) => (
                          <Badge key={kind} variant="secondary" size="sm">
                            {eventKindLabel(kind)}
                          </Badge>
                        ))}
                        {rule.filter.branchGlobs && rule.filter.branchGlobs.length > 0 ? (
                          <Badge variant="outline" size="sm">
                            {gt("Branches")}: {rule.filter.branchGlobs.join(", ")}
                          </Badge>
                        ) : null}
                        {rule.filter.excludeBots ? (
                          <Badge variant="outline" size="sm">
                            {gt("Bots excluded")}
                          </Badge>
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {gt("Cooldown {sec}s / {max} per hour", {
                            sec: rule.cooldownSec,
                            max: rule.maxTriggersPerHour,
                          })}
                        </span>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <Switch
                        size="sm"
                        aria-label={gt("Toggle rule {name}", { name: rule.name })}
                        checked={rule.enabled}
                        disabled={togglingRuleId === rule.id}
                        onCheckedChange={(checked) => void handleToggleRuleEnabled(rule, checked)}
                      />

                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setSelectedRuleId(rule.id);
                          setActiveTab("logs");
                        }}
                      >
                        <PlayIcon />
                        {gt("Dry run")}
                      </Button>

                      <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label={gt("Edit rule {name}", { name: rule.name })}
                        onClick={() => openEditDialog(rule)}
                      >
                        <PencilIcon />
                      </Button>

                      <Button
                        size="icon-xs"
                        variant="ghost-destructive"
                        aria-label={gt("Delete rule {name}", { name: rule.name })}
                        disabled={deletingRuleId === rule.id}
                        onClick={() => void handleDeleteRule(rule)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <RepoMonitorDryRunAndLogs
          environmentId={activeEnvironmentId}
          projectId={activeProjectId}
          rules={rules}
          selectedRuleId={selectedRuleId}
          onSelectRuleId={setSelectedRuleId}
          {...(onOpenThread === undefined ? {} : { onOpenThread })}
        />
      )}

      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogPopup className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {draft.id === undefined ? gt("Create monitor rule") : gt("Edit monitor rule")}
            </DialogTitle>
            <DialogDescription>
              {gt(
                "Define repository events, filter conditions, rate limits, and prompt templates.",
              )}
            </DialogDescription>
          </DialogHeader>

          <DialogPanel>
            <div className="space-y-4">
              {formError ? (
                <Alert variant="error">
                  <AlertDescription>{formError}</AlertDescription>
                </Alert>
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{gt("Rule name")}</Label>
                  <Input
                    value={draft.name}
                    placeholder={gt("Auto respond to PR review comments")}
                    onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Description")}</Label>
                  <Input
                    value={draft.description}
                    placeholder={gt("Optional summary of what this rule handles")}
                    onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>{gt("Event kinds")}</Label>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {EVENT_KINDS.map((kind) => (
                    <Label key={kind}>
                      <Checkbox
                        checked={draft.eventKinds.includes(kind)}
                        onCheckedChange={(checked) => toggleDraftEventKind(kind, checked === true)}
                      />
                      <span className="text-xs font-normal">{eventKindLabel(kind)}</span>
                    </Label>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{gt("Action")}</Label>
                  <Select
                    value={draft.actionKind}
                    onValueChange={(value) => {
                      if (value !== null) {
                        setDraft({ ...draft, actionKind: value as RepoMonitorActionKind });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>{actionKindLabel(draft.actionKind)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {ACTION_KINDS.map((kind) => (
                        <SelectItem key={kind} value={kind}>
                          {actionKindLabel(kind)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Runtime mode")}</Label>
                  <Select
                    value={draft.runtimeMode}
                    onValueChange={(value) => {
                      if (value !== null) {
                        setDraft({ ...draft, runtimeMode: value as RuntimeMode });
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue>{runtimeModeLabel(draft.runtimeMode)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {RUNTIME_MODES.map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {runtimeModeLabel(mode)}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>

              {draft.actionKind !== "launch_thread" ? (
                <div className="space-y-1.5">
                  <Label>{gt("Target thread ID (optional)")}</Label>
                  <Input
                    value={draft.targetThreadId}
                    placeholder={gt("Leave empty to resolve PM thread automatically")}
                    onChange={(event) => setDraft({ ...draft, targetThreadId: event.target.value })}
                  />
                </div>
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>{gt("Branch globs (comma-separated)")}</Label>
                  <Input
                    value={draft.branchGlobs}
                    placeholder={gt("main, feature/**")}
                    onChange={(event) => setDraft({ ...draft, branchGlobs: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Keywords (comma-separated)")}</Label>
                  <Input
                    value={draft.keywords}
                    placeholder={gt("security, urgent")}
                    onChange={(event) => setDraft({ ...draft, keywords: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Required labels")}</Label>
                  <Input
                    value={draft.requiredLabels}
                    placeholder={gt("bug, triage")}
                    onChange={(event) => setDraft({ ...draft, requiredLabels: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Excluded labels")}</Label>
                  <Input
                    value={draft.excludedLabels}
                    placeholder={gt("wontfix, duplicate")}
                    onChange={(event) => setDraft({ ...draft, excludedLabels: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Allowed authors")}</Label>
                  <Input
                    value={draft.allowedAuthors}
                    placeholder={gt("alice, bob")}
                    onChange={(event) => setDraft({ ...draft, allowedAuthors: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Excluded authors")}</Label>
                  <Input
                    value={draft.excludedAuthors}
                    placeholder={gt("noisy-user")}
                    onChange={(event) =>
                      setDraft({ ...draft, excludedAuthors: event.target.value })
                    }
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="space-y-1.5">
                  <Label>{gt("Cooldown (seconds)")}</Label>
                  <Input
                    type="number"
                    min={0}
                    value={draft.cooldownSec}
                    onChange={(event) => setDraft({ ...draft, cooldownSec: event.target.value })}
                  />
                </div>

                <div className="space-y-1.5">
                  <Label>{gt("Max triggers per hour")}</Label>
                  <Input
                    type="number"
                    min={1}
                    value={draft.maxTriggersPerHour}
                    onChange={(event) =>
                      setDraft({ ...draft, maxTriggersPerHour: event.target.value })
                    }
                  />
                </div>

                <div className="flex items-end pb-1.5">
                  <Label>
                    <Switch
                      size="sm"
                      checked={draft.excludeBots}
                      onCheckedChange={(checked) => setDraft({ ...draft, excludeBots: checked })}
                    />
                    <span className="text-xs font-normal">{gt("Exclude bots")}</span>
                  </Label>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label>{gt("Prompt template")}</Label>
                <Textarea
                  rows={5}
                  value={draft.promptTemplate}
                  onChange={(event) => setDraft({ ...draft, promptTemplate: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {gt(
                    "Placeholders like {{title}}, {{body}}, {{author}}, {{branch}}, {{pr.number}}, {{issue.key}}, and {{url}} are framed as untrusted data.",
                  )}
                </p>
              </div>
            </div>
          </DialogPanel>

          <DialogFooter>
            <DialogClose render={<Button variant="outline">{gt("Cancel")}</Button>} />
            <Button disabled={isSaving} onClick={() => void handleSaveRule()}>
              {isSaving ? <Spinner className="size-3.5" /> : null}
              {draft.id === undefined ? gt("Create rule") : gt("Save changes")}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
