import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  META_PROJECT_STANDARD_ROLES,
  type EnvironmentId,
  type MetaProject,
  type MetaProjectId,
  type MetaProjectMember,
  type MetaProjectRole,
  type MetaProjectStandardRole,
  type ProjectId,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { BoxIcon, Code2Icon, CpuIcon, GlobeIcon, LayersIcon, SmartphoneIcon } from "lucide-react";
import { type FormEvent, useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { metaProjectEnvironment } from "../../state/metaProjects";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription } from "../ui/alert";
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
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

export type MetaProjectIconName = "layers" | "cpu" | "globe" | "box" | "code" | "smartphone";
export type MetaProjectColorToken =
  | "default"
  | "info"
  | "success"
  | "warning"
  | "error"
  | "secondary";

export interface MetaProjectAppearancePreference {
  readonly icon: MetaProjectIconName;
  readonly color: MetaProjectColorToken;
}

export interface MetaProjectDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly initialMetaProject?: MetaProject | null | undefined;
  readonly initialAppearance?: MetaProjectAppearancePreference | undefined;
  readonly onAppearanceChange?: (
    metaProjectId: MetaProjectId,
    appearance: MetaProjectAppearancePreference,
  ) => void;
  readonly onSaved?: (metaProject: MetaProject) => void;
}

interface MemberSelectionDraft {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly selected: boolean;
  readonly role: MetaProjectRole;
}

const ICON_OPTIONS: ReadonlyArray<MetaProjectIconName> = [
  "layers",
  "cpu",
  "globe",
  "box",
  "code",
  "smartphone",
];

const COLOR_OPTIONS: ReadonlyArray<MetaProjectColorToken> = [
  "default",
  "info",
  "success",
  "warning",
  "error",
  "secondary",
];

function renderMetaProjectIcon(icon: MetaProjectIconName) {
  switch (icon) {
    case "layers":
      return <LayersIcon className="size-3.5" />;
    case "cpu":
      return <CpuIcon className="size-3.5" />;
    case "globe":
      return <GlobeIcon className="size-3.5" />;
    case "box":
      return <BoxIcon className="size-3.5" />;
    case "code":
      return <Code2Icon className="size-3.5" />;
    case "smartphone":
      return <SmartphoneIcon className="size-3.5" />;
  }
}

function memberKey(environmentId: EnvironmentId, projectId: ProjectId): string {
  return `${environmentId}\u0000${projectId}`;
}

function buildInitialMemberDrafts(
  availableProjects: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly id: ProjectId;
  }>,
  existingMembers: ReadonlyArray<MetaProjectMember>,
): ReadonlyArray<MemberSelectionDraft> {
  const byKey = new Map<string, MemberSelectionDraft>();

  for (const project of availableProjects) {
    byKey.set(memberKey(project.environmentId, project.id), {
      environmentId: project.environmentId,
      projectId: project.id,
      selected: false,
      role: "other",
    });
  }

  for (const member of existingMembers) {
    byKey.set(memberKey(member.environmentId, member.projectId), {
      environmentId: member.environmentId,
      projectId: member.projectId,
      selected: true,
      role: member.role,
    });
  }

  return [...byKey.values()];
}

function roleLabel(role: MetaProjectRole, gt: ReturnType<typeof useGT>): string {
  switch (role) {
    case "frontend":
      return gt("Frontend");
    case "backend":
      return gt("Backend");
    case "infra":
      return gt("Infra");
    case "docs":
      return gt("Docs");
    case "mobile":
      return gt("Mobile");
    case "shared":
      return gt("Shared");
    case "other":
      return gt("Other");
    default:
      return role;
  }
}

function colorLabel(color: MetaProjectColorToken, gt: ReturnType<typeof useGT>): string {
  switch (color) {
    case "default":
      return gt("Primary");
    case "info":
      return gt("Info");
    case "success":
      return gt("Success");
    case "warning":
      return gt("Warning");
    case "error":
      return gt("Alert");
    case "secondary":
      return gt("Neutral");
  }
}

function iconLabel(icon: MetaProjectIconName, gt: ReturnType<typeof useGT>): string {
  switch (icon) {
    case "layers":
      return gt("Layers");
    case "cpu":
      return gt("Compute");
    case "globe":
      return gt("Web");
    case "box":
      return gt("Package");
    case "code":
      return gt("Code");
    case "smartphone":
      return gt("Mobile");
  }
}

function MetaProjectDialogForm(props: {
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId | null;
  readonly initialMetaProject: MetaProject | null;
  readonly initialAppearance: MetaProjectAppearancePreference;
  readonly onAppearanceChange?: (
    metaProjectId: MetaProjectId,
    appearance: MetaProjectAppearancePreference,
  ) => void;
  readonly onSaved?: (metaProject: MetaProject) => void;
}) {
  const gt = useGT();
  const { environments } = useEnvironments();
  const projects = useProjects();

  const createMetaProject = useAtomCommand(metaProjectEnvironment.create, {
    reportFailure: false,
  });
  const updateMetaProject = useAtomCommand(metaProjectEnvironment.update, {
    reportFailure: false,
  });
  const addMember = useAtomCommand(metaProjectEnvironment.addMember, {
    reportFailure: false,
  });
  const removeMember = useAtomCommand(metaProjectEnvironment.removeMember, {
    reportFailure: false,
  });

  const isEditing = props.initialMetaProject !== null;
  const visibleProjects = projects.filter((project) => !project.isScratch);

  const [title, setTitle] = useState(props.initialMetaProject?.title ?? "");
  const [description, setDescription] = useState(props.initialMetaProject?.description ?? "");
  const [instructionsMd, setInstructionsMd] = useState(
    props.initialMetaProject?.instructionsMd ?? "",
  );
  const [icon, setIcon] = useState<MetaProjectIconName>(props.initialAppearance.icon);
  const [color, setColor] = useState<MetaProjectColorToken>(props.initialAppearance.color);
  const [memberDrafts, setMemberDrafts] = useState<ReadonlyArray<MemberSelectionDraft>>(() =>
    buildInitialMemberDrafts(visibleProjects, props.initialMetaProject?.members ?? []),
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const envLabelById = new Map<EnvironmentId, string>(
    environments.map((env) => [env.environmentId, env.label] as const),
  );
  const projectByKey = new Map(
    visibleProjects.map(
      (project) => [memberKey(project.environmentId, project.id), project] as const,
    ),
  );

  const toggleMember = (environmentId: EnvironmentId, projectId: ProjectId, selected: boolean) => {
    setMemberDrafts((prev) =>
      prev.map((draft) =>
        draft.environmentId === environmentId && draft.projectId === projectId
          ? { ...draft, selected }
          : draft,
      ),
    );
  };

  const updateMemberRole = (
    environmentId: EnvironmentId,
    projectId: ProjectId,
    role: MetaProjectRole,
  ) => {
    setMemberDrafts((prev) =>
      prev.map((draft) =>
        draft.environmentId === environmentId && draft.projectId === projectId
          ? { ...draft, role, selected: true }
          : draft,
      ),
    );
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (props.environmentId === null) {
      setFormError(gt("No connected hub environment is available."));
      return;
    }

    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) {
      setFormError(gt("Meta-project name is required."));
      return;
    }

    setFormError(null);
    setSubmitting(true);

    const trimmedDescription = description.trim();
    const selectedMembers = memberDrafts.filter((draft) => draft.selected);

    if (props.initialMetaProject === null) {
      const members: MetaProjectMember[] = selectedMembers.map((draft, index) => {
        const project = projectByKey.get(memberKey(draft.environmentId, draft.projectId));
        return {
          environmentId: draft.environmentId,
          projectId: draft.projectId,
          role: draft.role,
          ...(project ? { label: project.title } : {}),
          sortOrder: index,
        };
      });

      const createResult = await createMetaProject({
        environmentId: props.environmentId,
        input: {
          title: trimmedTitle,
          description: trimmedDescription.length > 0 ? trimmedDescription : null,
          instructionsMd,
          members,
        },
      });

      setSubmitting(false);
      if (createResult._tag === "Failure") {
        const squashed = squashAtomCommandFailure(createResult);
        setFormError(
          squashed instanceof Error ? squashed.message : gt("Failed to create meta-project."),
        );
        return;
      }

      const saved = createResult.value.metaProject;
      props.onAppearanceChange?.(saved.id, { icon, color });
      props.onSaved?.(saved);
      toastManager.add({
        type: "success",
        title: gt("Meta-project created"),
        description: saved.title,
      });
      props.onOpenChange(false);
      return;
    }

    const existing = props.initialMetaProject;
    const updateResult = await updateMetaProject({
      environmentId: props.environmentId,
      input: {
        metaProjectId: existing.id,
        title: trimmedTitle,
        description: trimmedDescription.length > 0 ? trimmedDescription : null,
        instructionsMd,
      },
    });

    if (updateResult._tag === "Failure") {
      setSubmitting(false);
      const squashed = squashAtomCommandFailure(updateResult);
      setFormError(
        squashed instanceof Error ? squashed.message : gt("Failed to update meta-project."),
      );
      return;
    }

    let latestMetaProject = updateResult.value.metaProject;
    const existingByKey = new Map(
      existing.members.map(
        (member) => [memberKey(member.environmentId, member.projectId), member] as const,
      ),
    );
    const selectedByKey = new Map(
      selectedMembers.map(
        (draft) => [memberKey(draft.environmentId, draft.projectId), draft] as const,
      ),
    );

    for (const member of existing.members) {
      const key = memberKey(member.environmentId, member.projectId);
      const next = selectedByKey.get(key);
      if (next === undefined || next.role !== member.role) {
        const removeRes = await removeMember({
          environmentId: props.environmentId,
          input: {
            metaProjectId: existing.id,
            environmentId: member.environmentId,
            projectId: member.projectId,
          },
        });
        if (removeRes._tag === "Failure") {
          setSubmitting(false);
          const squashed = squashAtomCommandFailure(removeRes);
          setFormError(
            squashed instanceof Error
              ? squashed.message
              : gt("Failed to update repository memberships."),
          );
          return;
        }
        latestMetaProject = removeRes.value.metaProject;
      }
    }

    for (const [index, draft] of selectedMembers.entries()) {
      const key = memberKey(draft.environmentId, draft.projectId);
      const prev = existingByKey.get(key);
      if (prev === undefined || prev.role !== draft.role) {
        const project = projectByKey.get(key);
        const addRes = await addMember({
          environmentId: props.environmentId,
          input: {
            metaProjectId: existing.id,
            member: {
              environmentId: draft.environmentId,
              projectId: draft.projectId,
              role: draft.role,
              ...(project ? { label: project.title } : {}),
              sortOrder: index,
            },
          },
        });
        if (addRes._tag === "Failure") {
          setSubmitting(false);
          const squashed = squashAtomCommandFailure(addRes);
          setFormError(
            squashed instanceof Error
              ? squashed.message
              : gt("Failed to add repository membership."),
          );
          return;
        }
        latestMetaProject = addRes.value.metaProject;
      }
    }

    setSubmitting(false);
    props.onAppearanceChange?.(latestMetaProject.id, { icon, color });
    props.onSaved?.(latestMetaProject);
    toastManager.add({
      type: "success",
      title: gt("Meta-project updated"),
      description: latestMetaProject.title,
    });
    props.onOpenChange(false);
  };

  return (
    <form onSubmit={(event) => void handleSubmit(event)} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>
          <span className="flex items-center gap-2">
            <Badge variant={color} size="sm">
              {renderMetaProjectIcon(icon)}
            </Badge>
            <span>{isEditing ? gt("Edit Meta-Project") : gt("Create Meta-Project")}</span>
          </span>
        </DialogTitle>
        <DialogDescription>
          <T>
            Group repositories across environments under one shared handbook and PM coordination
            workspace.
          </T>
        </DialogDescription>
      </DialogHeader>

      <DialogPanel>
        {formError !== null ? (
          <Alert variant="error">
            <AlertDescription>{formError}</AlertDescription>
          </Alert>
        ) : null}

        <div className="space-y-1.5">
          <Label htmlFor="meta-project-title">{gt("Name")}</Label>
          <Input
            id="meta-project-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={gt("e.g. Acme Core Platform")}
            disabled={submitting}
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="meta-project-description">{gt("Description")}</Label>
          <Input
            id="meta-project-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={gt("Short summary of how these repositories work together")}
            disabled={submitting}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>{gt("Icon")}</Label>
            <Select
              value={icon}
              onValueChange={(value) => {
                if (value !== null) setIcon(value as MetaProjectIconName);
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue>
                  <span className="inline-flex items-center gap-1.5">
                    {renderMetaProjectIcon(icon)}
                    <span>{iconLabel(icon, gt)}</span>
                  </span>
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {ICON_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    <span className="inline-flex items-center gap-1.5">
                      {renderMetaProjectIcon(option)}
                      <span>{iconLabel(option, gt)}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{gt("Badge tone")}</Label>
            <Select
              value={color}
              onValueChange={(value) => {
                if (value !== null) setColor(value as MetaProjectColorToken);
              }}
            >
              <SelectTrigger size="sm">
                <SelectValue>{colorLabel(color, gt)}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {COLOR_OPTIONS.map((option) => (
                  <SelectItem key={option} value={option}>
                    {colorLabel(option, gt)}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="meta-project-instructions">{gt("Shared Instructions (Markdown)")}</Label>
          <Textarea
            id="meta-project-instructions"
            rows={5}
            value={instructionsMd}
            onChange={(event) => setInstructionsMd(event.target.value)}
            placeholder={gt(
              "# Architecture Rules\n- Keep contracts in packages/contracts synchronized before editing clients.",
            )}
            disabled={submitting}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <Label>{gt("Member Repositories")}</Label>
            <span className="text-xs text-muted-foreground">
              {gt("{count} selected", {
                count: memberDrafts.filter((draft) => draft.selected).length,
              })}
            </span>
          </div>

          {memberDrafts.length === 0 ? (
            <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <T>No physical repositories are registered in connected environments yet.</T>
            </p>
          ) : (
            <div className="max-h-56 space-y-2 overflow-y-auto rounded-lg border border-border p-2">
              {memberDrafts.map((draft) => {
                const project = projectByKey.get(memberKey(draft.environmentId, draft.projectId));
                const envLabel = envLabelById.get(draft.environmentId) ?? draft.environmentId;
                const displayTitle = project?.title ?? draft.projectId;
                return (
                  <div
                    key={memberKey(draft.environmentId, draft.projectId)}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-card px-2.5 py-2"
                  >
                    <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                      <Checkbox
                        checked={draft.selected}
                        disabled={submitting}
                        onCheckedChange={(checked) =>
                          toggleMember(draft.environmentId, draft.projectId, Boolean(checked))
                        }
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {displayTitle}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {envLabel}
                          {project ? ` · ${project.workspaceRoot}` : ""}
                        </span>
                      </span>
                    </label>

                    <Select
                      value={draft.role}
                      disabled={submitting}
                      onValueChange={(value) => {
                        if (value !== null) {
                          updateMemberRole(
                            draft.environmentId,
                            draft.projectId,
                            value as MetaProjectStandardRole,
                          );
                        }
                      }}
                    >
                      <SelectTrigger size="xs" className="w-28 shrink-0">
                        <SelectValue>{roleLabel(draft.role, gt)}</SelectValue>
                      </SelectTrigger>
                      <SelectPopup>
                        {META_PROJECT_STANDARD_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>
                            {roleLabel(role, gt)}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogPanel>

      <DialogFooter>
        <DialogClose render={<Button variant="outline" disabled={submitting} />}>
          <T>Cancel</T>
        </DialogClose>
        <Button type="submit" disabled={submitting || props.environmentId === null}>
          {submitting
            ? gt("Saving...")
            : isEditing
              ? gt("Save Changes")
              : gt("Create Meta-Project")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function MetaProjectDialog(props: MetaProjectDialogProps) {
  const formKey = `${props.initialMetaProject?.id ?? "new"}-${props.open ? "open" : "closed"}`;
  const appearance: MetaProjectAppearancePreference = props.initialAppearance ?? {
    icon: "layers",
    color: "default",
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-xl">
        <MetaProjectDialogForm
          key={formKey}
          onOpenChange={props.onOpenChange}
          environmentId={props.environmentId}
          initialMetaProject={props.initialMetaProject ?? null}
          initialAppearance={appearance}
          {...(props.onAppearanceChange === undefined
            ? {}
            : { onAppearanceChange: props.onAppearanceChange })}
          {...(props.onSaved === undefined ? {} : { onSaved: props.onSaved })}
        />
      </DialogPopup>
    </Dialog>
  );
}
