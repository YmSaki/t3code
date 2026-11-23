import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  MetaProject,
  MetaProjectId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type {
  RollupIssueEntry,
  RollupPullRequestEntry,
  RollupThreadEntry,
} from "@t3tools/shared/metaProjectRollup.core";
import { useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  AlertCircleIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  LayersIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  RefreshCwIcon,
  SaveIcon,
  Trash2Icon,
  UploadIcon,
  RadarIcon,
} from "lucide-react";
import { useState } from "react";

import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import {
  metaProjectEnvironment,
  useMetaProject,
  useMetaProjectRollup,
} from "../../state/metaProjects";
import { useAtomCommand } from "../../state/use-atom-command";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { UnifiedImportWizard } from "../import/UnifiedImportWizard";
import { PmSessionLaunchButton } from "../pm/PmLaunchControls";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { RepoMonitorPanel } from "../repoMonitor/RepoMonitorPanel";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Separator } from "../ui/separator";
import { Spinner } from "../ui/spinner";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { MetaProjectDialog, type MetaProjectAppearancePreference } from "./MetaProjectDialog";

export type MetaProjectDashboardTab =
  | "threads"
  | "pull_requests"
  | "issues"
  | "monitors"
  | "import";

export interface MetaProjectDashboardProps {
  readonly environmentId: EnvironmentId | null;
  readonly metaProjectId: MetaProjectId;
  readonly onOpenThread?: (ref: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => void;
  readonly onOpenProject?: (ref: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => void;
  readonly onDeleted?: (metaProjectId: MetaProjectId) => void;
}

function threadStatusVariant(status: RollupThreadEntry["status"]) {
  switch (status) {
    case "waiting_approval":
      return "warning" as const;
    case "waiting_input":
      return "info" as const;
    case "error":
      return "error" as const;
    case "running":
      return "success" as const;
    case "idle":
    case "settled":
      return "secondary" as const;
  }
}

function threadStatusLabel(
  status: RollupThreadEntry["status"],
  gt: ReturnType<typeof useGT>,
): string {
  switch (status) {
    case "waiting_approval":
      return gt("Waiting Approval");
    case "waiting_input":
      return gt("Waiting Input");
    case "error":
      return gt("Error");
    case "running":
      return gt("Running");
    case "idle":
      return gt("Idle");
    case "settled":
      return gt("Settled");
  }
}

function threadRoleLabel(role: RollupThreadEntry["role"], gt: ReturnType<typeof useGT>): string {
  switch (role) {
    case "pm":
      return gt("PM");
    case "cross_cutting":
      return gt("Cross-Cutting");
    case "standard":
      return gt("Thread");
  }
}

function prChecksVariant(checksState: RollupPullRequestEntry["checksState"]) {
  switch (checksState) {
    case "passing":
      return "success" as const;
    case "failing":
      return "error" as const;
    case "pending":
      return "warning" as const;
    default:
      return "secondary" as const;
  }
}

function prChecksLabel(
  checksState: RollupPullRequestEntry["checksState"],
  gt: ReturnType<typeof useGT>,
): string {
  switch (checksState) {
    case "passing":
      return gt("Checks passing");
    case "failing":
      return gt("Checks failing");
    case "pending":
      return gt("Checks pending");
    default:
      return gt("Checks unknown");
  }
}

export function MetaProjectDashboard(props: MetaProjectDashboardProps) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const navigate = useNavigate();
  const handleNewThread = useNewThreadHandler();

  const metaProjectQuery = useMetaProject(props.environmentId, props.metaProjectId, {
    includeArchived: true,
  });
  const rollupQuery = useMetaProjectRollup(props.environmentId, props.metaProjectId);

  const updateMetaProject = useAtomCommand(metaProjectEnvironment.update, {
    reportFailure: false,
  });
  const removeMember = useAtomCommand(metaProjectEnvironment.removeMember, {
    reportFailure: false,
  });
  const deleteMetaProject = useAtomCommand(metaProjectEnvironment.delete, {
    reportFailure: false,
  });

  const [activeTab, setActiveTab] = useState<MetaProjectDashboardTab>("threads");
  const [editOpen, setEditOpen] = useState(false);
  const [appearance, setAppearance] = useState<MetaProjectAppearancePreference>({
    icon: "layers",
    color: "default",
  });
  const [instructionsDraft, setInstructionsDraft] = useState<string | null>(null);
  const [savingInstructions, setSavingInstructions] = useState(false);
  const [togglingPin, setTogglingPin] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [monitorMemberKey, setMonitorMemberKey] = useState<string | null>(null);

  if (props.environmentId === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>
              <T>No hub environment connected</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>Connect to a T3 environment to view and manage Meta-Projects.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  if (metaProjectQuery.isPending && metaProjectQuery.data === null) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
        <Spinner />
        <span>
          <T>Loading Meta-Project...</T>
        </span>
      </div>
    );
  }

  if (metaProjectQuery.error !== null && metaProjectQuery.data === null) {
    return (
      <div className="mx-auto max-w-3xl p-6">
        <Alert variant="error">
          <AlertCircleIcon />
          <AlertTitle>
            <T>Could not load Meta-Project</T>
          </AlertTitle>
          <AlertDescription>{metaProjectQuery.error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  const metaProject = metaProjectQuery.data;
  if (metaProject === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LayersIcon />
            </EmptyMedia>
            <EmptyTitle>
              <T>Meta-Project not found</T>
            </EmptyTitle>
            <EmptyDescription>
              <T>It may have been deleted or belongs to another environment.</T>
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  const envById = new Map(environments.map((env) => [env.environmentId, env] as const));
  const projectByKey = new Map(
    allProjects.map((project) => [`${project.environmentId}\u0000${project.id}`, project] as const),
  );

  const effectiveInstructions = instructionsDraft ?? metaProject.instructionsMd;
  const instructionsDirty =
    instructionsDraft !== null && instructionsDraft !== metaProject.instructionsMd;

  const rollup = rollupQuery.data;
  const prCount = rollup?.counts.pullRequests.open ?? 0;
  const issueCount = rollup?.counts.issues.open ?? 0;
  const activeThreadCount = rollup?.counts.threads.active ?? 0;

  const handleSaveInstructions = async () => {
    if (props.environmentId === null || !instructionsDirty) return;
    setSavingInstructions(true);
    const result = await updateMetaProject({
      environmentId: props.environmentId,
      input: {
        metaProjectId: metaProject.id,
        instructionsMd: effectiveInstructions,
      },
    });
    setSavingInstructions(false);
    if (result._tag === "Failure") {
      const squashed = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to save instructions"),
        description: squashed instanceof Error ? squashed.message : gt("Please try again."),
      });
      return;
    }
    setInstructionsDraft(null);
    toastManager.add({
      type: "success",
      title: gt("Instructions saved"),
    });
  };

  const handleTogglePin = async () => {
    if (props.environmentId === null) return;
    setTogglingPin(true);
    const result = await updateMetaProject({
      environmentId: props.environmentId,
      input: {
        metaProjectId: metaProject.id,
        pinned: metaProject.pinnedAt === null,
      },
    });
    setTogglingPin(false);
    if (result._tag === "Failure") {
      const squashed = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to update pin state"),
        description: squashed instanceof Error ? squashed.message : gt("Please try again."),
      });
    }
  };

  const handleRemoveMember = async (environmentId: EnvironmentId, projectId: ProjectId) => {
    if (props.environmentId === null) return;
    const result = await removeMember({
      environmentId: props.environmentId,
      input: {
        metaProjectId: metaProject.id,
        environmentId,
        projectId,
      },
    });
    if (result._tag === "Failure") {
      const squashed = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to remove repository"),
        description: squashed instanceof Error ? squashed.message : gt("Please try again."),
      });
    }
  };

  const handleDeleteMetaProject = async () => {
    if (props.environmentId === null) return;
    setDeleting(true);
    const result = await deleteMetaProject({
      environmentId: props.environmentId,
      input: { metaProjectId: metaProject.id },
    });
    setDeleting(false);
    if (result._tag === "Failure") {
      const squashed = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: gt("Failed to delete Meta-Project"),
        description: squashed instanceof Error ? squashed.message : gt("Please try again."),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Meta-Project deleted"),
    });
    props.onDeleted?.(metaProject.id);
  };

  const uniqueMemberEnvIds = [
    ...new Set(metaProject.members.map((member) => member.environmentId)),
  ];

  const PullRequestIcon = PullRequestGlyph.pullRequest;
  const memberKey = (member: MetaProject["members"][number]) =>
    `${member.environmentId}:${member.projectId}`;
  const monitorMember =
    metaProject.members.find((member) => memberKey(member) === monitorMemberKey) ??
    metaProject.members[0] ??
    null;
  const pmLaunchMember = metaProject.members[0] ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto scrollbar-gutter-both bg-background">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
        <header className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between sm:p-5">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={appearance.color} size="default">
                <LayersIcon className="size-3.5" />
                <span>{gt("Workspace")}</span>
              </Badge>
              {metaProject.pinnedAt !== null ? (
                <Badge variant="outline" size="sm">
                  <PinIcon className="size-3" />
                  <span>{gt("Pinned")}</span>
                </Badge>
              ) : null}
              {metaProject.archivedAt !== null ? (
                <Badge variant="secondary" size="sm">
                  {gt("Archived")}
                </Badge>
              ) : null}
            </div>

            <h1 className="truncate text-xl font-semibold text-foreground">{metaProject.title}</h1>
            {metaProject.description ? (
              <p className="text-sm text-muted-foreground">{metaProject.description}</p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 pt-1 text-xs text-muted-foreground">
              <span>{gt("{count} repositories", { count: metaProject.members.length })}</span>
              {uniqueMemberEnvIds.map((envId) => {
                const env = envById.get(envId);
                return (
                  <Badge key={envId} variant="outline" size="sm">
                    <EnvironmentMachineIcon kind="server" className="size-3" />
                    <span>{env?.label ?? envId}</span>
                  </Badge>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <PmSessionLaunchButton
              metaProjectId={metaProject.id}
              metaProjectName={metaProject.title}
              disabled={pmLaunchMember === null}
              onLaunchPmSession={async () => {
                if (pmLaunchMember === null) return;
                await handleNewThread(
                  scopeProjectRef(pmLaunchMember.environmentId, pmLaunchMember.projectId),
                );
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={togglingPin}
              onClick={() => void handleTogglePin()}
            >
              <PinIcon className="size-4" />
              {metaProject.pinnedAt !== null ? gt("Unpin") : gt("Pin")}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditOpen(true)}>
              <PencilIcon className="size-4" />
              <T>Edit</T>
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={gt("Refresh workspace")}
              onClick={() => {
                metaProjectQuery.refresh();
                rollupQuery.refresh();
              }}
            >
              <RefreshCwIcon className="size-4" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost-destructive"
              aria-label={gt("Delete Meta-Project")}
              disabled={deleting}
              onClick={() => void handleDeleteMetaProject()}
            >
              <Trash2Icon className="size-4" />
            </Button>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-6 lg:grid-cols-5">
          <div className="space-y-3 rounded-xl border border-border bg-card p-4 lg:col-span-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-sm font-semibold text-foreground">
                  <T>Shared Handbook (instructions_md)</T>
                </h2>
                <p className="text-xs text-muted-foreground">
                  <T>Injected into agents and PM threads working inside this Meta-Project.</T>
                </p>
              </div>
              <div className="flex items-center gap-2">
                {instructionsDirty ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={savingInstructions}
                    onClick={() => setInstructionsDraft(null)}
                  >
                    <T>Discard</T>
                  </Button>
                ) : null}
                <Button
                  size="xs"
                  disabled={!instructionsDirty || savingInstructions}
                  onClick={() => void handleSaveInstructions()}
                >
                  <SaveIcon className="size-3.5" />
                  {savingInstructions ? gt("Saving...") : gt("Save Handbook")}
                </Button>
              </div>
            </div>

            <Textarea
              rows={8}
              value={effectiveInstructions}
              onChange={(event) => setInstructionsDraft(event.target.value)}
              placeholder={gt(
                "Describe cross-repo conventions, contract boundaries, deployment sequence, and verification commands...",
              )}
            />
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{gt("{count} characters", { count: effectiveInstructions.length })}</span>
              {instructionsDirty ? (
                <Badge variant="warning" size="sm">
                  {gt("Unsaved changes")}
                </Badge>
              ) : null}
            </div>
          </div>

          <div className="space-y-3 rounded-xl border border-border bg-card p-4 lg:col-span-2">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">
                <T>Member Repositories</T>
              </h2>
              <Button size="xs" variant="outline" onClick={() => setEditOpen(true)}>
                <T>Manage</T>
              </Button>
            </div>

            {metaProject.members.length === 0 ? (
              <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                <T>No repositories assigned yet. Click Manage to attach repositories.</T>
              </p>
            ) : (
              <div className="space-y-2">
                {metaProject.members.map((member) => {
                  const env = envById.get(member.environmentId);
                  const physical = projectByKey.get(
                    `${member.environmentId}\u0000${member.projectId}`,
                  );
                  const displayTitle = member.label ?? physical?.title ?? member.projectId;
                  return (
                    <div
                      key={`${member.environmentId}:${member.projectId}`}
                      className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-background px-3 py-2"
                    >
                      <button
                        type="button"
                        onClick={() =>
                          props.onOpenProject?.({
                            environmentId: member.environmentId,
                            projectId: member.projectId,
                          })
                        }
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                      >
                        <FolderGit2Icon className="size-4 shrink-0 text-muted-foreground" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-foreground">
                            {displayTitle}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {env?.label ?? member.environmentId}
                            {physical ? ` · ${physical.workspaceRoot}` : ""}
                          </span>
                        </span>
                      </button>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <Badge variant="outline" size="sm">
                          {member.role}
                        </Badge>
                        <Button
                          size="icon-tiny"
                          variant="ghost"
                          aria-label={gt("Remove repository")}
                          onClick={() =>
                            void handleRemoveMember(member.environmentId, member.projectId)
                          }
                        >
                          <Trash2Icon className="size-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <Separator />

        <section className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <ToggleGroup
              value={[activeTab]}
              onValueChange={(values) => {
                const next = values[0];
                if (next !== undefined) {
                  setActiveTab(next as MetaProjectDashboardTab);
                }
              }}
              className="flex-wrap"
            >
              <Toggle value="threads" size="sm">
                <MessageSquareIcon className="size-3.5" />
                <span>{gt("Active Threads ({count})", { count: activeThreadCount })}</span>
              </Toggle>
              <Toggle value="pull_requests" size="sm">
                <PullRequestIcon className="size-3.5" />
                <span>{gt("Pull Requests ({count})", { count: prCount })}</span>
              </Toggle>
              <Toggle value="issues" size="sm">
                <AlertCircleIcon className="size-3.5" />
                <span>{gt("Issues ({count})", { count: issueCount })}</span>
              </Toggle>
              <Toggle value="monitors" size="sm">
                <RadarIcon className="size-3.5" />
                <span>{gt("Repo Monitors")}</span>
              </Toggle>
              <Toggle value="import" size="sm">
                <UploadIcon className="size-3.5" />
                <span>{gt("Import Sessions")}</span>
              </Toggle>
            </ToggleGroup>

            {rollupQuery.isPending ? (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Spinner />
                <T>Refreshing rollup...</T>
              </span>
            ) : null}
          </div>

          {rollupQuery.error !== null ? (
            <Alert variant="warning">
              <AlertCircleIcon />
              <AlertTitle>
                <T>Partial rollup data</T>
              </AlertTitle>
              <AlertDescription>{rollupQuery.error}</AlertDescription>
            </Alert>
          ) : null}

          {activeTab === "threads" ? (
            <div className="space-y-2">
              {rollup === null || rollup.activeThreads.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  <T>No active threads across this Meta-Project right now.</T>
                </p>
              ) : (
                rollup.activeThreads.map((thread: RollupThreadEntry) => {
                  const env = envById.get(thread.environmentId);
                  return (
                    <button
                      key={thread.canonicalKey}
                      type="button"
                      onClick={() =>
                        props.onOpenThread?.({
                          environmentId: thread.environmentId,
                          projectId: thread.projectId,
                          threadId: thread.threadId,
                        })
                      }
                      className="flex w-full flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-accent/40"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium text-foreground">
                            {thread.title}
                          </span>
                          <Badge variant={thread.role === "pm" ? "info" : "outline"} size="sm">
                            {threadRoleLabel(thread.role, gt)}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {env?.label ?? thread.environmentId}
                        </p>
                      </div>
                      <Badge variant={threadStatusVariant(thread.status)} size="sm">
                        {threadStatusLabel(thread.status, gt)}
                      </Badge>
                    </button>
                  );
                })
              )}
            </div>
          ) : null}

          {activeTab === "pull_requests" ? (
            <div className="space-y-2">
              {rollup === null || rollup.pullRequests.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  <T>No pull requests collected from member repositories.</T>
                </p>
              ) : (
                rollup.pullRequests.map((pr: RollupPullRequestEntry) => (
                  <div
                    key={pr.canonicalKey}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                          #{pr.number}
                        </span>
                        <span className="truncate text-sm font-medium text-foreground">
                          {pr.title}
                        </span>
                        {pr.isDraft ? (
                          <Badge variant="secondary" size="sm">
                            {gt("Draft")}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {pr.repository} · {pr.host}
                        {pr.sources.length > 1
                          ? ` · ${gt("{count} environments", { count: pr.sources.length })}`
                          : ""}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {pr.mergeability === "conflicting" ? (
                        <Badge variant="error" size="sm">
                          {gt("Conflicts")}
                        </Badge>
                      ) : null}
                      <Badge variant={prChecksVariant(pr.checksState)} size="sm">
                        {prChecksLabel(pr.checksState, gt)}
                      </Badge>
                      <a
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <span>{gt("Open")}</span>
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {activeTab === "issues" ? (
            <div className="space-y-2">
              {rollup === null || rollup.issues.length === 0 ? (
                <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  <T>No issues collected from member repositories.</T>
                </p>
              ) : (
                rollup.issues.map((issue: RollupIssueEntry) => (
                  <div
                    key={issue.canonicalKey}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3"
                  >
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs font-mono text-muted-foreground">
                          {issue.displayKey}
                        </span>
                        <span className="truncate text-sm font-medium text-foreground">
                          {issue.title}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {issue.tracker} · {issue.scope}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {issue.isAssignedToViewer ? (
                        <Badge variant="info" size="sm">
                          {gt("Assigned")}
                        </Badge>
                      ) : null}
                      {issue.isMentioned ? (
                        <Badge variant="secondary" size="sm">
                          {gt("Mentioned")}
                        </Badge>
                      ) : null}
                      <a
                        href={issue.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                      >
                        <span>{gt("Open")}</span>
                        <ExternalLinkIcon className="size-3" />
                      </a>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : null}

          {activeTab === "monitors" ? (
            monitorMember === null ? (
              <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                <T>Add a repository to this Meta-Project to configure repo monitors.</T>
              </p>
            ) : (
              <div className="space-y-3">
                {metaProject.members.length > 1 ? (
                  <ToggleGroup
                    value={[memberKey(monitorMember)]}
                    onValueChange={(values) => {
                      const next = values[0];
                      if (next !== undefined) setMonitorMemberKey(next);
                    }}
                    className="flex-wrap"
                  >
                    {metaProject.members.map((member) => (
                      <Toggle key={memberKey(member)} value={memberKey(member)} size="sm">
                        <FolderGit2Icon className="size-3.5" />
                        <span>
                          {member.label ??
                            projectByKey.get(`${member.environmentId}\u0000${member.projectId}`)
                              ?.title ??
                            member.projectId}
                        </span>
                      </Toggle>
                    ))}
                  </ToggleGroup>
                ) : null}
                <RepoMonitorPanel
                  key={memberKey(monitorMember)}
                  environmentId={monitorMember.environmentId}
                  projectId={monitorMember.projectId}
                  onOpenThread={({ environmentId, threadId }) => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId },
                    });
                  }}
                />
              </div>
            )
          ) : null}

          {activeTab === "import" ? (
            <UnifiedImportWizard
              environmentId={props.environmentId}
              initialMetaProjectId={metaProject.id}
              availableMetaProjects={[{ id: metaProject.id, title: metaProject.title }]}
              onImported={() => rollupQuery.refresh()}
            />
          ) : null}
        </section>
      </div>

      <MetaProjectDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        environmentId={props.environmentId}
        initialMetaProject={metaProject}
        initialAppearance={appearance}
        onAppearanceChange={(_id, next) => setAppearance(next)}
      />
    </div>
  );
}
