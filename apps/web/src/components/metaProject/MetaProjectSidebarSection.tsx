import { useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import type { EnvironmentId, MetaProjectId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  MetaProjectHierarchyTree,
  MetaProjectRepositoryNode,
  MetaProjectThreadNode,
  MetaProjectTreeNode,
  UncategorizedRepositoryNode,
} from "@t3tools/shared/metaProjectTree.core";
import { T, useGT } from "gt-react";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderGit2Icon,
  LayersIcon,
  MessageSquareIcon,
  PencilIcon,
  PinIcon,
  PlusIcon,
} from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import {
  computeProjectDropAssignment,
  DEFAULT_SIDEBAR_META_PROJECT_EXPANSION,
  filterMetaProjectTree,
  formatEnvironmentBadgeLabel,
  isMetaProjectExpanded,
  makeMetaProjectDropId,
  makeSidebarProjectDragId,
  parseMetaProjectDropId,
  parseSidebarProjectDragPayload,
  summarizeMetaProjectCounts,
  toggleMetaProjectExpanded,
  toggleUncategorizedExpanded,
  type SidebarMetaProjectExpansionState,
  type SidebarProjectDragPayload,
  type SidebarProjectDropAssignment,
} from "../../sidebarMetaProject.logic";
import { useMetaProjectTree } from "../../state/metaProjects";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel } from "../ui/collapsible";
import type { MetaProjectAppearancePreference } from "./MetaProjectDialog";

export interface MetaProjectSidebarSectionProps {
  readonly environmentId: EnvironmentId | null;
  readonly activeMetaProjectId?: string | null | undefined;
  readonly activeThreadId?: ThreadId | null | undefined;
  readonly searchQuery?: string | undefined;
  readonly appearances?: Readonly<Record<string, MetaProjectAppearancePreference>> | undefined;
  readonly onOpenMetaProject?: (metaProjectId: MetaProjectId) => void;
  readonly onCreateMetaProject?: () => void;
  readonly onEditMetaProject?: (metaProjectId: MetaProjectId) => void;
  readonly onSelectThread?: (ref: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly threadId: ThreadId;
  }) => void;
  readonly onSelectRepository?: (ref: {
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }) => void;
}

export function resolveMetaProjectDragEndAssignment(
  event: DragEndEvent,
  tree: MetaProjectHierarchyTree,
): SidebarProjectDropAssignment | null {
  if (event.over === null) return null;
  const targetMetaProjectId = parseMetaProjectDropId(event.over.id);
  if (targetMetaProjectId === null) return null;
  const payload = parseSidebarProjectDragPayload(event.active.data.current);
  if (payload === null) return null;
  const targetMetaProject = tree.metaProjects.find(
    (mp) => mp.metaProjectId === targetMetaProjectId,
  );
  if (targetMetaProject === undefined) return null;
  return computeProjectDropAssignment(payload, targetMetaProject);
}

function SidebarMetaProjectThreadRow(props: {
  readonly thread: MetaProjectThreadNode;
  readonly active: boolean;
  readonly onSelectThread?: MetaProjectSidebarSectionProps["onSelectThread"];
}) {
  const gt = useGT();
  const envLabel = formatEnvironmentBadgeLabel(props.thread.environmentBadge, {
    localLabel: gt("Local"),
    offlineSuffix: gt("offline"),
  });

  return (
    <button
      type="button"
      data-sidebar-row={`meta-thread:${props.thread.environmentId}:${props.thread.threadId}`}
      onClick={() =>
        props.onSelectThread?.({
          environmentId: props.thread.environmentId,
          projectId: props.thread.projectId,
          threadId: props.thread.threadId,
        })
      }
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent/60",
        props.active && "bg-accent text-accent-foreground",
      )}
    >
      {props.thread.role === "pm" ? (
        <BotIcon className="size-3.5 shrink-0 text-primary" />
      ) : (
        <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {props.thread.title}
      </span>
      <Badge variant={props.thread.role === "pm" ? "info" : "secondary"} size="sm">
        {props.thread.role === "pm" ? gt("PM") : gt("Cross")}
      </Badge>
      <span className="max-w-16 shrink-0 truncate text-xs text-muted-foreground">{envLabel}</span>
    </button>
  );
}

function DraggableRepositoryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly role?: string | undefined;
  readonly environmentBadge: MetaProjectRepositoryNode["environmentBadge"];
  readonly sourceMetaProjectId: string | null;
  readonly missing?: boolean | undefined;
  readonly onSelectRepository?: MetaProjectSidebarSectionProps["onSelectRepository"];
}) {
  const gt = useGT();
  const dragData: SidebarProjectDragPayload = {
    kind: "physical_project",
    environmentId: props.environmentId,
    projectId: props.projectId,
    sourceMetaProjectId: props.sourceMetaProjectId,
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: makeSidebarProjectDragId(props.environmentId, props.projectId),
    data: dragData,
  });

  const envLabel = formatEnvironmentBadgeLabel(props.environmentBadge, {
    localLabel: gt("Local"),
    offlineSuffix: gt("offline"),
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={cn(
        "flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors hover:bg-accent/60",
        isDragging && "opacity-50",
      )}
    >
      <button
        type="button"
        data-sidebar-row={`meta-repo:${props.environmentId}:${props.projectId}`}
        onClick={() =>
          props.onSelectRepository?.({
            environmentId: props.environmentId,
            projectId: props.projectId,
          })
        }
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
      >
        <FolderGit2Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground">{props.title}</span>
      </button>

      {props.role !== undefined ? (
        <Badge variant="outline" size="sm">
          {props.role}
        </Badge>
      ) : null}

      {props.missing ? (
        <Badge variant="warning" size="sm">
          {gt("Missing")}
        </Badge>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <EnvironmentMachineIcon
            kind={props.environmentBadge.isLocal ? "laptop" : "server"}
            className="size-3"
          />
          <span className="max-w-16 truncate">{envLabel}</span>
        </span>
      )}
    </div>
  );
}

function MetaProjectNodeRow(props: {
  readonly node: MetaProjectTreeNode;
  readonly expanded: boolean;
  readonly active: boolean;
  readonly activeThreadId?: ThreadId | null | undefined;
  readonly appearance?: MetaProjectAppearancePreference | undefined;
  readonly onToggle: () => void;
  readonly onOpenMetaProject?: MetaProjectSidebarSectionProps["onOpenMetaProject"];
  readonly onEditMetaProject?: MetaProjectSidebarSectionProps["onEditMetaProject"];
  readonly onSelectThread?: MetaProjectSidebarSectionProps["onSelectThread"];
  readonly onSelectRepository?: MetaProjectSidebarSectionProps["onSelectRepository"];
}) {
  const gt = useGT();
  const { setNodeRef, isOver } = useDroppable({
    id: makeMetaProjectDropId(props.node.metaProjectId),
    data: {
      kind: "meta_project",
      metaProjectId: props.node.metaProjectId,
    },
  });

  const metaId = props.node.metaProjectId as MetaProjectId;

  return (
    <Collapsible open={props.expanded} onOpenChange={props.onToggle}>
      <div
        ref={setNodeRef}
        className={cn(
          "group flex items-center gap-1 rounded-lg px-1.5 py-1 transition-colors",
          props.active ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
          isOver && "ring-2 ring-primary bg-primary/10",
        )}
      >
        <Button
          size="icon-tiny"
          variant="ghost"
          aria-label={props.expanded ? gt("Collapse workspace") : gt("Expand workspace")}
          onClick={props.onToggle}
        >
          {props.expanded ? (
            <ChevronDownIcon className="size-3.5" />
          ) : (
            <ChevronRightIcon className="size-3.5" />
          )}
        </Button>

        <button
          type="button"
          data-sidebar-row={`meta-project:${props.node.metaProjectId}`}
          onClick={() => props.onOpenMetaProject?.(metaId)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium"
        >
          <Badge variant={props.appearance?.color ?? "secondary"} size="sm">
            <LayersIcon className="size-3" />
          </Badge>
          <span className="min-w-0 flex-1 truncate text-foreground">{props.node.title}</span>
          {props.node.pinned ? <PinIcon className="size-3 shrink-0 text-muted-foreground" /> : null}
          <span className="shrink-0 text-xs text-muted-foreground">
            {props.node.repositories.length}
          </span>
        </button>

        {props.onEditMetaProject !== undefined ? (
          <span className="opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button
              size="icon-tiny"
              variant="ghost"
              aria-label={gt("Edit Meta-Project")}
              onClick={() => props.onEditMetaProject?.(metaId)}
            >
              <PencilIcon className="size-3" />
            </Button>
          </span>
        ) : null}
      </div>

      <CollapsiblePanel>
        <div className="ml-4 space-y-1 border-l border-border/70 pl-2 pt-1 pb-1.5">
          {props.node.pmThreads.map((thread) => (
            <SidebarMetaProjectThreadRow
              key={`${thread.environmentId}:${thread.threadId}`}
              thread={thread}
              active={props.activeThreadId === thread.threadId}
              onSelectThread={props.onSelectThread}
            />
          ))}

          {props.node.crossCuttingThreads.map((thread) => (
            <SidebarMetaProjectThreadRow
              key={`${thread.environmentId}:${thread.threadId}`}
              thread={thread}
              active={props.activeThreadId === thread.threadId}
              onSelectThread={props.onSelectThread}
            />
          ))}

          {props.node.repositories.length === 0 ? (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              <T>Drag a repository here to group it.</T>
            </p>
          ) : (
            props.node.repositories.map((repo) => (
              <DraggableRepositoryRow
                key={`${repo.environmentId}:${repo.projectId}`}
                environmentId={repo.environmentId}
                projectId={repo.projectId}
                title={repo.title}
                role={repo.role}
                environmentBadge={repo.environmentBadge}
                sourceMetaProjectId={props.node.metaProjectId}
                missing={repo.missing}
                onSelectRepository={props.onSelectRepository}
              />
            ))
          )}
        </div>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function MetaProjectSidebarSection(props: MetaProjectSidebarSectionProps) {
  const gt = useGT();
  const treeQuery = useMetaProjectTree(props.environmentId);
  const [expansion, setExpansion] = useState<SidebarMetaProjectExpansionState>(
    DEFAULT_SIDEBAR_META_PROJECT_EXPANSION,
  );

  const rawTree: MetaProjectHierarchyTree = treeQuery.data ?? {
    metaProjects: [],
    uncategorizedRepositories: [],
  };
  const visibleTree = filterMetaProjectTree(rawTree, props.searchQuery ?? "");
  const counts = summarizeMetaProjectCounts(visibleTree);

  return (
    <section aria-label={gt("Meta-Projects")} className="space-y-2">
      <div className="flex items-center justify-between px-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <T>Workspaces</T>
        </span>
        <Button
          size="icon-tiny"
          variant="ghost"
          aria-label={gt("Create Meta-Project")}
          onClick={props.onCreateMetaProject}
        >
          <PlusIcon className="size-3.5" />
        </Button>
      </div>

      {treeQuery.isPending && treeQuery.data === null ? (
        <p className="px-2 py-1 text-xs text-muted-foreground">
          <T>Loading workspaces...</T>
        </p>
      ) : null}

      {visibleTree.metaProjects.length === 0 && !treeQuery.isPending ? (
        <div className="rounded-lg border border-dashed border-border px-2.5 py-2 text-xs text-muted-foreground">
          <p>
            <T>No workspaces yet.</T>
          </p>
          {props.onCreateMetaProject !== undefined ? (
            <Button size="xs" variant="ghost" className="mt-1" onClick={props.onCreateMetaProject}>
              <PlusIcon className="size-3" />
              <T>New Workspace</T>
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1">
          {visibleTree.metaProjects.map((node) => (
            <MetaProjectNodeRow
              key={node.metaProjectId}
              node={node}
              expanded={isMetaProjectExpanded(expansion, node.metaProjectId)}
              active={props.activeMetaProjectId === node.metaProjectId}
              activeThreadId={props.activeThreadId}
              appearance={props.appearances?.[node.metaProjectId]}
              onToggle={() =>
                setExpansion((prev) => toggleMetaProjectExpanded(prev, node.metaProjectId))
              }
              onOpenMetaProject={props.onOpenMetaProject}
              onEditMetaProject={props.onEditMetaProject}
              onSelectThread={props.onSelectThread}
              onSelectRepository={props.onSelectRepository}
            />
          ))}
        </div>
      )}

      {visibleTree.uncategorizedRepositories.length > 0 ? (
        <Collapsible
          open={expansion.uncategorizedExpanded}
          onOpenChange={() => setExpansion((prev) => toggleUncategorizedExpanded(prev))}
        >
          <button
            type="button"
            onClick={() => setExpansion((prev) => toggleUncategorizedExpanded(prev))}
            className="flex w-full items-center justify-between rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          >
            <span className="inline-flex items-center gap-1.5">
              {expansion.uncategorizedExpanded ? (
                <ChevronDownIcon className="size-3.5" />
              ) : (
                <ChevronRightIcon className="size-3.5" />
              )}
              <T>Uncategorized Repositories</T>
            </span>
            <span>{counts.uncategorizedRepositoryCount}</span>
          </button>
          <CollapsiblePanel>
            <div className="space-y-0.5 pl-2 pt-1">
              {visibleTree.uncategorizedRepositories.map((repo: UncategorizedRepositoryNode) => (
                <DraggableRepositoryRow
                  key={`${repo.environmentId}:${repo.projectId}`}
                  environmentId={repo.environmentId}
                  projectId={repo.projectId}
                  title={repo.title}
                  environmentBadge={repo.environmentBadge}
                  sourceMetaProjectId={null}
                  onSelectRepository={props.onSelectRepository}
                />
              ))}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </section>
  );
}
